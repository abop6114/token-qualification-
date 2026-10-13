import { isDeepStrictEqual } from "node:util";
import { normalizeSolanaTokenBalanceFlowEvidence } from "./solanaTokenBalanceFlowEvidence";
import { decodeSolanaTokenProgramInstructionEvidence } from "./solanaTokenProgramInstructionEvidence";
import { normalizeSolanaReferenceReconciliation } from "./solanaReferenceReconciliation";
import { validateSolanaHistoricalTransactionSelection } from "./solanaHistoricalTransactionSelector";
import type {
  IntegrateSolanaTransactionEvidenceInput,
  SolanaTransactionEvidenceIntegrationCandidate,
  SolanaTransactionEvidenceIntegrationCoverage,
  SolanaTransactionEvidenceIntegrationEvidence,
  SolanaTransactionEvidenceIntegrationInputErrorReason,
} from "../types/solanaTransactionEvidenceIntegration";
import { SOLANA_TRANSACTION_EVIDENCE_INTEGRATION_SCHEMA_VERSION } from "../types/solanaTransactionEvidenceIntegration";
import type { SolanaTransactionEnrichmentCandidateResult } from "../types/solanaTransactionEnrichment";
import type { SolanaTransactionEvidence } from "../types/solanaTransactionEvidence";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integrationError(
  reason: SolanaTransactionEvidenceIntegrationInputErrorReason,
  message: string,
): never {
  throw new SolanaTransactionEvidenceIntegrationInputError(reason, message);
}

export class SolanaTransactionEvidenceIntegrationInputError extends Error {
  constructor(
    readonly reason: SolanaTransactionEvidenceIntegrationInputErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "SolanaTransactionEvidenceIntegrationInputError";
  }
}

function hasValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateProvenance(candidate: RecordValue, signature: string): void {
  const acquisition = candidate.acquisition;
  if (!isRecord(acquisition) || !isRecord(acquisition.provenance)) {
    integrationError("candidate_mismatch", "Selected Phase 2A candidate has malformed request provenance.");
  }
  const provenance = acquisition.provenance;
  if (provenance.chain !== "solana" || provenance.provider !== "helius" ||
    provenance.method !== "getTransaction" || provenance.encoding !== "json" ||
    provenance.commitment !== "finalized" || provenance.maxSupportedTransactionVersion !== 0 ||
    provenance.requestedSignature !== signature || !hasValidTimestamp(provenance.fetchedAt)) {
    integrationError("candidate_mismatch", "Selected Phase 2A request provenance does not match its signature.");
  }
}

