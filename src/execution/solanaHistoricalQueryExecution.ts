import {
  HeliusTransferProviderError,
  type GetHeliusTransferPageInput,
  type HeliusTransferObservation,
  type HeliusTransferPage,
} from "../providers/solana/heliusTransfersByAddress";
import {
  getHeliusHistoricalTransferPage,
  HELIUS_HISTORICAL_TRANSFER_PAGE_LIMIT,
  type HeliusHistoricalTransferPageFetcher,
} from "../providers/solana/heliusHistoricalTransferAdapter";
import type { SolanaHistoricalAmountEvidence, SolanaHistoricalAuthorityEvidence, SolanaHistoricalPageEvidence, SolanaHistoricalTransferObservation } from "../types/solanaHistoricalSampling";
import type { SolanaHistoricalQueryPlan, SolanaHistoricalQueryPlanV2, SolanaHistoricalQueryPlanVersioned } from "../types/solanaHistoricalQueryPlan";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import { validateSolanaHistoricalQueryPlanV2 } from "../normalization/solanaHistoricalQueryPlan";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface SolanaHistoricalExecutionTelemetry {
  selectedAuthorityCount: number;
  /** Authorities with at least one page-fetch attempt. */
  attemptedAuthorityCount: number;
  /** Authorities reaching complete or cap-truncated success. */
  completedAuthorityCount: number;
  failedAuthorityCount: number;
  requestCount: number;
  pagesReceived: number;
  recordsReturned: number;
  truncatedAuthorityCount: number;
  /** Counts by sanitized provider error category; messages and response bodies are omitted. */
  sanitizedErrorCounts: Record<string, number>;
  elapsedMs: number;
  creditUsage: {
    status: "unknown";
    credits: null;
    reason: "provider_usage_not_observed";
  };
}

export interface SolanaHistoricalQueryExecutionResult {
  /** The exact input plan; planning remains distinct from observed evidence. */
  plan: SolanaHistoricalQueryPlanVersioned;
  evidence: import("../types/solanaHistoricalSampling").SolanaBoundedHistoricalSamplingEvidence;
  telemetry: SolanaHistoricalExecutionTelemetry;
}

export interface ExecuteSolanaHistoricalQueryPlanOptions {
  /** Per-request network timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Injectable page source for deterministic tests; defaults to the Helius adapter. */
  fetchPage?: HeliusHistoricalTransferPageFetcher;
  /** Injectable epoch-millisecond clock for deterministic evidence/telemetry tests. */
  now?: () => number;
}

interface AuthorityRun {
  evidence: SolanaHistoricalAuthorityEvidence;
  requestCount: number;
  pagesReceived: number;
  recordsReturned: number;
  truncated: boolean;
  errorCategory: string | null;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function safeProduct(left: number, right: number): number {
  const product = BigInt(left) * BigInt(right);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Query plan cost bound exceeds the safe integer range.");
  return Number(product);
}

function assertPlanV1(plan: SolanaHistoricalQueryPlan): void {
  if (plan.planVersion !== "solana-bounded-history-query-plan-v1") throw new Error("Unsupported Solana historical query plan version.");
  if (!isSolanaPublicKeySyntax(plan.mintAddress)) throw new Error("Query plan mint address is malformed.");
  if (
    !Number.isSafeInteger(plan.requestedWindow.fromUnixSecondsInclusive) ||
    plan.requestedWindow.fromUnixSecondsInclusive < 0 ||
    !Number.isSafeInteger(plan.requestedWindow.toUnixSecondsExclusive) ||
    plan.requestedWindow.toUnixSecondsExclusive <= plan.requestedWindow.fromUnixSecondsInclusive
  ) {
    throw new Error("Query plan requested time window is malformed.");
  }
  if (!positiveSafeInteger(plan.maxPagesPerAuthority) || !positiveSafeInteger(plan.maxRecordsPerAuthority)) {
    throw new Error("Query plan page and record caps must be positive safe integers.");
  }
  if (
    !positiveSafeInteger(plan.sourceSelection.configuredMaximumSelectedAuthorityCount) ||
    !Number.isSafeInteger(plan.sourceHolder.candidateAuthorityCount) ||
    plan.sourceHolder.candidateAuthorityCount < 0 ||
    !Array.isArray(plan.candidateAuthorities) ||
    plan.sourceHolder.candidateAuthorityCount !== plan.candidateAuthorities.length
  ) {
    throw new Error("Query plan candidate frame or authority cap is malformed.");
  }

  const selected = plan.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "selected");
  if (
    !Number.isSafeInteger(plan.selectedAuthorityCount) ||
    plan.selectedAuthorityCount < 0 ||
    plan.selectedAuthorityCount !== selected.length ||
    plan.selectedAuthorityCount !== plan.sourceSelection.selectedAuthorityCount ||
    plan.selectedAuthorityCount > plan.sourceSelection.configuredMaximumSelectedAuthorityCount ||
    plan.selectedAuthorityCount !== Math.min(
      plan.sourceHolder.candidateAuthorityCount,
      plan.sourceSelection.configuredMaximumSelectedAuthorityCount,
    )
  ) {
    throw new Error("Query plan selected-authority counts are inconsistent.");
  }

