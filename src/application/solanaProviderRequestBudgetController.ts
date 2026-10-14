import {
  SolanaProviderRequestBudgetError,
} from "../types/solanaProviderRequestBudget";
import type {
  SolanaProviderRequestBudgetController,
  SolanaProviderRequestBudgetControllerOptions,
  SolanaProviderRequestBudgetLease,
  SolanaProviderRequestBudgetLeaseStatus,
  SolanaProviderRequestBudgetStatus,
} from "../types/solanaProviderRequestBudget";

function validateOptions(value: unknown): SolanaProviderRequestBudgetControllerOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Provider request budget configuration is invalid.");
  }

  const options = value as Partial<SolanaProviderRequestBudgetControllerOptions>;
  if (!Number.isSafeInteger(options.capacity) || options.capacity! <= 0) {
    throw new TypeError("capacity must be a positive safe integer.");
  }
  if (typeof options.initiallyEnabled !== "boolean") {
    throw new TypeError("initiallyEnabled must be explicitly configured as a boolean.");
  }

  return { capacity: options.capacity!, initiallyEnabled: options.initiallyEnabled };
}

function validatePositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/**
 * Creates an isolated in-memory allowance ledger. One unit represents one
 * attempted built-in provider fetch invocation; this does not measure credits,
 * cost, or provider receipt. No timer, persistence, or replenishment is used.
 */
export function createSolanaProviderRequestBudgetController(
  input: SolanaProviderRequestBudgetControllerOptions,
): SolanaProviderRequestBudgetController {
  const options = validateOptions(input);
  const capacity = options.capacity;
  let enabled = options.initiallyEnabled;
  let available = capacity;
  let reservedUnused = 0;
  let consumed = 0;

  function ensureInvariant(): void {
    const counters = [available, reservedUnused, consumed];
    if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)
      || BigInt(available) + BigInt(reservedUnused) + BigInt(consumed) !== BigInt(capacity)) {
      throw new SolanaProviderRequestBudgetError("internal_operational_failure");
    }
  }

  function getStatus(): SolanaProviderRequestBudgetStatus {
    ensureInvariant();
    return Object.freeze({ enabled, capacity, available, reservedUnused, consumed });
  }

  function createLease(allowance: number): SolanaProviderRequestBudgetLease {
    let leaseReservedUnused = allowance;
    let leaseConsumed = 0;
    let settled = false;

    function leaseStatus(): SolanaProviderRequestBudgetLeaseStatus {
      ensureInvariant();
      return Object.freeze({
        allowance,
        reservedUnused: leaseReservedUnused,
        consumed: leaseConsumed,
        settled,
      });
    }

    return Object.freeze({
      consume(): void {
        ensureInvariant();
        if (settled) throw new SolanaProviderRequestBudgetError("lease_settled");
        if (leaseReservedUnused === 0) throw new SolanaProviderRequestBudgetError("lease_exhausted");
        if (reservedUnused === 0 || consumed >= capacity) {
          throw new SolanaProviderRequestBudgetError("internal_operational_failure");
        }

        // All bounds are checked before this synchronous, indivisible transition.
        reservedUnused -= 1;
        consumed += 1;
        leaseReservedUnused -= 1;
        leaseConsumed += 1;
        ensureInvariant();
      },

      settle(): void {
        ensureInvariant();
        if (settled) return;
        const nextAvailable = available + leaseReservedUnused;
        if (!Number.isSafeInteger(nextAvailable) || nextAvailable > capacity
          || reservedUnused < leaseReservedUnused) {
          throw new SolanaProviderRequestBudgetError("internal_operational_failure");
        }

        available = nextAvailable;
        reservedUnused -= leaseReservedUnused;
        leaseReservedUnused = 0;
        settled = true;
        ensureInvariant();
      },

      getStatus: leaseStatus,
    });
  }

  return Object.freeze({
    reserve(units: number): SolanaProviderRequestBudgetLease {
      validatePositiveSafeInteger(units, "units");
      ensureInvariant();
      if (!enabled) throw new SolanaProviderRequestBudgetError("controller_disabled");
      if (available < units) throw new SolanaProviderRequestBudgetError("insufficient_allowance");

      const nextReserved = reservedUnused + units;
      if (!Number.isSafeInteger(nextReserved)) {
        throw new SolanaProviderRequestBudgetError("internal_operational_failure");
      }
      available -= units;
      reservedUnused = nextReserved;
      ensureInvariant();
      return createLease(units);
    },

    setEnabled(nextEnabled: boolean): void {
      if (typeof nextEnabled !== "boolean") {
        throw new TypeError("Provider request budget enabled state must be a boolean.");
      }
      enabled = nextEnabled;
    },

    getStatus,
  });
}
