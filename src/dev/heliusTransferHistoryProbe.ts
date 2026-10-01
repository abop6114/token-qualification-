import {
  getHeliusTransferPage,
  HeliusTransferProviderError,
  type HeliusTransferErrorCategory,
  type HeliusTransferObservation,
} from "../providers/solana/heliusTransfersByAddress";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

export interface HeliusTransferHistoryProbeInput {
  mintAddress: string;
  ownerAuthorities: string[];
  fromUnixSeconds: number;
  toUnixSecondsExclusive: number;
  maxPagesPerOwner: number;
  maxRecordsPerOwner: number;
}

export type ProbeTerminalStatus = "success_with_records" | "success_empty" | "provider_error";
export type ProbePaginationStatus = "complete" | "truncated" | "not_applicable";
export type ProbeTerminalReason =
  | "natural_termination"
  | "page_cap"
  | "record_cap"
  | "page_and_record_caps"
  | "provider_error";

export interface ProbePageTelemetry {
  pageNumber: number;
  requestLimit: number;
  recordCount: number;
  startRecordIndex: number;
  endRecordIndexExclusive: number;
  continuationTokenUsed: boolean;
  continuationTokenReturned: boolean;
  firstUsableBlockTime: number | null;
  lastUsableBlockTime: number | null;
  minimumUsableBlockTime: number | null;
  maximumUsableBlockTime: number | null;
  recordsWithoutUsableBlockTime: number;
}

export interface ProbeOwnerResult {
  queriedOwnerAuthority: string;
  requestCount: number;
  pageCount: number;
  recordsReturned: number;
  durationMs: number;
  terminalStatus: ProbeTerminalStatus;
  paginationStatus: ProbePaginationStatus;
  terminalReason: ProbeTerminalReason;
  continuationCursorPresent: boolean;
  providerError: { category: HeliusTransferErrorCategory | "unexpected"; message: string } | null;
  pages: ProbePageTelemetry[];
  transfers: HeliusTransferObservation[];
}

export interface HeliusTransferHistoryProbeResult {
  provider: "helius";
  method: "getTransfersByAddress";
  queriedMint: string;
  query: {
    fromUnixSeconds: number;
    toUnixSecondsExclusive: number;
    direction: "any";
  };
  limits: {
    maxPagesPerOwner: number;
    maxRecordsPerOwner: number;
    providerMaximumPageSize: 100;
  };
  runTelemetry: {
    requestedOwnerCount: number;
    /** Owners reaching a success or cap-truncated terminal result; provider failures are excluded. */
    completedOwnerCount: number;
    failedOwnerCount: number;
    totalRequestCount: number;
    totalPagesRequested: number;
    totalPagesReceived: number;
    totalRecordsReturned: number;
    totalElapsedMs: number;
    anyQueryTruncated: boolean;
    creditUsage: {
      status: "unknown";
      credits: null;
      reason: "provider_usage_not_observed_and_no_verified_rate_card_supplied";
    };
  };
  owners: ProbeOwnerResult[];
}

const PROVIDER_PAGE_SIZE = 100;

function assertProbeInput(input: HeliusTransferHistoryProbeInput): void {
  if (!isSolanaPublicKeySyntax(input.mintAddress)) {
    throw new Error("A valid Solana mint address is required.");
  }
  if (!Array.isArray(input.ownerAuthorities) || input.ownerAuthorities.length === 0) {
    throw new Error("At least one explicit owner authority is required.");
  }
  const seen = new Set<string>();
  for (const owner of input.ownerAuthorities) {
    if (!isSolanaPublicKeySyntax(owner)) throw new Error("Every owner authority must be a valid Solana public key.");
    if (seen.has(owner)) throw new Error("Duplicate owner authorities are not allowed.");
    seen.add(owner);
  }
  if (
    !Number.isSafeInteger(input.fromUnixSeconds) || input.fromUnixSeconds < 0 ||
    !Number.isSafeInteger(input.toUnixSecondsExclusive) || input.toUnixSecondsExclusive <= input.fromUnixSeconds
  ) {
    throw new Error("A valid bounded Unix time window is required (from inclusive, to exclusive).");
  }
  if (!Number.isSafeInteger(input.maxPagesPerOwner) || input.maxPagesPerOwner < 1) {
    throw new Error("maxPagesPerOwner must be an explicitly supplied positive safe integer.");
  }
  if (!Number.isSafeInteger(input.maxRecordsPerOwner) || input.maxRecordsPerOwner < 1) {
    throw new Error("maxRecordsPerOwner must be an explicitly supplied positive safe integer.");
  }
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}

