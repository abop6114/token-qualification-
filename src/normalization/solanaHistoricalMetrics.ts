import type { SolanaHistoricalAuthorityEvidence, SolanaHistoricalTransferObservation } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlan } from "../types/solanaHistoricalQueryPlan";
import type {
  SolanaHistoricalAuthorityMetrics,
  SolanaHistoricalAmountEvidenceProfile,
  SolanaHistoricalDescriptiveMetrics,
  SolanaHistoricalEndpointRelationshipCounts,
  SolanaHistoricalMetricValue,
  SolanaHistoricalReportedAmountType,
  SolanaHistoricalTransferTypeCount,
} from "../types/solanaHistoricalMetrics";
import type { SolanaBoundedHistoricalSamplingEvidence } from "../types/solanaHistoricalSampling";

function assertPlanEvidenceConsistency(
  plan: SolanaHistoricalQueryPlan,
  evidence: SolanaBoundedHistoricalSamplingEvidence,
): void {
  if (plan.planVersion !== "solana-bounded-history-query-plan-v1") {
    throw new Error("Unsupported Solana historical query plan version.");
  }
  if (evidence.chain !== "solana" || plan.mintAddress !== evidence.mintAddress) {
    throw new Error("Historical query plan and evidence chain or mint do not match.");
  }
  if (
    plan.requestedWindow.fromUnixSecondsInclusive !== evidence.provenance.requestedWindow.fromUnixSecondsInclusive ||
    plan.requestedWindow.toUnixSecondsExclusive !== evidence.provenance.requestedWindow.toUnixSecondsExclusive
  ) {
    throw new Error("Historical query plan and evidence requested windows do not match.");
  }
  if (
    plan.sourceHolder.candidateAuthorityCount !== plan.candidateAuthorities.length ||
    plan.selectedAuthorityCount !== plan.sourceSelection.selectedAuthorityCount ||
    plan.selectedAuthorityCount !== plan.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "selected").length ||
    evidence.authorityScope.candidateAuthorityCount !== plan.candidateAuthorities.length ||
    evidence.authorities.length !== plan.candidateAuthorities.length ||
    evidence.authorityScope.source !== "holder_snapshot"
  ) {
    throw new Error("Historical query plan and evidence candidate frames do not match.");
  }
  if (
    evidence.provenance.maxAuthorities !== plan.sourceSelection.configuredMaximumSelectedAuthorityCount ||
    evidence.provenance.maxPagesPerAuthority !== plan.maxPagesPerAuthority ||
    evidence.provenance.maxRecordsPerAuthority !== plan.maxRecordsPerAuthority
  ) {
    throw new Error("Historical query plan and evidence execution bounds do not match.");
  }
  const expectedCandidateCompleteness =
    plan.sourceHolder.enumeration.completeness === "complete" && plan.sourceHolder.amountCoverage.state === "complete"
      ? "complete"
      : "partial";
  if (evidence.authorityScope.candidateSetCompleteness !== expectedCandidateCompleteness) {
    throw new Error("Historical query plan and evidence candidate-set completeness do not match.");
  }
  if (evidence.applicationDerivedEvidence.status !== "not_calculated" || evidence.applicationDerivedEvidence.metrics !== null) {
    throw new Error("Historical source evidence unexpectedly contains pre-calculated metrics.");
  }

  const evidenceByIndex = evidence.authorities;
  for (let index = 0; index < plan.candidateAuthorities.length; index += 1) {
    const candidate = plan.candidateAuthorities[index];
    const authority = evidenceByIndex[index];
    if (!authority || authority.authorityAddress !== candidate.authorityAddress) {
      throw new Error("Historical query plan and evidence authority frames do not match.");
    }
    if (candidate.plannedDisposition.status === "not_selected") {
      if (authority.queryStatus !== "not_queried") {
        throw new Error("Historical evidence query disposition does not match the plan.");
      }
    } else if (authority.queryStatus === "not_queried") {
      throw new Error("A selected historical authority is marked not queried in the evidence.");
    }
    assertAuthorityEvidence(authority, plan.maxPagesPerAuthority, plan.maxRecordsPerAuthority, evidence.mintAddress);
  }
}