function validateCandidateOutcome(
  candidate: unknown,
  selected: boolean,
  expectedSignature: string,
  expectedSelectionPosition: number | null,
): { eligible: boolean; transaction: SolanaTransactionEvidence | null } {
  if (!isRecord(candidate) || candidate.signature !== expectedSignature || !isRecord(candidate.disposition) ||
    !isRecord(candidate.acquisition) || !isRecord(candidate.normalization)) {
    integrationError("candidate_mismatch", "Phase 2A enrichment candidate is malformed or misaligned with its selection.");
  }

  if (!selected) {
    if (candidate.disposition.status !== "not_selected" || candidate.disposition.reason !== "signature_cap" ||
      candidate.acquisition.status !== "not_attempted" || candidate.normalization.status !== "not_attempted") {
      integrationError("candidate_mismatch", "Not-selected Phase 2A candidate has an impossible outcome combination.");
    }
    return { eligible: false, transaction: null };
  }

  const selectionPosition = candidate.disposition.selectionPosition;
  if (candidate.disposition.status !== "selected" || typeof selectionPosition !== "number" ||
    !Number.isSafeInteger(selectionPosition) || selectionPosition < 0 || selectionPosition >= 5 ||
    expectedSelectionPosition === null || selectionPosition !== expectedSelectionPosition) {
    integrationError("candidate_mismatch", "Selected Phase 2A candidate has an invalid selection position.");
  }

  const acquisitionStatus = candidate.acquisition.status;
  const normalizationStatus = candidate.normalization.status;
  if (acquisitionStatus === "returned") {
    validateProvenance(candidate, expectedSignature);
    if (normalizationStatus === "available") {
      const normalization = candidate.normalization;
      if (!isRecord(normalization.transaction) || !Array.isArray(normalization.transaction.signatures) ||
        normalization.transaction.signatures[0] !== expectedSignature) {
        integrationError("candidate_mismatch", "Available normalized transaction does not match its Phase 2A signature.");
      }
      return { eligible: true, transaction: normalization.transaction as unknown as SolanaTransactionEvidence };
    }
    if (normalizationStatus === "unsupported_transaction_version" || normalizationStatus === "malformed_structure" ||
      normalizationStatus === "source_link_mismatch") {
      return { eligible: false, transaction: null };
    }
    integrationError("candidate_mismatch", "Returned Phase 2A response has an impossible normalization state.");
  }

  if (acquisitionStatus === "provider_result_null") {
    validateProvenance(candidate, expectedSignature);
    if (normalizationStatus !== "not_applicable") {
      integrationError("candidate_mismatch", "Null Phase 2A result must have not-applicable normalization.");
    }
    return { eligible: false, transaction: null };
  }

  if (acquisitionStatus === "request_timeout") {
    validateProvenance(candidate, expectedSignature);
    if (normalizationStatus !== "not_attempted" || !isRecord(candidate.acquisition.error) ||
      candidate.acquisition.error.category !== "request_timeout" || typeof candidate.acquisition.error.message !== "string") {
      integrationError("candidate_mismatch", "Timed-out Phase 2A result has an impossible outcome combination.");
    }
    return { eligible: false, transaction: null };
  }

  if (acquisitionStatus === "provider_error") {
    validateProvenance(candidate, expectedSignature);
    const error = candidate.acquisition.error;
    if (normalizationStatus !== "not_attempted" || !isRecord(error) ||
      !["configuration", "transport", "http", "rpc"].includes(String(error.category)) ||
      typeof error.message !== "string" ||
      (error.httpStatus !== null && !Number.isSafeInteger(error.httpStatus)) ||
      (error.rpcCode !== null && !Number.isSafeInteger(error.rpcCode))) {
      integrationError("candidate_mismatch", "Provider-error Phase 2A result has an impossible outcome combination.");
    }
    return { eligible: false, transaction: null };
  }

  if (acquisitionStatus === "malformed_response") {
    validateProvenance(candidate, expectedSignature);
    if (normalizationStatus !== "not_attempted" || typeof candidate.acquisition.message !== "string") {
      integrationError("candidate_mismatch", "Malformed Phase 2A response has an impossible outcome combination.");
    }
    return { eligible: false, transaction: null };
  }

  integrationError("candidate_mismatch", "Selected Phase 2A candidate has an unsupported acquisition state.");
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validatePhase2A(input: IntegrateSolanaTransactionEvidenceInput): void {
  const phase2A: unknown = input.phase2A;
  if (!isRecord(phase2A) || !isRecord(phase2A.selection) || !isRecord(phase2A.evidence) || !isRecord(phase2A.telemetry)) {
    integrationError("malformed_input", "Phase 2A execution result is malformed.");
  }

  try {
    validateSolanaHistoricalTransactionSelection(
      phase2A.selection as never,
      input.plan,
      input.historicalEvidence,
    );
  } catch {
    integrationError("selection_mismatch", "Phase 2A selection does not match the supplied validated source artifacts.");
  }

  const selection = phase2A.selection;
  const evidence = phase2A.evidence;
  const selectedUniqueSignatureCount = selection.selectedUniqueSignatureCount;
  if (evidence.schemaVersion !== "solana-bounded-transaction-enrichment-v1" || evidence.chain !== "solana" ||
    evidence.mintAddress !== selection.mintAddress || evidence.sourceFingerprint !== selection.sourceFingerprint ||
    evidence.selectionCompleteness !== "complete" ||
    !Array.isArray(selection.candidates) || !Array.isArray(evidence.candidates) ||
    evidence.candidates.length !== selection.candidates.length ||
    selection.uniqueSignatureCount !== selection.candidates.length ||
    typeof selectedUniqueSignatureCount !== "number" || !Number.isSafeInteger(selectedUniqueSignatureCount) ||
    selectedUniqueSignatureCount > 5 || selection.signatureCap !== 5 ||
    selection.mintAddress !== input.plan.mintAddress || selection.candidates.length > input.plan.maximumReturnedRecords) {
    integrationError("malformed_input", "Phase 2A evidence metadata or configured candidate bounds are inconsistent.");
  }

  const seen = new Set<string>();
  let selectedCount = 0;
  let attemptedCount = 0;
  let returnedCount = 0;
  let nullCount = 0;
  let providerErrorCount = 0;
  let timeoutCount = 0;
  let malformedResponseCount = 0;
  let normalizedCount = 0;
  let partialStructuralCount = 0;
  let configurationFailureCount = 0;

  for (let index = 0; index < selection.candidates.length; index += 1) {
    const selectedCandidate: unknown = selection.candidates[index];
    const resultCandidate: unknown = evidence.candidates[index];
    if (!isRecord(selectedCandidate) || typeof selectedCandidate.signature !== "string" ||
      !isRecord(selectedCandidate.disposition) || !Array.isArray(selectedCandidate.sourceObservations) ||
      seen.has(selectedCandidate.signature) || !isRecord(resultCandidate) ||
      resultCandidate.signature !== selectedCandidate.signature ||
      !isDeepStrictEqual(resultCandidate.disposition, selectedCandidate.disposition) ||
      !isDeepStrictEqual(resultCandidate.sourceObservations, selectedCandidate.sourceObservations)) {
      integrationError("candidate_mismatch", "Phase 2A candidate order, identity, disposition, or source observations are inconsistent.");
    }
    seen.add(selectedCandidate.signature);
    const isSelected = selectedCandidate.disposition.status === "selected";
    const expectedSelectionPosition = isSelected ? selectedCount : null;
    if (isSelected) {
      selectedCount += 1;
      attemptedCount += 1;
    }
    const outcome = validateCandidateOutcome(
      resultCandidate,
      isSelected,
      selectedCandidate.signature,
      expectedSelectionPosition,
    );
    if (outcome.eligible) normalizedCount += 1;

    const acquisition = resultCandidate.acquisition as RecordValue;
    if (acquisition.status === "returned") returnedCount += 1;
    else if (acquisition.status === "provider_result_null") nullCount += 1;
    else if (acquisition.status === "provider_error") {
      providerErrorCount += 1;
      if (isRecord(acquisition.error) && acquisition.error.category === "configuration") configurationFailureCount += 1;
    } else if (acquisition.status === "request_timeout") timeoutCount += 1;
    else if (acquisition.status === "malformed_response") malformedResponseCount += 1;

    if (outcome.eligible && outcome.transaction?.structuralCompleteness === "partial") partialStructuralCount += 1;
  }

  if (selectedCount !== selectedUniqueSignatureCount || selectedCount > 5) {
    integrationError("candidate_mismatch", "Phase 2A selected-signature count exceeds or disagrees with the five-signature cap.");
  }

  const telemetry = phase2A.telemetry;
  const countPairs: Array<[string, number]> = [
    ["selectedUniqueSignatureCount", selectedCount],
    ["attemptedSignatureCount", attemptedCount],
    ["returnedTransactionCount", returnedCount],
    ["providerNullCount", nullCount],
    ["providerErrorCount", providerErrorCount],
    ["requestTimeoutCount", timeoutCount],
    ["malformedResponseCount", malformedResponseCount],
    ["normalizedTransactionCount", normalizedCount],
    ["partialStructuralTransactionCount", partialStructuralCount],
    ["requestCount", selectedCount - configurationFailureCount],
  ];
  if (countPairs.some(([field, expected]) => telemetry[field] !== expected) ||
    countPairs.some(([field]) => !isNonnegativeSafeInteger(telemetry[field])) ||
    typeof telemetry.elapsedMs !== "number" || !Number.isFinite(telemetry.elapsedMs) || telemetry.elapsedMs < 0) {
    integrationError("telemetry_mismatch", "Phase 2A telemetry does not reconcile with its candidate outcomes.");
  }

  const selectedNormalizationFailure = evidence.candidates.some((candidate: unknown) => isRecord(candidate) &&
    isRecord(candidate.disposition) && candidate.disposition.status === "selected" &&
    isRecord(candidate.acquisition) && candidate.acquisition.status === "returned" &&
    isRecord(candidate.normalization) && candidate.normalization.status !== "available");
  const expectedExecutionCompleteness = selectedCount === 0 ? "not_applicable"
    : providerErrorCount + timeoutCount + malformedResponseCount > 0 || selectedNormalizationFailure ? "partial" : "complete";
  if (evidence.executionCompleteness !== expectedExecutionCompleteness) {
    integrationError("malformed_input", "Phase 2A execution completeness contradicts its candidate outcomes.");
  }
}

function summarizeCoverage(
  candidates: SolanaTransactionEvidenceIntegrationCandidate[],
): SolanaTransactionEvidenceIntegrationCoverage {
  const candidateCount = candidates.length;
  const eligibleCount = candidates.filter((candidate) => candidate.status === "integrated").length;
  const ineligibleCount = candidateCount - eligibleCount;
  const candidateStatus = candidateCount === 0 ? "no_candidates"
    : eligibleCount === 0 ? "none_eligible"
      : ineligibleCount > 0 ? "some_eligible" : "all_eligible";

  const coverageCounts = { completeCount: 0, partialCount: 0, unavailableCount: 0, conflictingCount: 0 };
  for (const candidate of candidates) {
    if (candidate.status !== "integrated") continue;
    switch (candidate.reconciliation.coverage.status) {
      case "complete_for_supplied_evidence": coverageCounts.completeCount += 1; break;
      case "partial": coverageCounts.partialCount += 1; break;
      case "unavailable": coverageCounts.unavailableCount += 1; break;
      case "conflicting": coverageCounts.conflictingCount += 1; break;
    }
  }
  const integratedCount = eligibleCount;
  const downstreamStatus = integratedCount === 0 ? "not_applicable"
    : coverageCounts.conflictingCount > 0 ? "conflicting"
      : coverageCounts.partialCount > 0 ? "partial"
        : coverageCounts.unavailableCount > 0 ? "unavailable"
          : "complete_for_integrated_candidates";

  return {
    candidateSet: { status: candidateStatus, candidateCount, eligibleCount, ineligibleCount },
    downstream: { status: downstreamStatus, ...coverageCounts },
  };
}

/**
 * Composes already-acquired Phase 2A results with deterministic Phase 2B–2D
 * normalizers. It performs no provider calls and does not infer economic effects.
 */
export function integrateSolanaTransactionEvidence(
  input: IntegrateSolanaTransactionEvidenceInput,
): SolanaTransactionEvidenceIntegrationEvidence {
  if (!isRecord(input) || !isRecord(input.phase2A) || !isRecord(input.plan) || !isRecord(input.historicalEvidence)) {
    integrationError("malformed_input", "Solana transaction integration input is malformed.");
  }
  validatePhase2A(input);

  const phase2A = input.phase2A;
  const candidates: SolanaTransactionEvidenceIntegrationCandidate[] = [];
  let selectedPosition = 0;
  for (let index = 0; index < phase2A.evidence.candidates.length; index += 1) {
    const candidate = phase2A.evidence.candidates[index];
    const selected = phase2A.selection.candidates[index].disposition.status === "selected";
    const expectedSelectionPosition = selected ? selectedPosition : null;
    if (selected) selectedPosition += 1;
    const outcome = validateCandidateOutcome(
      candidate,
      selected,
      phase2A.selection.candidates[index].signature,
      expectedSelectionPosition,
    );
    if (!outcome.eligible || !outcome.transaction) {
      candidates.push({ candidateIndex: index, signature: candidate.signature, status: "not_eligible" });
      continue;
    }

    if (candidate.acquisition.status !== "returned") {
      integrationError("candidate_mismatch", "Eligible candidate does not retain a returned Phase 2A request.");
    }
    const balanceFlow = normalizeSolanaTokenBalanceFlowEvidence(outcome.transaction, {
      selection: phase2A.selection,
      transactionRequest: candidate.acquisition.provenance,
    });
    const instructionEvidence = decodeSolanaTokenProgramInstructionEvidence(outcome.transaction);
    const reconciliation = normalizeSolanaReferenceReconciliation(balanceFlow, instructionEvidence);
    candidates.push({ candidateIndex: index, signature: candidate.signature, status: "integrated",
      balanceFlow, instructionEvidence, reconciliation });
  }

  return {
    schemaVersion: SOLANA_TRANSACTION_EVIDENCE_INTEGRATION_SCHEMA_VERSION,
    chain: "solana",
    phase2A: input.phase2A,
    candidates,
    coverage: summarizeCoverage(candidates),
  };
}
