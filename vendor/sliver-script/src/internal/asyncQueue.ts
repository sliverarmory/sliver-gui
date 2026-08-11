export interface AsyncQueueOptions<T> {
  readonly maxItems: number;
  readonly maxWeight: number;
  readonly weight: (item: T) => number;
  readonly overflowError: () => Error;
  readonly dispose?: (item: T) => void;
  readonly onConsumerCancel?: () => void;
}

/**
 * A single-consumer async queue with explicit item and byte-equivalent caps.
 *
 * The queue intentionally has no unbounded defaults. Stream owners must pick a
 * reviewed budget for every use instead of silently inheriting an allocation.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private pending: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  } | null = null;

  private queuedWeight = 0;
  private closed = false;
  private failure: unknown | null = null;

  constructor(private readonly options: AsyncQueueOptions<T>) {
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
      throw new Error("AsyncQueue maxItems must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxWeight) || options.maxWeight < 1) {
      throw new Error("AsyncQueue maxWeight must be a positive safe integer");
    }
  }

  /** Returns false after atomically failing the queue on overflow. */
  push(item: T): boolean {
    if (this.closed) return false;

    const weight = this.itemWeight(item);
    const waiter = this.pending;
    if (waiter) {
      this.pending = null;
      waiter.resolve({ value: item, done: false });
      return true;
    }

    if (this.queue.length >= this.options.maxItems || this.queuedWeight + weight > this.options.maxWeight) {
      this.options.dispose?.(item);
      this.fail(this.options.overflowError());
      return false;
    }

    this.queue.push(item);
    this.queuedWeight += weight;
    return true;
  }

  /** Closes after already-buffered items have been consumed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.queue.length === 0 && this.pending) {
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  /** Fails immediately and securely disposes every buffered item. */
  fail(err: unknown): void {
    if (this.closed && this.failure === null) return;
    if (this.failure !== null) return;

    this.failure = err;
    this.closed = true;
    this.disposeQueuedItems();
    if (this.pending) {
      const waiter = this.pending;
      this.pending = null;
      waiter.reject(err);
    }
  }

  /** Cancels immediately without exposing buffered data to a future consumer. */
  cancel(): void {
    if (this.closed && this.queue.length === 0) return;
    this.closed = true;
    this.disposeQueuedItems();
    if (this.pending) {
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  get bufferedItems(): number {
    return this.queue.length;
  }

  get bufferedWeight(): number {
    return this.queuedWeight;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.cancel();
        this.options.onConsumerCancel?.();
        return { value: undefined as never, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }

    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queuedWeight -= this.itemWeight(item);
      return Promise.resolve({ value: item, done: false });
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }

    if (this.pending) {
      return Promise.reject(new Error("AsyncQueue supports one pending consumer read"));
    }

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private itemWeight(item: T): number {
    const weight = this.options.weight(item);
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > this.options.maxWeight) {
      throw new Error("AsyncQueue item has an invalid weight");
    }
    return weight;
  }

  private disposeQueuedItems(): void {
    for (const item of this.queue.splice(0, this.queue.length)) {
      this.options.dispose?.(item);
    }
    this.queuedWeight = 0;
  }
}