  const seenAuthorities = new Set<string>();
  const positions = new Set<number>();
  let selectedDispositionCount = 0;
  let previousBalance: bigint | null = null;
  let previousAddress: string | null = null;
  for (let rank = 0; rank < plan.candidateAuthorities.length; rank += 1) {
    const candidate = plan.candidateAuthorities[rank];
    if (
      !isSolanaPublicKeySyntax(candidate.authorityAddress) ||
      seenAuthorities.has(candidate.authorityAddress) ||
      candidate.sourceRank !== rank ||
      !/^[1-9][0-9]*$/.test(candidate.balanceRaw)
    ) {
      throw new Error("Query plan candidate frame is malformed or non-deterministic.");
    }
    const balance = BigInt(candidate.balanceRaw);
    if (
      previousBalance !== null &&
      (previousBalance < balance || (previousBalance === balance && (previousAddress as string) > candidate.authorityAddress))
    ) {
      throw new Error("Query plan candidate ranks are not normalized.");
    }
    previousBalance = balance;
    previousAddress = candidate.authorityAddress;
    seenAuthorities.add(candidate.authorityAddress);
    if (candidate.plannedDisposition.status === "selected") {
      selectedDispositionCount += 1;
      const position = candidate.plannedDisposition.selectionPosition;
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position >= plan.selectedAuthorityCount ||
        positions.has(position) ||
        candidate.plannedDisposition.selectionReason !== "rank_position"
      ) {
        throw new Error("Query plan selected-authority disposition is malformed.");
      }
      positions.add(position);
    } else if (candidate.plannedDisposition.status !== "not_selected") {
      throw new Error("Query plan contains an unknown candidate disposition.");
    }
  }
  for (let position = 0; position < selectedDispositionCount; position += 1) {
    if (!positions.has(position)) throw new Error("Query plan selection positions are not contiguous.");
  }

  if (
    plan.maximumProviderRequests !== safeProduct(plan.selectedAuthorityCount, plan.maxPagesPerAuthority) ||
    plan.maximumReturnedRecords !== safeProduct(plan.selectedAuthorityCount, plan.maxRecordsPerAuthority)
  ) {
    throw new Error("Query plan request or record bounds are inconsistent.");
  }
}

function assertPlanV2(plan: SolanaHistoricalQueryPlanV2): void {
  validateSolanaHistoricalQueryPlanV2(plan);
}

function assertPlan(plan: SolanaHistoricalQueryPlanVersioned): void {
  if (plan.planVersion === "solana-bounded-history-query-plan-v1") assertPlanV1(plan);
  else if (plan.planVersion === "solana-bounded-history-query-plan-v2") assertPlanV2(plan);
  else throw new Error("Unsupported Solana historical query plan version.");
}

