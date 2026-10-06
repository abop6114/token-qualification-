import {
  getGoldRushHolderPage,
  getGoldRushProviderChainSlug,
  GoldRushHolderProviderError,
} from "../providers/evm/goldRushHolders";
import { EvmHolderNormalizationError, normalizeEvmHolderBlockInput, normalizeGoldRushHolderPage } from "../normalization/evmHolders";
import { normalizeEvmAddress } from "../validation/evmAddress";
import type {
  EvmHolderCoverage,
  EvmHolderEvidence,
  EvmHolderEvidenceExecutionResult,
  EvmHolderEvidenceTelemetry,
  EvmHolderFailureEvidence,
  EvmHolderPageEvidence,
  EvmHolderTerminalReason,
} from "../types/evmHolders";
import type { EvmChain } from "../types/evmToken";

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ExecuteEvmHolderEvidenceOptions {
  maxPages: number;
  maxRecords: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1_000) / 1_000);
}

function failureFor(error: unknown): EvmHolderFailureEvidence {
  if (error instanceof EvmHolderNormalizationError) {
    return { category: "malformed_response", httpStatus: null, message: "GoldRush response was malformed." };
  }
  if (error instanceof GoldRushHolderProviderError) {
    const category = error.category === "configuration" || error.category === "transport"
      || error.category === "http" || error.category === "provider" || error.category === "malformed_response"
      ? error.category
      : "transport";
    const message = category === "configuration" ? "GoldRush configuration is invalid or missing."
      : category === "transport" ? "GoldRush request failed."
        : category === "http" ? "GoldRush HTTP request failed."
          : category === "provider" ? "GoldRush reported a provider error."
            : "GoldRush response was malformed.";
    return {
      category,
      httpStatus: Number.isSafeInteger(error.httpStatus) && error.httpStatus !== null && error.httpStatus >= 100 && error.httpStatus <= 599
        ? error.httpStatus
        : null,
      message,
    };
  }
  return { category: "transport", httpStatus: null, message: "GoldRush request failed." };
}

function coverageAndTerminal(
  failure: EvmHolderFailureEvidence | null,
  hasAcceptedPage: boolean,
  capReason: "page_cap" | "record_cap" | "page_and_record_caps" | null,
): { coverage: EvmHolderCoverage; terminalReason: EvmHolderTerminalReason } {
  if (capReason !== null) return { coverage: { status: "partial", reason: "resource_limited" }, terminalReason: capReason };
  if (failure === null) return { coverage: { status: "provider_complete" }, terminalReason: "natural_termination" };
  const terminalReason = failure.category === "malformed_response" ? "malformed_response" : "provider_error";
  if (!hasAcceptedPage && failure.category === "malformed_response") {
    return { coverage: { status: "malformed", reason: "malformed_response" }, terminalReason };
  }
  if (!hasAcceptedPage) return { coverage: { status: "unavailable", reason: "provider_error" }, terminalReason };
  return {
    coverage: { status: "partial", reason: terminalReason },
    terminalReason,
  };
}

function validateBounds(options: ExecuteEvmHolderEvidenceOptions): void {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages <= 0) {
    throw new Error("maxPages must be a finite positive safe integer.");
  }
  if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords <= 0) {
    throw new Error("maxRecords must be a finite positive safe integer.");
  }
}

