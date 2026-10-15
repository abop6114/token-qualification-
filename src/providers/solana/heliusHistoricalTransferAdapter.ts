import {
  getHeliusTransferPage,
  HeliusTransferProviderError,
  type GetHeliusTransferPageInput,
  type HeliusTransferPage,
} from "./heliusTransfersByAddress";
import type { SolanaProviderRequestObservationContext } from "../providerRequestObservation";
import { SolanaExecutionCancelledError } from "../../types/solanaTrustedExecutionContext";
import { createSolanaRequestAbortScope } from "./solanaRequestAbortScope";
import {
  SolanaProviderRequestBudgetError,
  TRUSTED_LEGACY_PROVIDER_DISPATCH,
  type SolanaProviderDispatchCapability,
} from "../../types/solanaProviderRequestBudget";

const MAX_TIMEOUT_MS = 2_147_483_647;
export const HELIUS_HISTORICAL_TRANSFER_PAGE_LIMIT = 100;

export type HeliusHistoricalTransferPageFetcher = (
  input: GetHeliusTransferPageInput,
  timeoutMs: number,
  observationContext?: SolanaProviderRequestObservationContext,
  signal?: AbortSignal,
) => Promise<HeliusTransferPage>;

/**
 * Production-facing, timeout-bounded page adapter. The continuation token is
 * returned only to its in-memory caller and must never be serialized or logged.
 */
export async function getHeliusHistoricalTransferPage(
  input: GetHeliusTransferPageInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  observationContext?: SolanaProviderRequestObservationContext,
  callerSignal?: AbortSignal,
  dispatchCapability: SolanaProviderDispatchCapability = TRUSTED_LEGACY_PROVIDER_DISPATCH,
): Promise<HeliusTransferPage> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Helius request timeout must be a positive integer within the supported timer range.");
  }

  if (callerSignal?.aborted) throw new SolanaExecutionCancelledError();
  const scope = createSolanaRequestAbortScope(timeoutMs, callerSignal);
  let requestInvoked = false;
  const timeoutBoundFetch: typeof fetch = async (request, init) => {
    if (scope.cause === "caller_cancelled") throw new SolanaExecutionCancelledError(false);
    requestInvoked = true;
    try {
      return await fetchImpl(request, { ...init, signal: scope.signal });
    } catch (error: unknown) {
      if (scope.isCallerAbort(error)) throw new SolanaExecutionCancelledError(true);
      throw error;
    }
  };

  try {
    return await getHeliusTransferPage(
      input,
      timeoutBoundFetch,
      observationContext,
      () => scope.cause === "request_timeout",
      (error) => scope.isCallerAbort(error),
      () => scope.cause === "caller_cancelled",
      dispatchCapability,
    );
  } catch (error: unknown) {
    if (error instanceof SolanaExecutionCancelledError || error instanceof SolanaProviderRequestBudgetError) throw error;
    if (scope.cause === "caller_cancelled" && scope.isCallerAbort(error)) {
      throw new SolanaExecutionCancelledError(requestInvoked);
    }
    if (scope.cause === "request_timeout") {
      throw new HeliusTransferProviderError("transport", "Helius transfer-history request timed out.");
    }
    if (error instanceof HeliusTransferProviderError) throw error;
    throw new HeliusTransferProviderError("transport", "Helius transfer-history request failed.");
  } finally {
    scope.dispose();
  }
}
