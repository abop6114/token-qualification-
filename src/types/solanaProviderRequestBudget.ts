/** Safe, deterministic rejection reasons for the in-memory request budget. */
export type SolanaProviderRequestBudgetRejectionReason =
  | "insufficient_allowance"
  | "controller_disabled"
  | "lease_exhausted"
  | "lease_settled"
  | "internal_operational_failure";

export class SolanaProviderRequestBudgetError extends Error {
  constructor(readonly reason: SolanaProviderRequestBudgetRejectionReason) {
    const messages: Record<SolanaProviderRequestBudgetRejectionReason, string> = {
      insufficient_allowance: "Provider request allowance is insufficient.",
      controller_disabled: "Provider request budget is disabled.",
      lease_exhausted: "Provider request budget lease is exhausted.",
      lease_settled: "Provider request budget lease is settled.",
      internal_operational_failure: "Provider request budget is unavailable.",
    };
    super(messages[reason]);
    this.name = "SolanaProviderRequestBudgetError";
  }
}

export interface SolanaProviderRequestBudgetControllerOptions {
  readonly capacity: number;
  readonly initiallyEnabled: boolean;
}

export interface SolanaProviderRequestBudgetStatus {
  readonly enabled: boolean;
  readonly capacity: number;
  readonly available: number;
  readonly reservedUnused: number;
  readonly consumed: number;
}

export interface SolanaProviderRequestBudgetLeaseStatus {
  readonly allowance: number;
  readonly reservedUnused: number;
  readonly consumed: number;
  readonly settled: boolean;
}

/** A synchronous reservation for attempted provider fetch invocations. */
export interface SolanaProviderRequestBudgetLease {
  /** Permanently consumes one reserved unit; call immediately before dispatch. */
  consume(): void;
  /** Returns only unused units. Repeated settlement is an idempotent no-op. */
  settle(): void;
  /** Returns a fresh immutable point-in-time lease snapshot. */
  getStatus(): SolanaProviderRequestBudgetLeaseStatus;
}

export interface SolanaProviderRequestBudgetController {
  /** Atomically reserves a positive safe-integer allowance or rejects immediately. */
  reserve(units: number): SolanaProviderRequestBudgetLease;
  /** Disabling affects new reservations only. */
  setEnabled(enabled: boolean): void;
  /** Returns a fresh immutable point-in-time snapshot. */
  getStatus(): SolanaProviderRequestBudgetStatus;
}
