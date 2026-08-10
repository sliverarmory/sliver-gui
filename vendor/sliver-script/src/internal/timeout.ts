const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MAX_PROTOBUF_INT64 = 9_223_372_036_854_775_807n;
// Node.js and browsers clamp larger delays to an implementation-defined short
// timeout. Restrict the public whole-second API so a requested long deadline
// can never fire immediately because of timer overflow.
const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const MAX_TIMER_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_DELAY_MILLISECONDS / 1_000);
const MAX_PROTOBUF_TIMEOUT_SECONDS = Number((MAX_PROTOBUF_INT64 + 1n) / NANOSECONDS_PER_SECOND);
const MAX_TIMEOUT_SECONDS = Math.min(MAX_TIMER_TIMEOUT_SECONDS, MAX_PROTOBUF_TIMEOUT_SECONDS);

/**
 * Convert the public timeout unit to the nanoseconds expected by
 * commonpb.Request.Timeout without passing an imprecise number to protobuf.
 */
export function timeoutSecondsToNanoseconds(timeoutSeconds: number): string {
  const validatedTimeoutSeconds = validateTimeoutSeconds(timeoutSeconds);

  // Match Sliver's canonical Go clients: leave zero unset, and make the
  // server-side deadline expire just before the same whole-second local
  // transport deadline for positive values.
  const timeoutNanoseconds = validatedTimeoutSeconds === 0
    ? 0n
    : (BigInt(validatedTimeoutSeconds) * NANOSECONDS_PER_SECOND) - 1n;
  if (timeoutNanoseconds > MAX_PROTOBUF_INT64) {
    throw new RangeError("Timeout exceeds the protobuf int64 range");
  }

  return timeoutNanoseconds.toString();
}

export async function withTimeoutSignal<T>(
  timeoutSeconds: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const validatedTimeoutSeconds = validateTimeoutSeconds(timeoutSeconds);
  if (validatedTimeoutSeconds === 0) {
    return fn(new AbortController().signal);
  }

  const controller = new AbortController();
  const timeoutMs = validatedTimeoutSeconds * 1_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function validateTimeoutSeconds(timeoutSeconds: number): number {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new RangeError("Timeout must be a non-negative whole number of seconds");
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(`Timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutSeconds;
}