async function queryOwner(
  input: HeliusTransferHistoryProbeInput,
  ownerAuthority: string,
  fetchImpl: typeof fetch,
): Promise<ProbeOwnerResult> {
  const started = performance.now();
  const transfers: HeliusTransferObservation[] = [];
  const pages: ProbePageTelemetry[] = [];
  const seenCursors = new Set<string>();
  let requestCount = 0;
  let pageCount = 0;
  let paginationToken: string | null = null;

  try {
    for (;;) {
      const remainingRecords = input.maxRecordsPerOwner - transfers.length;
      const limit = Math.min(PROVIDER_PAGE_SIZE, remainingRecords);
      requestCount += 1;
      const page = await getHeliusTransferPage({
        mintAddress: input.mintAddress,
        ownerAuthority,
        fromUnixSeconds: input.fromUnixSeconds,
        toUnixSecondsExclusive: input.toUnixSecondsExclusive,
        limit,
        paginationToken,
      }, fetchImpl);
      pageCount += 1;
      const pageStartRecordIndex = transfers.length;
      const usableBlockTimes = page.observations.flatMap((observation) =>
        typeof observation.blockTime === "number" ? [observation.blockTime] : []);
      pages.push({
        pageNumber: pageCount,
        requestLimit: limit,
        recordCount: page.observations.length,
        startRecordIndex: pageStartRecordIndex,
        endRecordIndexExclusive: pageStartRecordIndex + page.observations.length,
        continuationTokenUsed: paginationToken !== null,
        continuationTokenReturned: page.paginationToken !== null,
        firstUsableBlockTime: usableBlockTimes[0] ?? null,
        lastUsableBlockTime: usableBlockTimes[usableBlockTimes.length - 1] ?? null,
        minimumUsableBlockTime: usableBlockTimes.length > 0 ? Math.min(...usableBlockTimes) : null,
        maximumUsableBlockTime: usableBlockTimes.length > 0 ? Math.max(...usableBlockTimes) : null,
        recordsWithoutUsableBlockTime: page.observations.length - usableBlockTimes.length,
      });
      transfers.push(...page.observations);

      if (page.paginationToken === null) {
        return {
          queriedOwnerAuthority: ownerAuthority,
          requestCount,
          pageCount,
          recordsReturned: transfers.length,
          durationMs: elapsedMs(started),
          terminalStatus: transfers.length > 0 ? "success_with_records" : "success_empty",
          paginationStatus: "complete",
          terminalReason: "natural_termination",
          continuationCursorPresent: false,
          providerError: null,
          pages,
          transfers,
        };
      }

      if (seenCursors.has(page.paginationToken)) {
        throw new HeliusTransferProviderError("pagination", "Helius repeated a transfer-history pagination token.");
      }
      seenCursors.add(page.paginationToken);

      const recordCapReached = transfers.length >= input.maxRecordsPerOwner;
      const pageCapReached = pageCount >= input.maxPagesPerOwner;
      if (recordCapReached || pageCapReached) {
        return {
          queriedOwnerAuthority: ownerAuthority,
          requestCount,
          pageCount,
          recordsReturned: transfers.length,
          durationMs: elapsedMs(started),
          terminalStatus: transfers.length > 0 ? "success_with_records" : "success_empty",
          paginationStatus: "truncated",
          terminalReason: recordCapReached && pageCapReached
            ? "page_and_record_caps"
            : recordCapReached ? "record_cap" : "page_cap",
          continuationCursorPresent: true,
          providerError: null,
          pages,
          transfers,
        };
      }
      paginationToken = page.paginationToken;
    }
  } catch (error: unknown) {
    const providerError = error instanceof HeliusTransferProviderError
      ? { category: error.category, message: error.message }
      : { category: "unexpected" as const, message: "Unexpected transfer-history probe failure." };
    return {
      queriedOwnerAuthority: ownerAuthority,
      requestCount,
      pageCount,
      recordsReturned: transfers.length,
      durationMs: elapsedMs(started),
      terminalStatus: "provider_error",
      paginationStatus: "not_applicable",
      terminalReason: "provider_error",
      continuationCursorPresent: false,
      providerError,
      pages,
      transfers,
    };
  }
}

