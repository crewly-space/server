import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { waitForWorkerReply } from './worker-reply.js';

describe('PostgreSQL worker reply synchronization', () => {
  it('ignores an unrelated wake-up until this request has a completed reply', async () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const flag = new Int32Array(workerData);
      // A notify from the previous reply can arrive after the caller reset
      // the flag for a new request. No reply is available at this wake-up.
      Atomics.notify(flag, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    `, { eval: true, workerData: flag.buffer });
    try {
      waitForWorkerReply(flag, 5000);
      expect(Atomics.load(flag, 0)).toBe(1);
    } finally { await worker.terminate(); }
  });

  it('does not wait again for a reply already marked complete', () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(flag, 0, 1);
    expect(() => waitForWorkerReply(flag, 0)).not.toThrow();
  });

  it('retains a bounded deadline when no reply arrives', () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    expect(() => waitForWorkerReply(flag, 10)).toThrow('PostgreSQL did not answer in time');
  });
});
