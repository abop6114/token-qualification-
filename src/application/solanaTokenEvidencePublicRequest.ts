import type { GenerateSolanaTokenEvidenceReportRequest } from "../types/solanaTokenEvidenceReport";
import type { SolanaTokenEvidencePublicRequestErrorCategory } from "../types/solanaTokenEvidencePublicRequest";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const SAFE_ERROR_MESSAGES: Record<SolanaTokenEvidencePublicRequestErrorCategory, string> = {
  invalid_request_shape: "The public evidence request shape is invalid.",
  unsupported_chain: "Only the solana chain is currently supported.",
  invalid_asset_address: "A valid Solana public-key address is required.",
  invalid_historical_request: "The public historical request is invalid.",
};

/** Safe, transport-neutral validation error; it contains no input or provider data. */
export class SolanaTokenEvidencePublicRequestError extends Error {
  constructor(readonly category: SolanaTokenEvidencePublicRequestErrorCategory) {
    super(SAFE_ERROR_MESSAGES[category]);
    this.name = "SolanaTokenEvidencePublicRequestError";
  }
}

type PlainRecord = Record<string, unknown>;

/** Copies own enumerable data properties without invoking input getters. */
function plainRecord(value: unknown): PlainRecord | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const record = Object.create(null) as PlainRecord;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function hasExactKeys(record: PlainRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalid(category: SolanaTokenEvidencePublicRequestErrorCategory): never {
  throw new SolanaTokenEvidencePublicRequestError(category);
}

function parseHistory(value: unknown): GenerateSolanaTokenEvidenceReportRequest["historicalTransactions"] {
  const history = plainRecord(value);
  if (history === null || typeof history.status !== "string") {
    return invalid("invalid_historical_request");
  }

  if (history.status === "not_requested") {
    if (!hasExactKeys(history, ["status"])) return invalid("invalid_historical_request");
    return { status: "not_requested" };
  }

  if (history.status !== "requested" || !hasExactKeys(history, [
    "status", "startTimeUnixSeconds", "endTimeUnixSecondsExclusive",
  ])) {
    return invalid("invalid_historical_request");
  }

  const start = history.startTimeUnixSeconds;
  const end = history.endTimeUnixSecondsExclusive;
  if (!Number.isSafeInteger(start) || (start as number) < 0 ||
      !Number.isSafeInteger(end) || (end as number) <= (start as number)) {
    return invalid("invalid_historical_request");
  }

  return {
    status: "requested",
    requestedWindow: {
      fromUnixSecondsInclusive: start as number,
      toUnixSecondsExclusive: end as number,
    },
  };
}

/** Validates public input and maps it to the existing internal report request. */
export function parseSolanaTokenEvidencePublicRequest(
  input: unknown,
): GenerateSolanaTokenEvidenceReportRequest {
  const request = plainRecord(input);
  if (request === null || !Object.hasOwn(request, "chain") || !Object.hasOwn(request, "assetAddress") ||
      !hasExactKeys(request, Object.hasOwn(request, "historicalTransactions")
        ? ["chain", "assetAddress", "historicalTransactions"]
        : ["chain", "assetAddress"])) {
    return invalid("invalid_request_shape");
  }

  if (request.chain !== "solana") return invalid("unsupported_chain");
  if (typeof request.assetAddress !== "string" || !isSolanaPublicKeySyntax(request.assetAddress)) {
    return invalid("invalid_asset_address");
  }

  const historicalTransactions = Object.hasOwn(request, "historicalTransactions")
    ? parseHistory(request.historicalTransactions)
    : { status: "not_requested" as const };

  return {
    chain: "solana",
    assetAddress: request.assetAddress,
    historicalTransactions,
  };
}