export async function runHeliusTransferHistoryProbe(
  input: HeliusTransferHistoryProbeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<HeliusTransferHistoryProbeResult> {
  assertProbeInput(input);
  const started = performance.now();
  // Sequential per-owner calls keep this development probe's fanout explicit and bounded.
  const owners: ProbeOwnerResult[] = [];
  for (const ownerAuthority of input.ownerAuthorities) {
    owners.push(await queryOwner(input, ownerAuthority, fetchImpl));
  }

  const failedOwnerCount = owners.filter((owner) => owner.terminalStatus === "provider_error").length;
  return {
    provider: "helius",
    method: "getTransfersByAddress",
    queriedMint: input.mintAddress,
    query: {
      fromUnixSeconds: input.fromUnixSeconds,
      toUnixSecondsExclusive: input.toUnixSecondsExclusive,
      direction: "any",
    },
    limits: {
      maxPagesPerOwner: input.maxPagesPerOwner,
      maxRecordsPerOwner: input.maxRecordsPerOwner,
      providerMaximumPageSize: PROVIDER_PAGE_SIZE,
    },
    runTelemetry: {
      requestedOwnerCount: owners.length,
      completedOwnerCount: owners.length - failedOwnerCount,
      failedOwnerCount,
      totalRequestCount: owners.reduce((sum, owner) => sum + owner.requestCount, 0),
      totalPagesRequested: owners.reduce((sum, owner) => sum + owner.requestCount, 0),
      totalPagesReceived: owners.reduce((sum, owner) => sum + owner.pageCount, 0),
      totalRecordsReturned: owners.reduce((sum, owner) => sum + owner.recordsReturned, 0),
      totalElapsedMs: elapsedMs(started),
      anyQueryTruncated: owners.some((owner) => owner.paginationStatus === "truncated"),
      creditUsage: {
        status: "unknown",
        credits: null,
        reason: "provider_usage_not_observed_and_no_verified_rate_card_supplied",
      },
    },
    owners,
  };
}

function parseIntegerArgument(value: string | undefined, name: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be explicitly supplied as a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range.`);
  return parsed;
}

function parseCliArguments(args: string[]): HeliusTransferHistoryProbeInput {
  const values = new Map<string, string>();
  const owners: string[] = [];
  const repeatable = new Set(["--owner"]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Invalid probe arguments. Supply --mint, one or more --owner flags, --from-unix, --to-unix-exclusive, --max-pages-per-owner, and --max-records-per-owner.");
    }
    if (repeatable.has(flag)) {
      owners.push(value);
    } else {
      if (values.has(flag)) throw new Error("Probe arguments may not be repeated except for --owner.");
      values.set(flag, value);
    }
    index += 1;
  }

  const allowed = new Set([
    "--mint", "--from-unix", "--to-unix-exclusive", "--max-pages-per-owner", "--max-records-per-owner",
  ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error("An unsupported probe argument was supplied.");
  }
  const mintAddress = values.get("--mint");
  if (mintAddress === undefined) throw new Error("--mint is required.");
  const required = ["--from-unix", "--to-unix-exclusive", "--max-pages-per-owner", "--max-records-per-owner"];
  if (required.some((flag) => !values.has(flag))) throw new Error("All time-window and pagination/record caps are required.");

  return {
    mintAddress,
    ownerAuthorities: owners,
    fromUnixSeconds: parseIntegerArgument(values.get("--from-unix"), "--from-unix"),
    toUnixSecondsExclusive: parseIntegerArgument(values.get("--to-unix-exclusive"), "--to-unix-exclusive"),
    maxPagesPerOwner: parseIntegerArgument(values.get("--max-pages-per-owner"), "--max-pages-per-owner"),
    maxRecordsPerOwner: parseIntegerArgument(values.get("--max-records-per-owner"), "--max-records-per-owner"),
  };
}

async function main(): Promise<void> {
  try {
    const input = parseCliArguments(process.argv.slice(2));
    const result = await runHeliusTransferHistoryProbe(input);
    console.log(JSON.stringify(result));
    if (result.runTelemetry.failedOwnerCount > 0) process.exitCode = 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid transfer-history probe request.";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
