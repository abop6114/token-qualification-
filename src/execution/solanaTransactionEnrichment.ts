import { performance } from "node:perf_hooks";
import { getHeliusTransaction, HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS, HeliusTransactionProviderError } from "../providers/solana/heliusTransaction";
import { normalizeSolanaTransactionEvidence, SolanaTransactionNormalizationError } from "../normalization/solanaTransactionEvidence";
import { resolveSolanaHistoricalTransactionSourceReference, validateSolanaHistoricalTransactionSelection } from "../normalization/solanaHistoricalTransactionSelector";
import type { SolanaBoundedHistoricalSamplingEvidence } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlanVersioned } from "../types/solanaHistoricalQueryPlan";
import type { SolanaHistoricalTransactionSelectionEvidence } from "../types/solanaHistoricalTransactionSelection";
import type { SolanaTransactionRequestProvenance } from "../types/solanaTransactionEvidence";
import type { SolanaTransactionEnrichmentAcquisition, SolanaTransactionEnrichmentExecutionResult, SolanaTransactionEnrichmentCandidateResult } from "../types/solanaTransactionEnrichment";

export interface ExecuteSolanaTransactionEnrichmentOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1_000) / 1_000);
}

function provenance(signature: string, fetchedAt: string): SolanaTransactionRequestProvenance {
  return {
    chain: "solana", provider: "helius", method: "getTransaction", encoding: "json",
    commitment: "finalized", maxSupportedTransactionVersion: 0, requestedSignature: signature, fetchedAt,
  };
}

function safeProviderFailure(error: HeliusTransactionProviderError, source: SolanaTransactionRequestProvenance): SolanaTransactionEnrichmentAcquisition {
  if (error.category === "malformed_response") {
    return { status: "malformed_response", provenance: source, message: "Helius returned a malformed transaction response." };
  }
  if (error.category === "request_timeout") {
    return { status: "request_timeout", provenance: source,
      error: { category: "request_timeout", message: "Helius transaction request timed out." } };
  }
  const category = error.category === "configuration" || error.category === "transport" || error.category === "http" || error.category === "rpc"
    ? error.category : "transport";
  return { status: "provider_error", provenance: source,
    error: {
      category,
      httpStatus: category === "http" && Number.isSafeInteger(error.httpStatus) ? error.httpStatus : null,
      rpcCode: category === "rpc" && Number.isSafeInteger(error.rpcCode) ? error.rpcCode : null,
      message: category === "configuration" ? "Helius transaction configuration is invalid."
        : category === "http" ? "Helius transaction HTTP request failed."
          : category === "rpc" ? "Helius returned a JSON-RPC transaction error."
            : "Helius transaction request failed.",
    } };
}