function malformedResponse(message: string): HeliusTransferProviderError {
  return new HeliusTransferProviderError("malformed_response", message);
}

function normalizeAmount(amount: HeliusTransferObservation["amount"]): SolanaHistoricalAmountEvidence {
  if (amount === null || typeof amount !== "object") throw malformedResponse("Helius returned a malformed transfer amount.");
  const reportedAmountType = amount.reportedAmountType;
  const reportedFields = {
    reportedAmount: amount.reportedAmount,
    reportedAmountType,
    ...(amount.reportedUiAmount === undefined ? {} : { reportedUiAmount: amount.reportedUiAmount }),
    ...(amount.reportedUiAmountType === undefined ? {} : { reportedUiAmountType: amount.reportedUiAmountType }),
  };

  if (reportedAmountType === "integer_string") {
    if (
      amount.exactRawAvailable !== true ||
      typeof amount.rawAmount !== "string" ||
      !/^[0-9]+$/.test(amount.rawAmount) ||
      amount.reportedAmount !== amount.rawAmount
    ) {
      throw malformedResponse("Helius returned inconsistent exact raw amount evidence.");
    }
    return {
      ...reportedFields,
      rawAmount: amount.rawAmount,
      exactRawAvailable: true,
      exactnessBasis: "provider_integer_string",
      unavailableReason: null,
      reportedAmount: amount.reportedAmount,
      reportedAmountType,
    };
  }

  const validNonExactType = new Set([
    "non_integer_string",
    "safe_integer_number",
    "non_integer_number",
    "unsafe_integer_number",
    "null",
    "missing",
  ]);
  if (!validNonExactType.has(reportedAmountType) || amount.exactRawAvailable !== false || amount.rawAmount !== null) {
    throw malformedResponse("Helius returned inconsistent non-raw amount evidence.");
  }
  if ((reportedAmountType === "missing" || reportedAmountType === "null") && amount.reportedAmount !== null) {
    throw malformedResponse("Helius returned malformed unavailable amount evidence.");
  }
  return {
    ...reportedFields,
    rawAmount: null,
    exactRawAvailable: false,
    exactnessBasis: null,
    unavailableReason: reportedAmountType === "missing" || reportedAmountType === "null"
      ? "not_reported"
      : "provider_representation_not_exact",
    reportedAmountType,
  };
}

function normalizeObservation(
  observation: HeliusTransferObservation,
  mintAddress: string,
): SolanaHistoricalTransferObservation {
  if (
    observation === null ||
    typeof observation !== "object" ||
    typeof observation.signature !== "string" ||
    observation.signature.length === 0 ||
    !Number.isSafeInteger(observation.slot) ||
    observation.slot < 0
  ) {
    throw malformedResponse("Helius returned a malformed transfer observation.");
  }
  if (
    observation.blockTime !== undefined &&
    observation.blockTime !== null &&
    (!Number.isSafeInteger(observation.blockTime) || observation.blockTime < 0)
  ) {
    throw malformedResponse("Helius returned a malformed transfer block time.");
  }
  for (const value of [
    observation.type,
    observation.fromUserAccount,
    observation.toUserAccount,
    observation.fromTokenAccount,
    observation.toTokenAccount,
    observation.mint,
  ]) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw malformedResponse("Helius returned a malformed transfer field.");
    }
  }
  if (typeof observation.mint === "string" && observation.mint !== mintAddress) {
    throw malformedResponse("Helius returned a transfer for a different mint.");
  }

  const amount = normalizeAmount(observation.amount);
  const providerRecord = { ...observation, amount };
  const observedTime = observation.blockTime === undefined
    ? { status: "unavailable" as const, value: null, reason: "missing" as const }
    : observation.blockTime === null
      ? { status: "unavailable" as const, value: null, reason: "null" as const }
      : { status: "available" as const, unixSeconds: observation.blockTime, basis: "provider_reported" as const };
  return { providerRecord, observedTime };
}

