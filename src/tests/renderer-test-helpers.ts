import { afterAll, beforeAll } from "vitest";

/** Opt in only when a suite does not drive observer callbacks itself. */
export function useRendererTestEnvironment({ animations = true, pointerCapture = false }: {
  readonly animations?: boolean;
  readonly pointerCapture?: boolean;
} = {}): void {
  const restore: (() => void)[] = [];
  const replace = (target: object, property: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    Object.defineProperty(target, property, { configurable: true, writable: true, value });
    restore.push(() => {
      if (descriptor) Object.defineProperty(target, property, descriptor);
      else Reflect.deleteProperty(target, property);
    });
  };

  beforeAll(() => {
    replace(globalThis, "ResizeObserver", class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const elementPrototype = (globalThis as typeof globalThis & { Element: { prototype: object } }).Element.prototype;
    if (animations) replace(elementPrototype, "getAnimations", () => []);
    if (pointerCapture) {
      replace(elementPrototype, "setPointerCapture", () => undefined);
      replace(elementPrototype, "releasePointerCapture", () => undefined);
    }
  });
  afterAll(() => {
    for (const reset of restore.reverse()) reset();
  });
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
