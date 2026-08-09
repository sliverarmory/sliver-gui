export async function withTimeoutSignal<T>(
  timeoutSeconds: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!(timeoutSeconds > 0)) {
    return fn(new AbortController().signal);
  }

  const controller = new AbortController();
  const timeoutMs = Math.floor(timeoutSeconds * 1000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