function providerError(error: unknown): { category: string; message: string } {
  if (!(error instanceof HeliusTransferProviderError)) {
    return { category: "unexpected", message: "Unexpected historical provider execution failure." };
  }
  const safeMessages: Record<string, string> = {
    configuration: "Helius provider configuration is unavailable.",
    transport: error.message === "Helius transfer-history request timed out."
      ? "Helius transfer-history request timed out."
      : "Helius transfer-history transport request failed.",
    http: "Helius transfer-history HTTP request failed.",
    rpc: "Helius transfer-history RPC request failed.",
    malformed_response: "Helius returned a malformed transfer-history response.",
    pagination: "Helius transfer-history pagination failed.",
  };
  const category = Object.prototype.hasOwnProperty.call(safeMessages, error.category)
    ? error.category
    : "unexpected";
  return {
    category,
    message: safeMessages[category] ?? "Unexpected historical provider execution failure.",
  };
}

function blockTime(page: SolanaHistoricalTransferObservation): number | null {
  return page.observedTime.status === "available" ? page.observedTime.unixSeconds : null;
}

function pageEvidence(
  pageNumber: number,
  requestLimit: number,
  startRecordIndex: number,
  observations: SolanaHistoricalTransferObservation[],
  continuationTokenUsed: boolean,
  continuationTokenReturned: boolean,
): SolanaHistoricalPageEvidence {
  const usableTimes = observations.flatMap((observation) => {
    const value = blockTime(observation);
    return value === null ? [] : [value];
  });
  return {
    pageNumber,
    requestLimit,
    recordCount: observations.length,
    startRecordIndex,
    endRecordIndexExclusive: startRecordIndex + observations.length,
    continuationTokenUsed,
    continuationTokenReturned,
    firstUsableBlockTime: usableTimes[0] ?? null,
    lastUsableBlockTime: usableTimes.at(-1) ?? null,
    minimumUsableBlockTime: usableTimes.length === 0 ? null : Math.min(...usableTimes),
    maximumUsableBlockTime: usableTimes.length === 0 ? null : Math.max(...usableTimes),
    recordsWithoutUsableBlockTime: observations.length - usableTimes.length,
  };
}

function emptyProviderErrorEvidence(
  authorityAddress: string,
  requestCount: number,
  pages: SolanaHistoricalPageEvidence[],
  observations: SolanaHistoricalTransferObservation[],
  error: unknown,
): AuthorityRun {
  const safeError = providerError(error);
  return {
    evidence: {
      authorityAddress,
      queryStatus: "provider_error",
      paginationStatus: "not_applicable",
      terminalReason: "provider_error",
      requestCount,
      pages,
      observations,
      providerError: safeError,
    },
    requestCount,
    pagesReceived: pages.length,
    recordsReturned: observations.length,
    truncated: false,
    errorCategory: safeError.category,
  };
}

