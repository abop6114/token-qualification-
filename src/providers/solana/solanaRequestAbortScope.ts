export interface SolanaRequestAbortScope {
  signal: AbortSignal;
  get cause(): "caller_cancelled" | "request_timeout" | null;
  isTimedOut(): boolean;
  isCallerAbort(error: unknown): boolean;
  dispose(): void;
}

/**
 * Combines caller cancellation with a local timeout while retaining the first cause.
 * Aborting requests cancellation of the underlying fetch; prompt settlement still
 * depends on that fetch implementation honoring its signal.
 */
export function createSolanaRequestAbortScope(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): SolanaRequestAbortScope {
  const controller = new AbortController();
  let cause: "caller_cancelled" | "request_timeout" | null = null;
  let callerAbortReason: unknown = null;
  const abortForCaller = (): void => {
    if (cause !== null) return;
    cause = "caller_cancelled";
    callerAbortReason = new DOMException("Caller cancelled the request.", "AbortError");
    controller.abort(callerAbortReason);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (callerSignal?.aborted) abortForCaller();
  else {
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
    timer = setTimeout(() => {
      if (cause !== null) return;
      cause = "request_timeout";
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get cause() { return cause; },
    isTimedOut() { return cause === "request_timeout"; },
    isCallerAbort(error: unknown) {
      // An AbortError name alone does not establish that caller cancellation caused it.
      return cause === "caller_cancelled" && error === callerAbortReason;
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}
