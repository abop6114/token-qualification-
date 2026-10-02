import {
  getHeliusTransferPage,
  HeliusTransferProviderError,
  type GetHeliusTransferPageInput,
  type HeliusTransferPage,
} from "./heliusTransfersByAddress";

const MAX_TIMEOUT_MS = 2_147_483_647;
export const HELIUS_HISTORICAL_TRANSFER_PAGE_LIMIT = 100;

export type HeliusHistoricalTransferPageFetcher = (
  input: GetHeliusTransferPageInput,
  timeoutMs: number,
) => Promise<HeliusTransferPage>;

/**
 * Production-facing, timeout-bounded page adapter. The continuation token is
 * returned only to its in-memory caller and must never be serialized or logged.
 */
export async function getHeliusHistoricalTransferPage(
  input: GetHeliusTransferPageInput,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HeliusTransferPage> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Helius request timeout must be a positive integer within the supported timer range.");
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const timeoutBoundFetch: typeof fetch = (request, init) =>
    fetchImpl(request, { ...init, signal: timeoutSignal });

  try {
    return await getHeliusTransferPage(input, timeoutBoundFetch);
  } catch (error: unknown) {
    if (timeoutSignal.aborted) {
      throw new HeliusTransferProviderError("transport", "Helius transfer-history request timed out.");
    }
    if (error instanceof HeliusTransferProviderError) throw error;
    throw new HeliusTransferProviderError("transport", "Helius transfer-history request failed.");
  }
}