async function executeAuthority(
  plan: SolanaHistoricalQueryPlanVersioned,
  authorityAddress: string,
  requestTimeoutMs: number,
  fetchPage: HeliusHistoricalTransferPageFetcher,
  incrementTotalRequests: () => number,
): Promise<AuthorityRun> {
  let requestCount = 0;
  const pages: SolanaHistoricalPageEvidence[] = [];
  const observations: SolanaHistoricalTransferObservation[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    if (requestCount >= plan.maxPagesPerAuthority) {
      return {
        ...emptyProviderErrorEvidence(
          authorityAddress,
          requestCount,
          pages,
          observations,
          new HeliusTransferProviderError("pagination", "Historical page cap invariant was violated."),
        ),
        errorCategory: "execution_invariant",
      };
    }
    requestCount += 1;
    incrementTotalRequests();
    const requestLimit = Math.min(HELIUS_HISTORICAL_TRANSFER_PAGE_LIMIT, plan.maxRecordsPerAuthority - observations.length);
    let page: HeliusTransferPage;
    try {
      const request: GetHeliusTransferPageInput = {
        mintAddress: plan.mintAddress,
        ownerAuthority: authorityAddress,
        fromUnixSeconds: plan.requestedWindow.fromUnixSecondsInclusive,
        toUnixSecondsExclusive: plan.requestedWindow.toUnixSecondsExclusive,
        limit: requestLimit,
        paginationToken: cursor,
      };
      page = await fetchPage(request, requestTimeoutMs);
      if (
        page === null ||
        typeof page !== "object" ||
        !Array.isArray(page.observations) ||
        (page.paginationToken !== null && (typeof page.paginationToken !== "string" || page.paginationToken.length === 0)) ||
        page.observations.length > requestLimit
      ) {
        throw malformedResponse("Helius returned a malformed transfer-history page.");
      }
      if (observations.length + page.observations.length > plan.maxRecordsPerAuthority) {
        throw malformedResponse("Helius exceeded the planned per-authority record cap.");
      }
      const normalized = page.observations.map((observation) => normalizeObservation(observation, plan.mintAddress));
      if (page.paginationToken !== null && seenCursors.has(page.paginationToken)) {
        throw new HeliusTransferProviderError("pagination", "Helius repeated a transfer-history pagination token.");
      }
      const pageResult = pageEvidence(
        pages.length + 1,
        requestLimit,
        observations.length,
        normalized,
        cursor !== null,
        page.paginationToken !== null,
      );

      // Accept the page atomically only after all page-level validation succeeds.
      pages.push(pageResult);
      observations.push(...normalized);

      if (page.paginationToken === null) {
        return {
          evidence: {
            authorityAddress,
            queryStatus: "success",
            paginationStatus: "complete",
            terminalReason: "natural_termination",
            requestCount,
            pages,
            observations,
            providerError: null,
          },
          requestCount,
          pagesReceived: pages.length,
          recordsReturned: observations.length,
          truncated: false,
          errorCategory: null,
        };
      }
      seenCursors.add(page.paginationToken);

      const recordCapReached = observations.length >= plan.maxRecordsPerAuthority;
      const pageCapReached = requestCount >= plan.maxPagesPerAuthority;
      if (recordCapReached || pageCapReached) {
        const terminalReason = recordCapReached && pageCapReached
          ? "page_and_record_caps"
          : recordCapReached ? "record_cap" : "page_cap";
        return {
          evidence: {
            authorityAddress,
            queryStatus: "success",
            paginationStatus: "truncated",
            terminalReason,
            requestCount,
            pages,
            observations,
            providerError: null,
          },
          requestCount,
          pagesReceived: pages.length,
          recordsReturned: observations.length,
          truncated: true,
          errorCategory: null,
        };
      }
      cursor = page.paginationToken;
    } catch (error: unknown) {
      return emptyProviderErrorEvidence(authorityAddress, requestCount, pages, observations, error);
    }
  }
}

