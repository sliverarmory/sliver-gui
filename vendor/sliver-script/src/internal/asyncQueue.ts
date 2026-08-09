export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly pending: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];

  private closed = false;
  private failure: unknown | null = null;

  push(item: T): void {
    if (this.closed) {
      throw new Error("AsyncQueue is closed");
    }

    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }

    this.queue.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.splice(0, this.pending.length)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.failure = err;
    this.closed = true;
    for (const waiter of this.pending.splice(0, this.pending.length)) {
      waiter.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const item = this.queue.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