function assertAuthorityEvidence(
  authority: SolanaHistoricalAuthorityEvidence,
  maxPagesPerAuthority: number,
  maxRecordsPerAuthority: number,
  mintAddress: string,
): void {
  if (!Array.isArray(authority.pages) || !Array.isArray(authority.observations)) {
    throw new Error("Historical authority evidence has malformed page or observation arrays.");
  }
  if (authority.queryStatus === "not_queried") {
    if (
      !["not_selected", "budget_limit"].includes(authority.reason) ||
      authority.requestCount !== 0 || authority.pages.length !== 0 || authority.observations.length !== 0 ||
      authority.paginationStatus !== "not_applicable" || authority.terminalReason !== "not_queried"
    ) {
      throw new Error("Unqueried historical authority evidence contains query results.");
    }
    return;
  }

  if (
    !Number.isSafeInteger(authority.requestCount) || authority.requestCount <= 0 ||
    authority.requestCount > maxPagesPerAuthority || authority.observations.length > maxRecordsPerAuthority
  ) {
    throw new Error("Historical authority evidence exceeds or contradicts its query bounds.");
  }

  let expectedStartIndex = 0;
  for (let index = 0; index < authority.pages.length; index += 1) {
    const page = authority.pages[index];
    if (
      page.pageNumber !== index + 1 ||
      page.startRecordIndex !== expectedStartIndex ||
      !Number.isSafeInteger(page.startRecordIndex) || page.startRecordIndex < 0 ||
      !Number.isSafeInteger(page.requestLimit) || page.requestLimit <= 0 ||
      !Number.isSafeInteger(page.pageNumber) || page.pageNumber <= 0 ||
      !Number.isSafeInteger(page.recordCount) || page.recordCount < 0 ||
      !Number.isSafeInteger(page.endRecordIndexExclusive) ||
      page.endRecordIndexExclusive !== page.startRecordIndex + page.recordCount ||
      !Number.isSafeInteger(page.recordsWithoutUsableBlockTime) ||
      page.recordsWithoutUsableBlockTime < 0 || page.recordsWithoutUsableBlockTime > page.recordCount ||
      page.continuationTokenUsed !== (index > 0)
    ) {
      throw new Error("Historical page evidence has inconsistent record indexes or counts.");
    }
    const pageObservations = authority.observations.slice(page.startRecordIndex, page.endRecordIndexExclusive);
    if (pageObservations.length !== page.recordCount) {
      throw new Error("Historical page evidence does not match its observation slice.");
    }
    for (const observation of pageObservations) assertObservationTimeConsistency(observation, mintAddress);
    const usableTimes = pageObservations.flatMap((observation) =>
      observation.observedTime.status === "available" ? [observation.observedTime.unixSeconds] : []);
    const expectedFirst = usableTimes[0] ?? null;
    const expectedLast = usableTimes.at(-1) ?? null;
    let expectedMin: number | null = null;
    let expectedMax: number | null = null;
    for (const time of usableTimes) {
      expectedMin = expectedMin === null || time < expectedMin ? time : expectedMin;
      expectedMax = expectedMax === null || time > expectedMax ? time : expectedMax;
    }
    if (
      page.recordsWithoutUsableBlockTime !== page.recordCount - usableTimes.length ||
      page.firstUsableBlockTime !== expectedFirst || page.lastUsableBlockTime !== expectedLast ||
      page.minimumUsableBlockTime !== expectedMin || page.maximumUsableBlockTime !== expectedMax
    ) {
      throw new Error("Historical page timestamp evidence does not reconcile with its observations.");
    }
    expectedStartIndex = page.endRecordIndexExclusive;
  }
  if (expectedStartIndex !== authority.observations.length || authority.requestCount < authority.pages.length) {
    throw new Error("Historical page evidence does not reconcile with accepted observations or requests.");
  }

  if (authority.queryStatus === "success") {
    if (authority.requestCount !== authority.pages.length || authority.pages.length === 0) {
      throw new Error("Successful historical authority evidence has inconsistent request counts.");
    }
    const lastPage = authority.pages[authority.pages.length - 1];
    if (authority.providerError !== null) throw new Error("Successful historical authority evidence contains a provider error.");
    for (let index = 0; index < authority.pages.length - 1; index += 1) {
      if (!authority.pages[index].continuationTokenReturned) {
        throw new Error("Historical evidence continued after a page without a continuation token.");
      }
    }
    if (authority.paginationStatus === "complete") {
      if (authority.terminalReason !== "natural_termination" || lastPage.continuationTokenReturned) {
        throw new Error("Complete historical authority evidence lacks natural pagination termination.");
      }
    } else if (authority.paginationStatus === "truncated") {
      const pageCapReached = authority.pages.length === maxPagesPerAuthority;
      const recordCapReached = authority.observations.length === maxRecordsPerAuthority;
      const expectedReason = pageCapReached && recordCapReached
        ? "page_and_record_caps"
        : pageCapReached ? "page_cap" : recordCapReached ? "record_cap" : null;
      if (
        expectedReason === null || authority.terminalReason !== expectedReason ||
        !lastPage.continuationTokenReturned
      ) {
        throw new Error("Truncated historical authority evidence has inconsistent cap termination.");
      }
    } else {
      throw new Error("Successful historical authority evidence has an inapplicable pagination status.");
    }
  } else if (
    authority.paginationStatus !== "not_applicable" ||
    authority.terminalReason !== "provider_error" ||
    authority.providerError === null ||
    typeof authority.providerError.category !== "string" ||
    authority.requestCount <= authority.pages.length ||
    authority.pages.some((page) => !page.continuationTokenReturned)
  ) {
    throw new Error("Failed historical authority evidence has inconsistent provider-error state.");
  }

}