export async function executeSolanaHistoricalQueryPlan(
  plan: SolanaHistoricalQueryPlanVersioned,
  options: ExecuteSolanaHistoricalQueryPlanOptions,
): Promise<SolanaHistoricalQueryExecutionResult> {
  assertPlan(plan);
  if (!positiveSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("requestTimeoutMs must be a positive safe integer within the supported timer range.");
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const fetchedAt = new Date(startedAt).toISOString();
  const fetchPage = options.fetchPage ?? getHeliusHistoricalTransferPage;
  const selectedInPlanOrder = plan.candidateAuthorities
    .filter((candidate) => candidate.plannedDisposition.status === "selected")
    .sort((left, right) =>
      left.plannedDisposition.status === "selected" && right.plannedDisposition.status === "selected"
        ? left.plannedDisposition.selectionPosition - right.plannedDisposition.selectionPosition
        : 0);
  const selectedRuns = new Map<string, AuthorityRun>();
  let totalRequestCount = 0;

  for (const candidate of selectedInPlanOrder) {
    const run = await executeAuthority(
      plan,
      candidate.authorityAddress,
      options.requestTimeoutMs,
      fetchPage,
      () => {
        if (totalRequestCount >= plan.maximumProviderRequests) {
          throw new Error("Execution would exceed the validated plan request bound.");
        }
        totalRequestCount += 1;
        return totalRequestCount;
      },
    );
    selectedRuns.set(candidate.authorityAddress, run);
  }

  const authorities: SolanaHistoricalAuthorityEvidence[] = plan.candidateAuthorities.map((candidate) => {
    if (candidate.plannedDisposition.status === "not_selected") {
      return {
        authorityAddress: candidate.authorityAddress,
        queryStatus: "not_queried",
        reason: "not_selected",
        paginationStatus: "not_applicable",
        terminalReason: "not_queried",
        requestCount: 0,
        pages: [],
        observations: [],
        providerError: null,
      };
    }
    const run = selectedRuns.get(candidate.authorityAddress);
    if (!run) throw new Error("A selected plan authority did not produce an execution result.");
    return run.evidence;
  });

  const failedAuthorityCount = authorities.filter((authority) => authority.queryStatus === "provider_error").length;
  const completedAuthorityCount = authorities.filter((authority) => authority.queryStatus === "success").length;
  const truncatedAuthorityCount = authorities.filter((authority) =>
    authority.queryStatus === "success" && authority.paginationStatus === "truncated").length;
  const pagesReceived = authorities.reduce((sum, authority) => sum + authority.pages.length, 0);
  const recordsReturned = authorities.reduce((sum, authority) => sum + authority.observations.length, 0);
  const sanitizedErrorCounts: Record<string, number> = {};
  for (const run of selectedRuns.values()) {
    if (run.errorCategory !== null) {
      sanitizedErrorCounts[run.errorCategory] = (sanitizedErrorCounts[run.errorCategory] ?? 0) + 1;
    }
  }
  const endedAt = now();
  const candidateSetCompleteness = plan.planVersion === "solana-bounded-history-query-plan-v2"
    ? plan.sourceHolder.candidateFrameCompleteness
    : plan.sourceHolder.enumeration.completeness === "complete" && plan.sourceHolder.amountCoverage.state === "complete"
      ? "complete" as const
      : "partial" as const;

  return {
    plan,
    evidence: {
      chain: "solana",
      mintAddress: plan.mintAddress,
      provenance: {
        provider: "helius",
        method: "getTransfersByAddress",
        fetchedAt,
        requestedWindow: { ...plan.requestedWindow },
        maxAuthorities: plan.sourceSelection.configuredMaximumSelectedAuthorityCount,
        maxPagesPerAuthority: plan.maxPagesPerAuthority,
        maxRecordsPerAuthority: plan.maxRecordsPerAuthority,
      },
      authorityScope: {
        source: "holder_snapshot",
        candidateAuthorityCount: plan.sourceHolder.candidateAuthorityCount,
        candidateSetCompleteness,
      },
      authorities,
      applicationDerivedEvidence: { status: "not_calculated", metrics: null },
    },
    telemetry: {
      selectedAuthorityCount: plan.selectedAuthorityCount,
      attemptedAuthorityCount: [...selectedRuns.values()].filter((run) => run.requestCount > 0).length,
      completedAuthorityCount,
      failedAuthorityCount,
      requestCount: totalRequestCount,
      pagesReceived,
      recordsReturned,
      truncatedAuthorityCount,
      sanitizedErrorCounts,
      elapsedMs: Math.max(0, endedAt - startedAt),
      creditUsage: { status: "unknown", credits: null, reason: "provider_usage_not_observed" },
    },
  };
}
