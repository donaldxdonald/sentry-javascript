import type { ReplayRecordingData } from '@sentry/types';

import { REPLAY_MAX_EVENT_BUFFER_SIZE } from '../constants';
import type { AddEventResult, EventBuffer, EventBufferType, RecordingEvent } from '../types';
import { timestampToMs } from '../util/timestampToMs';
import { EventBufferSizeExceededError } from './error';
import { WorkerHandler } from './WorkerHandler';

/**
 * Event buffer that uses a web worker to compress events.
 * Exported only for testing.
 */
export class EventBufferCompressionWorker implements EventBuffer {
  private _worker: WorkerHandler;
  private _earliestTimestamp: number | null;
  private _totalSize = 0;

  public constructor(worker: Worker) {
    this._worker = new WorkerHandler(worker);
    this._earliestTimestamp = null;
  }

  /** @inheritdoc */
  public get hasEvents(): boolean {
    return !!this._earliestTimestamp;
  }

  /** @inheritdoc */
  public get type(): EventBufferType {
    return 'worker';
  }

  /**
   * Ensure the worker is ready (or not).
   * This will either resolve when the worker is ready, or reject if an error occured.
   */
  public ensureReady(): Promise<void> {
    return this._worker.ensureReady();
  }

  /**
   * Destroy the event buffer.
   */
  public destroy(): void {
    this._worker.destroy();
  }

  /**
   * Add an event to the event buffer.
   *
   * Returns true if event was successfuly received and processed by worker.
   */
  public addEvent(event: RecordingEvent): Promise<AddEventResult> {
    const timestamp = timestampToMs(event.timestamp);
    if (!this._earliestTimestamp || timestamp < this._earliestTimestamp) {
      this._earliestTimestamp = timestamp;
    }

    const data = JSON.stringify(event);
    this._totalSize += data.length;

    if (this._totalSize > REPLAY_MAX_EVENT_BUFFER_SIZE) {
      return Promise.reject(new EventBufferSizeExceededError());
    }

    return this._sendEventToWorker(data);
  }

  /**
   * Finish the event buffer and return the compressed data.
   */
  public finish(): Promise<ReplayRecordingData> {
    return this._finishRequest();
  }

  /** @inheritdoc */
  public clear(): void {
    this._earliestTimestamp = null;
    this._totalSize = 0;
    // We do not wait on this, as we assume the order of messages is consistent for the worker
    void this._worker.postMessage('clear');
  }

  /** @inheritdoc */
  public getEarliestTimestamp(): number | null {
    return this._earliestTimestamp;
  }

  /**
   * Send the event to the worker.
   */
  private _sendEventToWorker(data: string): Promise<AddEventResult> {
    return this._worker.postMessage<void>('addEvent', data);
  }

  /**
   * Finish the request and return the compressed data from the worker.
   */
  private async _finishRequest(): Promise<Uint8Array> {
    const response = await this._worker.postMessage<Uint8Array>('finish');

    this._earliestTimestamp = null;
    this._totalSize = 0;

    return response;
  }
}
