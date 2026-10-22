/** A wake-up is only a hint: a delayed notify can belong to the previous request. */
export function waitForWorkerReply(flag: Int32Array, timeoutMs: number): void {
  const deadline = performance.now() + timeoutMs;
  while (Atomics.load(flag, 0) === 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('PostgreSQL did not answer in time');
    Atomics.wait(flag, 0, 0, remaining);
  }
}