const reportedAmountTypes: readonly SolanaHistoricalReportedAmountType[] = [
  "integer_string",
  "non_integer_string",
  "safe_integer_number",
  "non_integer_number",
  "unsafe_integer_number",
  "null",
  "missing",
];

function hasCanonicalNumberRepresentation(value: unknown, kind: "safe_integer" | "non_integer"): boolean {
  if (typeof value !== "string") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && String(parsed) === value &&
    (kind === "safe_integer" ? Number.isSafeInteger(parsed) : !Number.isInteger(parsed));
}

function assertAmountEvidenceConsistency(amount: unknown): void {
  if (typeof amount !== "object" || amount === null || Array.isArray(amount)) {
    throw new Error("Historical evidence contains malformed amount evidence.");
  }
  const value = amount as Record<string, unknown>;
  const amountType = value.reportedAmountType;
  if (!reportedAmountTypes.includes(amountType as SolanaHistoricalReportedAmountType)) {
    throw new Error("Historical evidence contains an unsupported reported amount type.");
  }

  const exact = amountType === "integer_string";
  if (exact) {
    if (
      typeof value.rawAmount !== "string" || !/^[0-9]+$/.test(value.rawAmount) ||
      value.exactRawAvailable !== true || value.exactnessBasis !== "provider_integer_string" ||
      value.unavailableReason !== null || value.reportedAmount !== value.rawAmount
    ) {
      throw new Error("Historical evidence contains inconsistent exact raw amount evidence.");
    }
  } else {
    const expectedReason = amountType === "null" || amountType === "missing"
      ? "not_reported"
      : "provider_representation_not_exact";
    let reportedAmountIsValid = false;
    switch (amountType) {
      case "non_integer_string":
        reportedAmountIsValid = typeof value.reportedAmount === "string" && value.reportedAmount.length > 0 && !/^[0-9]+$/.test(value.reportedAmount);
        break;
      case "safe_integer_number":
        reportedAmountIsValid = hasCanonicalNumberRepresentation(value.reportedAmount, "safe_integer");
        break;
      case "non_integer_number":
        reportedAmountIsValid = hasCanonicalNumberRepresentation(value.reportedAmount, "non_integer");
        break;
      case "unsafe_integer_number":
      case "null":
      case "missing":
        reportedAmountIsValid = value.reportedAmount === null;
        break;
    }
    if (
      value.rawAmount !== null || value.exactRawAvailable !== false || value.exactnessBasis !== null ||
      value.unavailableReason !== expectedReason || !reportedAmountIsValid
    ) {
      throw new Error("Historical evidence contains inconsistent non-exact amount evidence.");
    }
  }

  const uiValue = value.reportedUiAmount;
  switch (value.reportedUiAmountType) {
    case undefined:
      if (uiValue !== undefined) throw new Error("Historical evidence contains inconsistent UI amount evidence.");
      break;
    case "string":
      if (typeof uiValue !== "string") throw new Error("Historical evidence contains inconsistent UI amount evidence.");
      break;
    case "number":
      if (uiValue !== undefined) throw new Error("Historical evidence contains inconsistent UI amount evidence.");
      break;
    case "null":
      if (uiValue !== null) throw new Error("Historical evidence contains inconsistent UI amount evidence.");
      break;
    default:
      throw new Error("Historical evidence contains an unsupported UI amount type.");
  }
}

