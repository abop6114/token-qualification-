import {
  SolanaTokenEvidenceAdmissionError,
} from "./solanaTokenEvidencePublicExecution";
import type {
  SolanaTokenEvidenceAdmissionPermit,
  SolanaTokenEvidenceAdmissionPolicy,
} from "../types/solanaTokenEvidencePublicExecution";
import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";
import { SolanaExecutionCancelledError, throwIfSolanaExecutionCancelled } from "../types/solanaTrustedExecutionContext";
import type { SolanaTrustedExecutionContext } from "../types/solanaTrustedExecutionContext";

export type SolanaTokenEvidenceAdmissionControllerRejectionReason =
  | "capacity_exhausted"
  | "admission_disabled";

export interface SolanaTokenEvidenceAdmissionControllerOptions {
  maxConcurrentExecutions: number;
  initiallyEnabled: boolean;
}

export interface SolanaTokenEvidenceAdmissionControllerStatus {
  readonly enabled: boolean;
  readonly activePermitCount: number;
  readonly maxConcurrentExecutions: number;
  readonly remainingCapacity: number;
}

export interface SolanaTokenEvidenceAdmissionController extends SolanaTokenEvidenceAdmissionPolicy {
  /** Controls new admissions only; existing permits remain valid. */
  setEnabled(enabled: boolean): void;
  /** Returns a fresh immutable point-in-time status snapshot. */
  getStatus(): SolanaTokenEvidenceAdmissionControllerStatus;
}

/**
 * Controller-specific reason carried by the existing generic admission rejection.
 * Its message and admission_rejected category remain transport-neutral and safe.
 */
export class SolanaTokenEvidenceAdmissionControllerRejectionError extends SolanaTokenEvidenceAdmissionError {
  constructor(readonly reason: SolanaTokenEvidenceAdmissionControllerRejectionReason) {
    super("admission_rejected");
    this.name = "SolanaTokenEvidenceAdmissionControllerRejectionError";
  }
}

function validateOptions(value: unknown): SolanaTokenEvidenceAdmissionControllerOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Admission controller configuration is invalid.");
  }

  const options = value as Partial<SolanaTokenEvidenceAdmissionControllerOptions>;
  if (!Number.isSafeInteger(options.maxConcurrentExecutions) || options.maxConcurrentExecutions! <= 0) {
    throw new TypeError("maxConcurrentExecutions must be a positive safe integer.");
  }
  if (typeof options.initiallyEnabled !== "boolean") {
    throw new TypeError("initiallyEnabled must be explicitly configured as a boolean.");
  }

  return {
    maxConcurrentExecutions: options.maxConcurrentExecutions!,
    initiallyEnabled: options.initiallyEnabled,
  };
}

/** Creates one immediate-decision, in-memory admission controller instance. */
export function createSolanaTokenEvidenceAdmissionController(
  input: SolanaTokenEvidenceAdmissionControllerOptions,
): SolanaTokenEvidenceAdmissionController {
  const options = validateOptions(input);
  let enabled = options.initiallyEnabled;
  let activePermitCount = 0;

  const createPermit = (): SolanaTokenEvidenceAdmissionPermit => {
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        // A permit can only be created after a matching reservation. The guard
        // keeps the public invariant intact even if this closure is misused.
        if (activePermitCount > 0) activePermitCount -= 1;
      },
    };
  };

  return {
    acquire(
      _request: GenerateSolanaTokenEvidenceReportRequest,
      context?: SolanaTrustedExecutionContext,
    ): Promise<SolanaTokenEvidenceAdmissionPermit> {
      try {
        throwIfSolanaExecutionCancelled(context);
        if (!enabled) {
          throw new SolanaTokenEvidenceAdmissionControllerRejectionError("admission_disabled");
        }
        if (activePermitCount >= options.maxConcurrentExecutions) {
          throw new SolanaTokenEvidenceAdmissionControllerRejectionError("capacity_exhausted");
        }

        const permit = createPermit();
        const granted = Promise.resolve(permit);
        // No await or other asynchronous work occurs between the check and reservation.
        activePermitCount += 1;
        return granted;
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },

    setEnabled(nextEnabled: boolean): void {
      if (typeof nextEnabled !== "boolean") {
        throw new TypeError("Admission controller enabled state must be a boolean.");
      }
      enabled = nextEnabled;
    },

    getStatus(): SolanaTokenEvidenceAdmissionControllerStatus {
      return Object.freeze({
        enabled,
        activePermitCount,
        maxConcurrentExecutions: options.maxConcurrentExecutions,
        remainingCapacity: options.maxConcurrentExecutions - activePermitCount,
      });
    },
  };
}
