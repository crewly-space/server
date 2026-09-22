/**
 * One run at a time per agent.
 *
 * A second message to an agent that is already answering waits its turn
 * instead of racing the first -- which is what makes "queued" a real state
 * rather than a label. Runs that another run started (delegation, handoff)
 * do not queue: the run that started them is waiting on them, so making them
 * wait for it would deadlock.
 */
export class AgentRunQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depth = new Map<string, number>();

  isBusy(agentId: string): boolean {
    return (this.depth.get(agentId) ?? 0) > 0;
  }

  /** Waits for the agent's earlier runs; resolves with the function that lets the next one in. */
  async enter(agentId: string): Promise<() => void> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(agentId, tail);
    this.depth.set(agentId, (this.depth.get(agentId) ?? 0) + 1);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.depth.get(agentId) ?? 1) - 1;
      if (remaining === 0) {
        this.depth.delete(agentId);
        if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
      } else {
        this.depth.set(agentId, remaining);
      }
      release();
    };
  }
}