function assertObservationTimeConsistency(observation: SolanaHistoricalTransferObservation, mintAddress: string): void {
  if (
    !observation || typeof observation !== "object" || !observation.providerRecord ||
    typeof observation.providerRecord.signature !== "string" || observation.providerRecord.signature.length === 0 ||
    !observation.observedTime || typeof observation.observedTime !== "object"
  ) {
    throw new Error("Historical evidence contains a malformed observation.");
  }
  const blockTime = observation.providerRecord.blockTime;
  if (
    (blockTime !== undefined && blockTime !== null && (!Number.isSafeInteger(blockTime) || blockTime < 0)) ||
    (observation.providerRecord.type !== undefined && observation.providerRecord.type !== null && typeof observation.providerRecord.type !== "string") ||
    (observation.providerRecord.fromUserAccount !== undefined && observation.providerRecord.fromUserAccount !== null && typeof observation.providerRecord.fromUserAccount !== "string") ||
    (observation.providerRecord.toUserAccount !== undefined && observation.providerRecord.toUserAccount !== null && typeof observation.providerRecord.toUserAccount !== "string")
  ) {
    throw new Error("Historical evidence contains malformed metric source fields.");
  }
  const providerRecord = observation.providerRecord as SolanaHistoricalTransferObservation["providerRecord"] & { mint?: unknown };
  if (
    ("mint" in providerRecord && providerRecord.mint === undefined) ||
    (providerRecord.mint !== undefined && providerRecord.mint !== null && typeof providerRecord.mint !== "string") ||
    (typeof providerRecord.mint === "string" && providerRecord.mint !== mintAddress)
  ) {
    throw new Error("Historical observation mint is malformed or does not match the requested mint.");
  }
  assertAmountEvidenceConsistency(providerRecord.amount);
  const observedTime = observation.observedTime;
  if (observedTime.status === "available" && (!Number.isSafeInteger(observedTime.unixSeconds) || observedTime.unixSeconds < 0)) {
    throw new Error("Historical observation has a malformed normalized block time.");
  }
  const matches = blockTime === undefined
    ? observedTime.status === "unavailable" && observedTime.reason === "missing"
    : blockTime === null
      ? observedTime.status === "unavailable" && observedTime.reason === "null"
      : observedTime.status === "available" && observedTime.unixSeconds === blockTime;
  if (!matches) throw new Error("Historical observation block-time projection is inconsistent.");
}

function available<T>(value: T, queryCompleteness: "complete" | "partial"): SolanaHistoricalMetricValue<T> {
  return { status: "available", value, queryCompleteness };
}

function unavailable(reason: "not_queried" | "provider_error" | "no_usable_block_times"):
SolanaHistoricalMetricValue<never> {
  return { status: "unavailable", value: null, reason };
}

function metricCompleteness(authority: SolanaHistoricalAuthorityEvidence): "complete" | "partial" {
  return authority.queryStatus === "success" && authority.paginationStatus === "complete" ? "complete" : "partial";
}

function countTransferTypes(observations: SolanaHistoricalTransferObservation[]): SolanaHistoricalTransferTypeCount[] {
  const counts = new Map<string, { availability: "reported" | "null" | "missing"; reportedType: string | null; count: number }>();
  for (const observation of observations) {
    const rawType = observation.providerRecord.type;
    const availability = rawType === undefined ? "missing" : rawType === null ? "null" : "reported";
    const reportedType = availability === "reported" ? rawType as string : null;
    const key = `${availability}:${reportedType ?? ""}`;
    const prior = counts.get(key);
    counts.set(key, { availability, reportedType, count: (prior?.count ?? 0) + 1 });
  }
  const availabilityOrder = { missing: 0, null: 1, reported: 2 } as const;
  return [...counts.values()].sort((left, right) =>
    availabilityOrder[left.availability] - availabilityOrder[right.availability] ||
    (left.reportedType === right.reportedType ? 0 : (left.reportedType as string) < (right.reportedType as string) ? -1 : 1));
}

