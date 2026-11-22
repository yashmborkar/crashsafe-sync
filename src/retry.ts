import { AbortSyncError, CheckpointInvalidError, HttpResponseError } from "./errors.js";
import type { RetrySettings } from "./types.js";

export function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof CheckpointInvalidError) return false;
  if (error instanceof HttpResponseError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  // Explicit application opt-in for transient network errors.
  return !!error && typeof error === "object" && "retryable" in error && error.retryable === true;
}

export function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortSyncError();
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(new AbortSyncError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function retryFetch<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
  config: RetrySettings = {},
): Promise<T> {
  const attempts = config.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError("retry.attempts must be >=1");
  const base = config.baseDelayMs ?? 250;
  const max = config.maxDelayMs ?? 5_000;
  if (base < 0 || max < 0 || !Number.isFinite(base) || !Number.isFinite(max)) {
    throw new RangeError("Retry delays must be finite nonnegative numbers");
  }
  for (let attempt = 1; ; attempt++) {
    abortIfNeeded(signal);
    try {
      return await task();
    } catch (error) {
      abortIfNeeded(signal);
      const shouldRetry = !(error instanceof CheckpointInvalidError) &&
        (config.shouldRetry?.(error) ?? defaultShouldRetry(error));
      if (attempt >= attempts || !shouldRetry) throw error;
      const backoff = Math.min(max, base * 2 ** Math.min(attempt - 1, 30));
      const suggested = error instanceof HttpResponseError ? error.retryAfterMs : undefined;
      // Respect upstream Retry-After even when longer than our backoff cap.
      const delay = suggested !== undefined ? Math.max(0, suggested) : backoff;
      await sleep(delay, signal);
    }
  }
}
