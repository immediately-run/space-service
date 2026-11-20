// queue.ts — the Node host's only concurrency control (STORE_PORTABILITY_SPEC §5.5.1). A Durable
// Object's input gate runs one event at a time per object; here every request, socket event and
// wake-up for a space runs through that space's queue, in arrival order. Each space has its own,
// so two spaces never wait on each other.

/** Runs its callers one at a time, in the order they asked. */
export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  /** Wait for the queue, then hold it until `fn` settles. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.waiting++;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => void this.waiting--,
      () => void this.waiting--,
    );
    return result;
  }

  /** Nothing holds the queue and nothing waits for it. */
  get idle(): boolean {
    return this.waiting === 0;
  }
}

/** One queue per space, made on first use and dropped when it empties. */
export class SpaceQueues {
  private readonly queues = new Map<string, RequestQueue>();

  run<T>(spaceId: string, fn: () => Promise<T> | T): Promise<T> {
    let queue = this.queues.get(spaceId);
    if (!queue) this.queues.set(spaceId, (queue = new RequestQueue()));
    const q = queue;
    const result = q.run(fn);
    const drop = () => {
      if (q.idle && this.queues.get(spaceId) === q) this.queues.delete(spaceId);
    };
    result.then(drop, drop);
    return result;
  }

  /** How many spaces have work queued or running. */
  get size(): number {
    return this.queues.size;
  }
}
