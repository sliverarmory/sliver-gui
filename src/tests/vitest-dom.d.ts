import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// jest-dom's Vitest declarations still target the pre-v5 Assertion interface.
// Matchers preserves Vitest 5's void/Promise<void> assertion return types.
declare module "vitest" {
  interface Matchers<R extends void | Promise<void>, T>
    extends TestingLibraryMatchers<{ asymmetricMatch(received: T): boolean }, R> {}
}