/** Executes the selected unique signatures sequentially and cross-links every retained transaction to its source observations. */
export async function executeSolanaTransactionEnrichment(
  selection: SolanaHistoricalTransactionSelectionEvidence,
  plan: SolanaHistoricalQueryPlanVersioned,
  historicalEvidence: SolanaBoundedHistoricalSamplingEvidence,
  options: ExecuteSolanaTransactionEnrichmentOptions = {},
): Promise<SolanaTransactionEnrichmentExecutionResult> {
  validateSolanaHistoricalTransactionSelection(selection, plan, historicalEvidence);
  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? HELIUS_TRANSACTION_DEFAULT_TIMEOUT_MS;
  let requestCount = 0;
  let attemptedSignatureCount = 0;
  let returnedTransactionCount = 0;
  let providerNullCount = 0;
  let providerErrorCount = 0;
  let requestTimeoutCount = 0;
  let malformedResponseCount = 0;
  let normalizedTransactionCount = 0;
  let partialStructuralTransactionCount = 0;
  const countedFetch: typeof fetch = async (input, init) => {
    requestCount += 1;
    return fetchImpl(input, init);
  };
  const results: SolanaTransactionEnrichmentCandidateResult[] = [];

  for (const candidate of selection.candidates) {
    if (candidate.disposition.status === "not_selected") {
      results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
        disposition: candidate.disposition, acquisition: { status: "not_attempted" }, normalization: { status: "not_attempted" } });
      continue;
    }
    // Resolve all source references before network execution; a bad link must never cause a request.
    const sourceObservations = candidate.sourceObservations.map((reference) =>
      resolveSolanaHistoricalTransactionSourceReference(reference, candidate.signature, plan, historicalEvidence).observation);
    attemptedSignatureCount += 1;
    const source = provenance(candidate.signature, now().toISOString());
    let acquired: Awaited<ReturnType<typeof getHeliusTransaction>>;
    try {
      acquired = await getHeliusTransaction(candidate.signature, countedFetch, timeoutMs);
    } catch (error: unknown) {
      if (error instanceof HeliusTransactionProviderError) {
        const acquisition = safeProviderFailure(error, source);
        if (acquisition.status === "request_timeout") requestTimeoutCount += 1;
        else if (acquisition.status === "malformed_response") malformedResponseCount += 1;
        else providerErrorCount += 1;
        results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
          disposition: candidate.disposition, acquisition, normalization: { status: "not_attempted" } });
      } else {
        providerErrorCount += 1;
        results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
          disposition: candidate.disposition,
          acquisition: { status: "provider_error", provenance: source,
            error: { category: "transport", httpStatus: null, rpcCode: null, message: "Helius transaction request failed." } },
          normalization: { status: "not_attempted" } });
      }
      continue;
    }
    if (acquired.status === "provider_result_null") {
      providerNullCount += 1;
      results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
        disposition: candidate.disposition, acquisition: { status: "provider_result_null", provenance: source }, normalization: { status: "not_applicable" } });
      continue;
    }
    returnedTransactionCount += 1;
    let transaction;
    try {
      transaction = normalizeSolanaTransactionEvidence(acquired.transaction, candidate.signature);
    } catch (error: unknown) {
      if (error instanceof SolanaTransactionNormalizationError && error.reason === "unsupported_version") {
        results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
          disposition: candidate.disposition, acquisition: { status: "returned", provenance: source }, normalization: { status: "unsupported_transaction_version" } });
      } else {
        results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
          disposition: candidate.disposition, acquisition: { status: "returned", provenance: source }, normalization: { status: "malformed_structure" } });
      }
      continue;
    }

    const transactionBlockTime = transaction.blockTime.status === "available" ? transaction.blockTime.value : null;
    const linked = sourceObservations.every((observation) => {
      if (observation.providerRecord.slot !== transaction.slot.value || transaction.slot.status !== "available") return false;
      return observation.observedTime.status !== "available" || transactionBlockTime === null ||
        observation.observedTime.unixSeconds === transactionBlockTime;
    });
    if (!linked) {
      results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
        disposition: candidate.disposition, acquisition: { status: "returned", provenance: source }, normalization: { status: "source_link_mismatch" } });
      continue;
    }
    normalizedTransactionCount += 1;
    if (transaction.structuralCompleteness === "partial") partialStructuralTransactionCount += 1;
    results.push({ signature: candidate.signature, sourceObservations: candidate.sourceObservations,
      disposition: candidate.disposition, acquisition: { status: "returned", provenance: source }, normalization: { status: "available", transaction } });
  }

  const selectedUniqueSignatureCount = selection.selectedUniqueSignatureCount;
  const failedCount = providerErrorCount + requestTimeoutCount + malformedResponseCount;
  const returnedWithNormalizationFailure = results.some((result) => result.disposition.status === "selected" &&
    result.acquisition.status === "returned" && result.normalization.status !== "available");
  const executionCompleteness = selectedUniqueSignatureCount === 0 ? "not_applicable"
    : failedCount > 0 || returnedWithNormalizationFailure ? "partial" : "complete";
  return {
    selection,
    evidence: {
      schemaVersion: "solana-bounded-transaction-enrichment-v1",
      chain: "solana",
      mintAddress: selection.mintAddress,
      sourceFingerprint: selection.sourceFingerprint,
      selectionCompleteness: selection.selectionCompleteness,
      executionCompleteness,
      candidates: results,
    },
    telemetry: {
      selectedUniqueSignatureCount, attemptedSignatureCount, returnedTransactionCount, providerNullCount,
      providerErrorCount, requestTimeoutCount, malformedResponseCount, normalizedTransactionCount,
      partialStructuralTransactionCount, requestCount, elapsedMs: elapsedMs(started),
    },
  };
}
