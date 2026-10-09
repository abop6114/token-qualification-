import { createHash } from "node:crypto";
import type { SolanaHistoricalAuthorityEvidence, SolanaHistoricalTransferObservation } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlanVersioned } from "../types/solanaHistoricalQueryPlan";
import type {
  SolanaHistoricalTransactionSelectionEvidence,
  SolanaHistoricalTransactionSignatureCandidate,
  SolanaHistoricalTransactionSourceReference,
} from "../types/solanaHistoricalTransactionSelection";
import { calculateSolanaHistoricalDescriptiveMetrics } from "./solanaHistoricalMetrics";
import { validateSolanaHistoricalQueryPlanV2 } from "./solanaHistoricalQueryPlan";
import type { SolanaBoundedHistoricalSamplingEvidence } from "../types/solanaHistoricalSampling";
import { isSolanaPublicKeySyntax, isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";

const DOMAIN = "solana-historical-transaction-source-fingerprint-v1";
const SIGNATURE_CAP = 5 as const;

function candidateRank(plan: SolanaHistoricalQueryPlanVersioned, candidate: SolanaHistoricalQueryPlanVersioned["candidateAuthorities"][number]): { basis: "sourceRank" | "observedCandidateFrameRank"; value: number } {
  if (plan.planVersion === "solana-bounded-history-query-plan-v1" && "sourceRank" in candidate) {
    return { basis: "sourceRank", value: candidate.sourceRank };
  }
  if (plan.planVersion === "solana-bounded-history-query-plan-v2" && "observedCandidateFrameRank" in candidate) {
    return { basis: "observedCandidateFrameRank", value: candidate.observedCandidateFrameRank };
  }
  throw new Error("Historical candidate rank does not match its plan version.");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid historical transaction source: ${message}`);
}

function optional(value: unknown): unknown[] {
  return value === undefined ? ["missing"] : value === null ? ["null"] : ["value", value];
}

function candidateProjection(plan: SolanaHistoricalQueryPlanVersioned): unknown[] {
  return plan.candidateAuthorities.map((candidate) => [
    candidate.authorityAddress,
    candidate.balanceRaw,
    candidateRank(plan, candidate),
    candidate.plannedDisposition.status === "selected"
      ? ["selected", candidate.plannedDisposition.selectionPosition, candidate.plannedDisposition.selectionReason]
      : ["not_selected"],
  ]);
}

function planProjection(plan: SolanaHistoricalQueryPlanVersioned): unknown[] {
  const common = [
    plan.planVersion,
    "solana",
    plan.mintAddress,
    [plan.requestedWindow.fromUnixSecondsInclusive, plan.requestedWindow.toUnixSecondsExclusive],
    plan.maxPagesPerAuthority,
    plan.maxRecordsPerAuthority,
    plan.selectedAuthorityCount,
    plan.maximumProviderRequests,
    plan.maximumReturnedRecords,
    [plan.sourceSelection.selectorVersion, plan.sourceSelection.selectionBasis,
      plan.sourceSelection.configuredMaximumSelectedAuthorityCount],
    candidateProjection(plan),
  ];
  if (plan.planVersion === "solana-bounded-history-query-plan-v1") {
    return ["v1", ...common, [
      plan.sourceHolder.fetchedAt,
      [plan.sourceHolder.enumeration.completeness, plan.sourceHolder.enumeration.slotConsistency,
        plan.sourceHolder.enumeration.pageCount, [...plan.sourceHolder.enumeration.contextSlots]],
      [plan.sourceHolder.amountCoverage.state, plan.sourceHolder.amountCoverage.reason,
        [...plan.sourceHolder.amountCoverage.unsupportedExtensionTypes]],
    ]];
  }
  return ["v2", ...common, [
    plan.sourceHolder.snapshotSchemaVersion,
    plan.sourceHolder.snapshotId,
    [plan.sourceHolder.source.provider, plan.sourceHolder.source.method, plan.sourceHolder.source.commitment],
    plan.sourceHolder.fetchedAt,
    [plan.sourceHolder.acquisition.completeness, plan.sourceHolder.acquisition.stopReason,
      plan.sourceHolder.acquisition.configuredMaxPages, plan.sourceHolder.acquisition.requestedPageSize],
    plan.sourceHolder.candidateFrameCompleteness,
    [plan.sourceHolder.enumeration.completeness, plan.sourceHolder.enumeration.slotConsistency,
      plan.sourceHolder.enumeration.pageCount, [...plan.sourceHolder.enumeration.contextSlots]],
    [plan.sourceHolder.amountCoverage.state, plan.sourceHolder.amountCoverage.reason,
      [...plan.sourceHolder.amountCoverage.unsupportedExtensionTypes]],
  ]];
}

function observationProjection(observation: SolanaHistoricalTransferObservation): unknown[] {
  const record = observation.providerRecord;
  const amount = record.amount;
  return [
    record.signature,
    record.slot,
    observation.observedTime.status === "available"
      ? ["available", observation.observedTime.unixSeconds, observation.observedTime.basis]
      : ["unavailable", observation.observedTime.reason],
    optional(record.type),
    optional(record.fromUserAccount),
    optional(record.toUserAccount),
    optional(record.fromTokenAccount),
    optional(record.toTokenAccount),
    optional(record.mint),
    [amount.rawAmount, amount.exactRawAvailable, amount.exactnessBasis, amount.unavailableReason,
      amount.reportedAmount, amount.reportedAmountType, optional(amount.reportedUiAmount),
      optional(amount.reportedUiAmountType)],
  ];
}

function pageProjection(page: SolanaHistoricalAuthorityEvidence["pages"][number]): unknown[] {
  return [page.pageNumber, page.requestLimit, page.recordCount, page.startRecordIndex,
    page.endRecordIndexExclusive, page.continuationTokenUsed, page.continuationTokenReturned,
    page.firstUsableBlockTime, page.lastUsableBlockTime, page.minimumUsableBlockTime,
    page.maximumUsableBlockTime, page.recordsWithoutUsableBlockTime];
}

function authorityProjection(authority: SolanaHistoricalAuthorityEvidence): unknown[] {
  if (authority.queryStatus === "not_queried") {
    return [authority.authorityAddress, "not_queried", authority.reason, authority.terminalReason,
      authority.paginationStatus, authority.requestCount, [], []];
  }
  return [authority.authorityAddress, authority.queryStatus, authority.paginationStatus,
    authority.terminalReason, authority.requestCount,
    authority.queryStatus === "provider_error" ? authority.providerError.category : null,
    authority.pages.map(pageProjection), authority.observations.map(observationProjection)];
}

function evidenceProjection(evidence: SolanaBoundedHistoricalSamplingEvidence): unknown[] {
  return [
    "solana-bounded-historical-sampling-evidence-v1",
    [evidence.provenance.provider, evidence.provenance.method, evidence.provenance.fetchedAt],
    [evidence.authorityScope.source, evidence.authorityScope.candidateSetCompleteness],
    evidence.authorities.map(authorityProjection),
    [evidence.applicationDerivedEvidence.status, evidence.applicationDerivedEvidence.metrics],
  ];
}

function validateV1Plan(plan: Extract<SolanaHistoricalQueryPlanVersioned, { planVersion: "solana-bounded-history-query-plan-v1" }>): void {
  assert(plan.planVersion === "solana-bounded-history-query-plan-v1" && isSolanaPublicKeySyntax(plan.mintAddress), "unsupported V1 plan or malformed mint");
  const window = plan.requestedWindow;
  assert(Number.isSafeInteger(window.fromUnixSecondsInclusive) && window.fromUnixSecondsInclusive >= 0 &&
    Number.isSafeInteger(window.toUnixSecondsExclusive) && window.toUnixSecondsExclusive > window.fromUnixSecondsInclusive, "malformed requested window");
  assert(Number.isSafeInteger(plan.maxPagesPerAuthority) && plan.maxPagesPerAuthority > 0 &&
    Number.isSafeInteger(plan.maxRecordsPerAuthority) && plan.maxRecordsPerAuthority > 0, "invalid query caps");
  assert(plan.sourceSelection.selectorVersion === "solana-rank-coverage-v1" &&
    plan.sourceSelection.selectionBasis === "balance_descending_evenly_spaced_ranks_nearest_half_up", "invalid V1 selector provenance");
  const count = plan.sourceHolder.candidateAuthorityCount;
  const cap = plan.sourceSelection.configuredMaximumSelectedAuthorityCount;
  assert(Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(cap) && cap > 0 &&
    Array.isArray(plan.candidateAuthorities) && plan.candidateAuthorities.length === count, "invalid V1 candidate frame");
  const selectedCount = Math.min(count, cap);
  assert(plan.selectedAuthorityCount === selectedCount && plan.sourceSelection.selectedAuthorityCount === selectedCount, "inconsistent V1 selected count");
  assert(plan.maximumProviderRequests === Number(BigInt(selectedCount) * BigInt(plan.maxPagesPerAuthority)) &&
    plan.maximumReturnedRecords === Number(BigInt(selectedCount) * BigInt(plan.maxRecordsPerAuthority)), "inconsistent V1 aggregate caps");
  const enumeration = plan.sourceHolder.enumeration;
  const coverage = plan.sourceHolder.amountCoverage;
  assert(enumeration.completeness === "complete" && enumeration.slotConsistency === "not_guaranteed" &&
    Number.isSafeInteger(enumeration.pageCount) && enumeration.pageCount >= 0 && Array.isArray(enumeration.contextSlots) &&
    enumeration.contextSlots.length === enumeration.pageCount && enumeration.contextSlots.every((slot) => Number.isSafeInteger(slot) && slot >= 0), "malformed V1 enumeration provenance");
  assert((coverage.state === "complete" || coverage.state === "partial") && Array.isArray(coverage.unsupportedExtensionTypes) &&
    (coverage.reason === null || coverage.reason === "unsupported_balance_affecting_extension" || coverage.reason === "supply_inconsistency"), "malformed V1 amount coverage");
  if (coverage.state === "complete") assert(coverage.reason === null && coverage.unsupportedExtensionTypes.length === 0, "contradictory V1 complete coverage");
  else assert(coverage.reason !== null, "contradictory V1 partial coverage");
  const seen = new Set<string>();
  let previousBalance: bigint | null = null;
  let previousAddress: string | null = null;
  const expectedSelectedRanks = Array.from({ length: selectedCount }, (_, position) => count <= cap ? position :
    selectedCount === 1 ? 0 : Number((2n * BigInt(position) * BigInt(count - 1) + BigInt(selectedCount - 1)) / (2n * BigInt(selectedCount - 1))));
  for (let index = 0; index < count; index += 1) {
    const candidate = plan.candidateAuthorities[index];
    assert(isSolanaPublicKeySyntax(candidate.authorityAddress) && !seen.has(candidate.authorityAddress) &&
      "sourceRank" in candidate && candidate.sourceRank === index && /^[1-9][0-9]*$/.test(candidate.balanceRaw), "malformed V1 candidate rank");
    const balance = BigInt(candidate.balanceRaw);
    assert(previousBalance === null || balance < previousBalance ||
      (balance === previousBalance && previousAddress !== null && previousAddress < candidate.authorityAddress), "V1 candidate ordering is not canonical");
    const selectedPosition = expectedSelectedRanks.indexOf(index);
    if (selectedPosition >= 0) assert(candidate.plannedDisposition.status === "selected" &&
      candidate.plannedDisposition.selectionPosition === selectedPosition && candidate.plannedDisposition.selectionReason === "rank_position", "invalid V1 selected disposition");
    else assert(candidate.plannedDisposition.status === "not_selected", "invalid V1 not-selected disposition");
    seen.add(candidate.authorityAddress);
    previousBalance = balance;
    previousAddress = candidate.authorityAddress;
  }
}

function sourceFingerprint(plan: SolanaHistoricalQueryPlanVersioned, evidence: SolanaBoundedHistoricalSamplingEvidence): string {
  const projection = JSON.stringify([DOMAIN, planProjection(plan), evidenceProjection(evidence)]);
  return `sha256:${createHash("sha256").update(projection, "utf8").digest("hex")}`;
}

function pageNumberForObservation(authority: SolanaHistoricalAuthorityEvidence, observationIndex: number): number {
  const page = authority.pages.find((item) => observationIndex >= item.startRecordIndex && observationIndex < item.endRecordIndexExclusive);
  return page?.pageNumber ?? 0;
}

export function createSolanaHistoricalTransactionSelection(
  plan: SolanaHistoricalQueryPlanVersioned,
  evidence: SolanaBoundedHistoricalSamplingEvidence,
): SolanaHistoricalTransactionSelectionEvidence {
  if (plan.planVersion === "solana-bounded-history-query-plan-v2") validateSolanaHistoricalQueryPlanV2(plan);
  else validateV1Plan(plan);
  // The existing metrics boundary is the authoritative validator for cross-stage page, amount,
  // mint, query-state, and plan/evidence consistency. Its descriptive result is intentionally unused.
  calculateSolanaHistoricalDescriptiveMetrics(plan, evidence);

  const fingerprint = sourceFingerprint(plan, evidence);
  const candidateMap = new Map<string, SolanaHistoricalTransactionSourceReference[]>();
  const authoritySelectionPosition = new Map<string, number>();
  for (const candidate of plan.candidateAuthorities) {
    if (candidate.plannedDisposition.status === "selected") {
      authoritySelectionPosition.set(candidate.authorityAddress, candidate.plannedDisposition.selectionPosition);
    }
  }
  for (let authorityIndex = 0; authorityIndex < evidence.authorities.length; authorityIndex += 1) {
    const authority = evidence.authorities[authorityIndex];
    if (authority.queryStatus === "not_queried") continue;
    const candidate = plan.candidateAuthorities[authorityIndex];
    if (candidate.plannedDisposition.status !== "selected") throw new Error("Historical source observations belong to an unselected authority.");
    for (let observationIndex = 0; observationIndex < authority.observations.length; observationIndex += 1) {
      const observation = authority.observations[observationIndex];
      const signature = observation.providerRecord.signature;
      if (!isSolanaTransactionSignatureSyntax(signature)) {
        throw new Error("Historical source contains a malformed Solana transaction signature.");
      }
      const sourceObservations = candidateMap.get(signature) ?? [];
      const reference: SolanaHistoricalTransactionSourceReference = {
        sourceFingerprint: fingerprint,
        authorityAddress: authority.authorityAddress,
        authoritySelectionPosition: authoritySelectionPosition.get(authority.authorityAddress)!,
        historicalObservationIndex: observationIndex,
        rank: candidateRank(plan, candidate),
      };
      sourceObservations.push(reference);
      candidateMap.set(signature, sourceObservations);
    }
  }

  const signatures = [...candidateMap.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const candidates: SolanaHistoricalTransactionSignatureCandidate[] = signatures.map((signature, index) => ({
    signature,
    sourceObservations: candidateMap.get(signature)!,
    disposition: index < SIGNATURE_CAP
      ? { status: "selected", selectionPosition: index }
      : { status: "not_selected", reason: "signature_cap" },
  }));
  const authorities = evidence.authorities;
  const naturallyCompleteAuthorityCount = authorities.filter((authority) => authority.queryStatus === "success" && authority.paginationStatus === "complete").length;
  const truncatedAuthorityCount = authorities.filter((authority) => authority.queryStatus === "success" && authority.paginationStatus === "truncated").length;
  const providerErrorAuthorityCount = authorities.filter((authority) => authority.queryStatus === "provider_error").length;
  const unqueriedAuthorityCount = authorities.filter((authority) => authority.queryStatus === "not_queried").length;
  const signatureSourceCompleteness = evidence.authorityScope.candidateSetCompleteness === "complete" &&
    unqueriedAuthorityCount === 0 && truncatedAuthorityCount === 0 && providerErrorAuthorityCount === 0 &&
    naturallyCompleteAuthorityCount === plan.candidateAuthorities.length ? "complete" : "partial";

  return {
    schemaVersion: "solana-historical-transaction-selection-v1",
    chain: "solana",
    mintAddress: plan.mintAddress,
    sourceHistoricalPlanVersion: plan.planVersion,
    sourceFingerprint: fingerprint,
    requestedWindow: { ...plan.requestedWindow },
    sourceEvidenceFetchedAt: evidence.provenance.fetchedAt,
    signatureCap: SIGNATURE_CAP,
    selectionCompleteness: "complete",
    sourceCoverage: {
      holderCandidateFrameCompleteness: evidence.authorityScope.candidateSetCompleteness,
      candidateAuthorityCount: plan.candidateAuthorities.length,
      selectedAuthorityCount: plan.selectedAuthorityCount,
      naturallyCompleteAuthorityCount,
      truncatedAuthorityCount,
      providerErrorAuthorityCount,
      unqueriedAuthorityCount,
      signatureSourceCompleteness,
    },
    uniqueSignatureCount: candidates.length,
    selectedUniqueSignatureCount: Math.min(candidates.length, SIGNATURE_CAP),
    candidates,
  };
}

export function validateSolanaHistoricalTransactionSelection(
  selection: SolanaHistoricalTransactionSelectionEvidence,
  plan: SolanaHistoricalQueryPlanVersioned,
  evidence: SolanaBoundedHistoricalSamplingEvidence,
): void {
  const expected = createSolanaHistoricalTransactionSelection(plan, evidence);
  if (JSON.stringify(selection) !== JSON.stringify(expected)) {
    throw new Error("Transaction selection does not match its validated historical source artifact.");
  }
}

export function resolveSolanaHistoricalTransactionSourceReference(
  reference: SolanaHistoricalTransactionSourceReference,
  signature: string,
  plan: SolanaHistoricalQueryPlanVersioned,
  evidence: SolanaBoundedHistoricalSamplingEvidence,
): { authority: SolanaHistoricalAuthorityEvidence; observation: SolanaHistoricalTransferObservation } {
  if (reference.sourceFingerprint !== sourceFingerprint(plan, evidence)) throw new Error("Historical transaction source fingerprint mismatch.");
  const candidateIndex = plan.candidateAuthorities.findIndex((candidate) => candidate.authorityAddress === reference.authorityAddress);
  if (candidateIndex < 0) throw new Error("Historical transaction source authority is missing from its plan.");
  const candidate = plan.candidateAuthorities[candidateIndex];
  if (candidate.plannedDisposition.status !== "selected" ||
    candidate.plannedDisposition.selectionPosition !== reference.authoritySelectionPosition) {
    throw new Error("Historical transaction source authority selection position does not match its plan.");
  }
  const expectedRank = candidateRank(plan, candidate);
  if (reference.rank.basis !== expectedRank.basis || reference.rank.value !== expectedRank.value) {
    throw new Error("Historical transaction source rank semantics do not match its plan.");
  }
  const authority = evidence.authorities[candidateIndex];
  const observation = authority?.observations[reference.historicalObservationIndex];
  if (!observation || observation.providerRecord.signature !== signature ||
    pageNumberForObservation(authority, reference.historicalObservationIndex) === 0) {
    throw new Error("Historical transaction source observation reference does not resolve to its signature.");
  }
  return { authority, observation };
}