function countEndpointRelationships(
  authorityAddress: string,
  observations: SolanaHistoricalTransferObservation[],
): SolanaHistoricalEndpointRelationshipCounts {
  const counts: SolanaHistoricalEndpointRelationshipCounts = {
    reportedInbound: 0,
    reportedOutbound: 0,
    reportedSelfDirected: 0,
    ambiguous: 0,
  };
  for (const observation of observations) {
    const fromMatches = observation.providerRecord.fromUserAccount === authorityAddress;
    const toMatches = observation.providerRecord.toUserAccount === authorityAddress;
    if (fromMatches && toMatches) counts.reportedSelfDirected += 1;
    else if (fromMatches) counts.reportedOutbound += 1;
    else if (toMatches) counts.reportedInbound += 1;
    else counts.ambiguous += 1;
  }
  return counts;
}

function calculateAmountEvidenceProfile(
  observations: SolanaHistoricalTransferObservation[],
): SolanaHistoricalAmountEvidenceProfile {
  const counts = new Map<SolanaHistoricalReportedAmountType, number>(reportedAmountTypes.map((type) => [type, 0]));
  let exactRawAmountObservationCount = 0;
  let minimum: bigint | null = null;
  let maximum: bigint | null = null;
  for (const observation of observations) {
    const amount = observation.providerRecord.amount;
    const type = amount.reportedAmountType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (amount.exactRawAvailable) {
      exactRawAmountObservationCount += 1;
      const raw = BigInt(amount.rawAmount);
      minimum = minimum === null || raw < minimum ? raw : minimum;
      maximum = maximum === null || raw > maximum ? raw : maximum;
    }
  }
  const nonExactOrUnavailableAmountObservationCount = observations.length - exactRawAmountObservationCount;
  const exactRawAmountCoverage = observations.length === 0 || exactRawAmountObservationCount === 0
    ? "none"
    : exactRawAmountObservationCount === observations.length ? "complete" : "partial";
  return {
    exactRawAmountObservationCount,
    nonExactOrUnavailableAmountObservationCount,
    reportedAmountTypeCounts: reportedAmountTypes.map((reportedAmountType) => ({
      reportedAmountType,
      count: counts.get(reportedAmountType) ?? 0,
    })),
    exactRawAmountCoverage,
    minimumExactRawAmount: minimum?.toString() ?? null,
    maximumExactRawAmount: maximum?.toString() ?? null,
  };
}

function unavailableAmountProfile(reason: "not_queried" | "provider_error"): SolanaHistoricalMetricValue<never> {
  return unavailable(reason);
}

