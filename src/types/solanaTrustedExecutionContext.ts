/** Trusted application context. This value is never read from public request JSON. */
export interface SolanaTrustedExecutionContext {
  signal?: AbortSignal;
}

/** Cancellation is an operational outcome, not provider failure or token evidence. */
export class SolanaExecutionCancelledError extends Error {
  readonly category = "caller_cancelled" as const;

  constructor(readonly requestAttempted = false) {
    super("The evidence operation was cancelled by its caller.");
    this.name = "SolanaExecutionCancelledError";
  }
}

export function throwIfSolanaExecutionCancelled(context?: SolanaTrustedExecutionContext): void {
  if (context?.signal?.aborted) throw new SolanaExecutionCancelledError();
}