/** Fetches one bounded, sequential GoldRush holder snapshot; it does not infer economic ownership. */
export async function executeEvmHolderEvidence(
  chain: EvmChain,
  submittedAddress: string,
  requestedObservationBlock: string,
  options: ExecuteEvmHolderEvidenceOptions,
): Promise<EvmHolderEvidenceExecutionResult> {
  if (chain !== "base" && chain !== "ethereum") throw new Error("An explicit supported EVM chain (base or ethereum) is required.");
  const tokenContractAddress = normalizeEvmAddress(submittedAddress);
  if (tokenContractAddress === null) throw new Error("A 0x-prefixed 20-byte EVM contract address is required.");
  const requestedBlock = normalizeEvmHolderBlockInput(requestedObservationBlock);
  if (requestedBlock === null) throw new Error("requestedObservationBlock must be a canonical nonnegative decimal string.");
  validateBounds(options);

  const started = performance.now();
  const providerChainSlug = getGoldRushProviderChainSlug(chain);
  const timeoutMs = options.timeoutMs;
  const counts = {
    providerRequestCount: 0,
    pagesRequested: 0,
    pagesReturned: 0,
    providerRecordsReturned: 0 as number | null,
    recordsRetained: 0,
  };
  const holders: EvmHolderEvidence["holders"] = [];
  let rawRecordsProcessed = 0;
  const holderByAddress = new Map<string, string>();
  const pages: EvmHolderPageEvidence[] = [];
  let providerReportedHolderCount: string | null = null;
  let providerReportedPageSize: number | null = null;
  let providerHasMore: boolean | null = null;
  let providerReportedObservationBlock: string | null = null;
  let failure: EvmHolderFailureEvidence | null = null;
  let capReason: "page_cap" | "record_cap" | "page_and_record_caps" | null = null;

  if (!isGoldRushConfigured()) {
    failure = failureFor(new GoldRushHolderProviderError("configuration", "GOLDRUSH_API_KEY is not configured."));
  } else if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    failure = failureFor(new GoldRushHolderProviderError("configuration", "GoldRush request timeout is invalid."));
  } else {
    for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
      let rawData: unknown;
      try {
        rawData = await getGoldRushHolderPage({
          chain,
          tokenAddress: tokenContractAddress,
          blockHeight: requestedBlock,
          pageNumber,
          pageSize: 100,
          timeoutMs,
        }, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          onRequestStart: () => {
            counts.providerRequestCount += 1;
            counts.pagesRequested += 1;
          },
        });
      } catch (error: unknown) {
        failure = failureFor(error);
        break;
      }

      counts.pagesReturned += 1;
      if (typeof rawData === "object" && rawData !== null && "items" in rawData && Array.isArray((rawData as { items?: unknown }).items)) {
        if (counts.providerRecordsReturned !== null) counts.providerRecordsReturned += (rawData as { items: unknown[] }).items.length;
      } else {
        counts.providerRecordsReturned = null;
      }

      let page;
      try {
        page = normalizeGoldRushHolderPage(rawData, {
          chainSlug: providerChainSlug,
          tokenAddress: tokenContractAddress,
          requestedPageNumber: pageNumber,
          maxRecordsToNormalize: options.maxRecords - rawRecordsProcessed,
        });

        if (page.providerReportedHolderCount !== null && providerReportedHolderCount !== null
          && page.providerReportedHolderCount !== providerReportedHolderCount) {
          throw new EvmHolderNormalizationError();
        }
        if (page.providerReportedObservationBlock !== null && providerReportedObservationBlock !== null
          && page.providerReportedObservationBlock !== providerReportedObservationBlock) {
          throw new EvmHolderNormalizationError();
        }

        // Validate the entire page transactionally before accepting any of its rows.
        const newRows = new Map<string, string>();
        for (const holder of page.holders) {
          const prior = newRows.get(holder.address) ?? holderByAddress.get(holder.address);
          if (prior !== undefined) {
            if (prior !== holder.rawBalance) throw new EvmHolderNormalizationError();
            continue;
          }
          newRows.set(holder.address, holder.rawBalance);
        }
        const remaining = options.maxRecords - rawRecordsProcessed;
        const recordLimitOverflow = page.providerRecordsReturned > remaining;
        const acceptedRows = [...newRows.entries()];
        for (const [address, rawBalance] of acceptedRows) {
          holderByAddress.set(address, rawBalance);
          holders.push({ address, rawBalance });
        }
        rawRecordsProcessed += page.holders.length;

        if (page.providerReportedHolderCount !== null) providerReportedHolderCount = page.providerReportedHolderCount;
        if (page.providerReportedObservationBlock !== null) providerReportedObservationBlock = page.providerReportedObservationBlock;
        providerReportedPageSize = page.providerPageSize;
        providerHasMore = page.providerHasMore;
        pages.push({
          requestedPageNumber: page.requestedPageNumber,
          providerRecordsReturned: page.providerRecordsReturned,
          recordsRetained: acceptedRows.length,
          providerReportedPageSize: page.providerPageSize,
          providerHasMore: page.providerHasMore,
        });

        if (recordLimitOverflow) {
          const pageCapReached = pages.length >= options.maxPages && page.providerHasMore;
          capReason = pageCapReached ? "page_and_record_caps" : "record_cap";
          break;
        }
        if (!page.providerHasMore) break;
        const pageCapReached = pages.length >= options.maxPages;
        const recordCapReached = rawRecordsProcessed >= options.maxRecords;
        if (pageCapReached || recordCapReached) {
          capReason = pageCapReached && recordCapReached ? "page_and_record_caps"
            : pageCapReached ? "page_cap" : "record_cap";
          break;
        }
      } catch (error: unknown) {
        failure = failureFor(error);
        break;
      }
    }
  }

  // If the loop ended at its finite page bound while more pages remain, no extra request is made.
  if (failure === null && capReason === null && providerHasMore === true && pages.length >= options.maxPages) {
    const recordCapReached = rawRecordsProcessed >= options.maxRecords;
    capReason = recordCapReached ? "page_and_record_caps" : "page_cap";
  }

  const completion = coverageAndTerminal(failure, pages.length > 0, capReason);
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const positiveCount = holders.reduce((count, holder) => count + (BigInt(holder.rawBalance) > 0n ? 1 : 0), 0);
  const evidence: EvmHolderEvidence = {
    schemaVersion: "evm-holder-evidence-v1",
    chain,
    tokenContractAddress,
    provenance: {
      chain,
      provider: "goldrush",
      providerChainSlug,
      tokenContractAddress,
      requestedObservationBlock: requestedBlock,
      providerReportedObservationBlock,
      providerBlockRelation: providerReportedObservationBlock === null ? "not_reported"
        : providerReportedObservationBlock === requestedBlock ? "match" : "mismatch",
      fetchedAt,
    },
    holders,
    providerReportedHolderCount,
    observedHolderRecordCount: holders.length,
    observedPositiveBalanceAddressCount: positiveCount,
    pagination: {
      maxPages: options.maxPages,
      maxRecords: options.maxRecords,
      requestedPageSize: 100,
      pagesRequested: counts.pagesRequested,
      pagesReturned: counts.pagesReturned,
      providerRecordsReturned: counts.providerRecordsReturned,
      recordsRetained: holders.length,
      providerReportedHolderCount,
      providerReportedPageSize,
      providerHasMore,
      terminalReason: completion.terminalReason,
      pages,
    },
    coverage: completion.coverage,
    failure,
  };
  const telemetry: EvmHolderEvidenceTelemetry = {
    ...counts,
    recordsRetained: holders.length,
    elapsedMs: elapsedMs(started),
  };
  return { evidence, telemetry };
}

function isGoldRushConfigured(): boolean {
  const key = process.env.GOLDRUSH_API_KEY;
  return key !== undefined && key.trim() !== "";
}