function calculateAuthorityMetrics(authority: SolanaHistoricalAuthorityEvidence): SolanaHistoricalAuthorityMetrics {
  const base = {
    authorityAddress: authority.authorityAddress,
    queryStatus: authority.queryStatus,
    paginationStatus: authority.paginationStatus,
  } as const;
  if (authority.queryStatus === "not_queried") {
    return {
      ...base,
      acceptedObservationCount: unavailable("not_queried"),
      usableBlockTimeCount: unavailable("not_queried"),
      missingBlockTimeCount: unavailable("not_queried"),
      observedBlockTimeBounds: unavailable("not_queried"),
      distinctSignatureCount: unavailable("not_queried"),
      reportedTransferTypeCounts: unavailable("not_queried"),
      reportedEndpointRelationshipCounts: unavailable("not_queried"),
      amountEvidenceProfile: unavailableAmountProfile("not_queried"),
    };
  }

  const observations = authority.observations;
  if (authority.queryStatus === "provider_error" && observations.length === 0) {
    return {
      ...base,
      acceptedObservationCount: unavailable("provider_error"),
      usableBlockTimeCount: unavailable("provider_error"),
      missingBlockTimeCount: unavailable("provider_error"),
      observedBlockTimeBounds: unavailable("provider_error"),
      distinctSignatureCount: unavailable("provider_error"),
      reportedTransferTypeCounts: unavailable("provider_error"),
      reportedEndpointRelationshipCounts: unavailable("provider_error"),
      amountEvidenceProfile: unavailableAmountProfile("provider_error"),
    };
  }

  const completeness = metricCompleteness(authority);
  const usableTimes: number[] = [];
  for (const observation of observations) {
    if (observation.observedTime.status === "available") usableTimes.push(observation.observedTime.unixSeconds);
  }
  const missingTimeCount = observations.length - usableTimes.length;
  const signatureSet = new Set(observations.map((observation) => observation.providerRecord.signature));
  let minimumUnixSeconds: number | null = null;
  let maximumUnixSeconds: number | null = null;
  for (const time of usableTimes) {
    minimumUnixSeconds = minimumUnixSeconds === null || time < minimumUnixSeconds ? time : minimumUnixSeconds;
    maximumUnixSeconds = maximumUnixSeconds === null || time > maximumUnixSeconds ? time : maximumUnixSeconds;
  }
  const bounds: SolanaHistoricalMetricValue<{ minimumUnixSeconds: number; maximumUnixSeconds: number; spanSeconds: number }> =
    minimumUnixSeconds === null || maximumUnixSeconds === null
      ? unavailable("no_usable_block_times")
      : available({
          minimumUnixSeconds,
          maximumUnixSeconds,
          spanSeconds: maximumUnixSeconds - minimumUnixSeconds,
        }, completeness);

  return {
    ...base,
    acceptedObservationCount: available(observations.length, completeness),
    usableBlockTimeCount: available(usableTimes.length, completeness),
    missingBlockTimeCount: available(missingTimeCount, completeness),
    observedBlockTimeBounds: bounds,
    distinctSignatureCount: available(signatureSet.size, completeness),
    reportedTransferTypeCounts: available(countTransferTypes(observations), completeness),
    reportedEndpointRelationshipCounts: available(
      countEndpointRelationships(authority.authorityAddress, observations),
      completeness,
    ),
    amountEvidenceProfile: available(calculateAmountEvidenceProfile(observations), completeness),
  };
}

export function calculateSolanaHistoricalDescriptiveMetrics(
  plan: SolanaHistoricalQueryPlan,
  evidence: SolanaBoundedHistoricalSamplingEvidence,
): SolanaHistoricalDescriptiveMetrics {
  assertPlanEvidenceConsistency(plan, evidence);
  const authorities = evidence.authorities.map(calculateAuthorityMetrics);
  const selectedCount = plan.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "selected").length;
  const queriedCount = evidence.authorities.filter((authority) => authority.queryStatus !== "not_queried").length;
  const naturallyCompleteCount = evidence.authorities.filter((authority) =>
    authority.queryStatus === "success" && authority.paginationStatus === "complete").length;
  const truncatedCount = evidence.authorities.filter((authority) =>
    authority.queryStatus === "success" && authority.paginationStatus === "truncated").length;
  const providerErrorCount = evidence.authorities.filter((authority) => authority.queryStatus === "provider_error").length;
  const unqueriedCount = evidence.authorities.length - queriedCount;

  return {
    version: "solana-historical-descriptive-metrics-v1",
    source: {
      mintAddress: plan.mintAddress,
      requestedWindow: { ...plan.requestedWindow },
      evidenceFetchedAt: evidence.provenance.fetchedAt,
      selectorVersion: plan.sourceSelection.selectorVersion,
      selectionBasis: plan.sourceSelection.selectionBasis,
      candidateAuthorityCount: plan.sourceHolder.candidateAuthorityCount,
      candidateSetCompleteness: evidence.authorityScope.candidateSetCompleteness,
      selectedAuthorityCount: selectedCount,
    },
    sampleCoverage: {
      candidateAuthorityCount: plan.sourceHolder.candidateAuthorityCount,
      selectedAuthorityCount: selectedCount,
      queriedAuthorityCount: queriedCount,
      naturallyCompleteAuthorityCount: naturallyCompleteCount,
      truncatedAuthorityCount: truncatedCount,
      providerErrorAuthorityCount: providerErrorCount,
      unqueriedAuthorityCount: unqueriedCount,
    },
    authorities,
  };
}
