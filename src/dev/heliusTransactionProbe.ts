import {
  getHeliusTransaction,
  HeliusTransactionProviderError,
  type HeliusTransactionErrorCategory,
} from "../providers/solana/heliusTransaction";
import { isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";

type JsonObject = Record<string, unknown>;
type JsonType = "array" | "boolean" | "null" | "number" | "object" | "string" | "undefined";
type FieldState = "array" | "malformed" | "not_observable" | "null" | "omitted";

export interface HeliusTransactionProbeInput {
  signature: string;
}

export type HeliusTransactionProbeStatus = "returned" | "provider_result_null" | "provider_error";

export interface HeliusTransactionProbeError {
  category: HeliusTransactionErrorCategory | "signature_mismatch" | "unexpected";
  rpcCode: number | null;
  httpStatus: number | null;
  message: string;
}

export interface HeliusTransactionProbeResult {
  provider: "helius";
  request: {
    requestedSignature: string;
    method: "getTransaction";
    encoding: "json";
    maxSupportedTransactionVersion: 1;
    requestCount: number;
  };
  elapsedMs: number;
  status: HeliusTransactionProbeStatus;
  error: HeliusTransactionProbeError | null;
  transaction: HeliusTransactionSummary | null;
}

export interface HeliusTransactionSummary {
  slot: { status: "available"; value: number } | { status: "unavailable"; reason: "missing_or_invalid" };
  blockTime: { status: "available"; value: number } | {
    status: "unavailable";
    reason: "null" | "missing_or_invalid";
  };
  version: {
    status: "present" | "omitted";
    jsonType: JsonType;
    value: string | number | boolean | null;
  };
  meta: {
    state: "present" | "null" | "omitted" | "malformed";
    errorState: "null" | "non_null" | "omitted" | "not_applicable";
  };
  signatures: {
    count: number | null;
    requestedSignatureMatchesFirstPosition: boolean | null;
  };
  accounts: {
    staticAccountKeyState: FieldState;
    staticAccountKeyCount: number | null;
  loadedAddressesState: "present" | "null" | "omitted" | "malformed" | "not_observable";
    loadedWritableAddressCount: number | null;
    loadedReadonlyAddressCount: number | null;
    totalResolvableAccountCount: number | null;
  };
  instructions: {
    outerInstructionCount: number | null;
    innerInstructionGroupCount: number | null;
    innerInstructionCount: number | null;
    observedProgramIdIndexValues: number[];
    observedAccountIndexValues: number[];
    malformedIndexCount: number;
    indexResolution: "resolved" | "unresolved" | "not_checkable";
  };
  tokenBalances: {
    pre: TokenBalanceSummary;
    post: TokenBalanceSummary;
  };
  solBalances: {
    pre: SolBalanceSummary;
    post: SolBalanceSummary;
  };
}

export interface TokenBalanceSummary {
  state: FieldState;
  entryCount: number | null;
  accountIndexJsonTypes: TypeCount[];
  accountIndexValues: number[];
  mintJsonTypes: TypeCount[];
  ownerJsonTypes: TypeCount[];
  uiTokenAmountJsonTypes: TypeCount[];
  amountJsonTypes: TypeCount[];
  decimalsJsonTypes: TypeCount[];
  uiAmountJsonTypes: TypeCount[];
  uiAmountStringJsonTypes: TypeCount[];
  exactRawAmountCandidateCount: number | null;
}

export interface SolBalanceSummary {
  state: FieldState;
  entryCount: number | null;
  elementJsonTypes: TypeCount[];
}

export interface TypeCount {
  type: string;
  count: number;
}

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "undefined") return "undefined";
  return typeof value as Exclude<JsonType, "array" | "null" | "object" | "undefined">;
}

function counts(types: string[]): TypeCount[] {
  const grouped = new Map<string, number>();
  for (const type of types) grouped.set(type, (grouped.get(type) ?? 0) + 1);
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

function fieldState(parent: JsonObject, key: string): FieldState {
  if (!hasOwn(parent, key)) return "omitted";
  if (parent[key] === null) return "null";
  if (!Array.isArray(parent[key])) return "malformed";
  return "array";
}

function safeIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function summarizeTokenBalances(meta: JsonObject, key: string): TokenBalanceSummary {
  const state = fieldState(meta, key);
  if (state !== "array") {
    return {
      state,
      entryCount: null,
      accountIndexJsonTypes: [],
      accountIndexValues: [],
      mintJsonTypes: [],
      ownerJsonTypes: [],
      uiTokenAmountJsonTypes: [],
      amountJsonTypes: [],
      decimalsJsonTypes: [],
      uiAmountJsonTypes: [],
      uiAmountStringJsonTypes: [],
      exactRawAmountCandidateCount: null,
    };
  }

  const entries = meta[key] as unknown[];
  const accountIndexTypes: string[] = [];
  const accountIndexValues: number[] = [];
  const mintTypes: string[] = [];
  const ownerTypes: string[] = [];
  const uiTokenAmountTypes: string[] = [];
  const amountTypes: string[] = [];
  const decimalsTypes: string[] = [];
  const uiAmountTypes: string[] = [];
  const uiAmountStringTypes: string[] = [];
  let exactRawAmountCandidateCount = 0;

  for (const entry of entries) {
    if (!isJsonObject(entry)) {
      accountIndexTypes.push("unavailable_entry");
      mintTypes.push("unavailable_entry");
      ownerTypes.push("unavailable_entry");
      uiTokenAmountTypes.push("unavailable_entry");
      amountTypes.push("unavailable_entry");
      decimalsTypes.push("unavailable_entry");
      uiAmountTypes.push("unavailable_entry");
      uiAmountStringTypes.push("unavailable_entry");
      continue;
    }

    accountIndexTypes.push(hasOwn(entry, "accountIndex") ? jsonType(entry.accountIndex) : "omitted");
    if (safeIndex(entry.accountIndex)) accountIndexValues.push(entry.accountIndex);
    mintTypes.push(hasOwn(entry, "mint") ? jsonType(entry.mint) : "omitted");
    ownerTypes.push(hasOwn(entry, "owner") ? jsonType(entry.owner) : "omitted");
    uiTokenAmountTypes.push(hasOwn(entry, "uiTokenAmount") ? jsonType(entry.uiTokenAmount) : "omitted");

    if (isJsonObject(entry.uiTokenAmount)) {
      const ui = entry.uiTokenAmount;
      amountTypes.push(hasOwn(ui, "amount") ? jsonType(ui.amount) : "omitted");
      decimalsTypes.push(hasOwn(ui, "decimals") ? jsonType(ui.decimals) : "omitted");
      uiAmountTypes.push(hasOwn(ui, "uiAmount") ? jsonType(ui.uiAmount) : "omitted");
      uiAmountStringTypes.push(hasOwn(ui, "uiAmountString") ? jsonType(ui.uiAmountString) : "omitted");
      if (typeof ui.amount === "string" && /^[0-9]+$/.test(ui.amount)) exactRawAmountCandidateCount += 1;
    } else {
      amountTypes.push("unavailable_ui_token_amount");
      decimalsTypes.push("unavailable_ui_token_amount");
      uiAmountTypes.push("unavailable_ui_token_amount");
      uiAmountStringTypes.push("unavailable_ui_token_amount");
    }
  }

  return {
    state,
    entryCount: entries.length,
    accountIndexJsonTypes: counts(accountIndexTypes),
    accountIndexValues,
    mintJsonTypes: counts(mintTypes),
    ownerJsonTypes: counts(ownerTypes),
    uiTokenAmountJsonTypes: counts(uiTokenAmountTypes),
    amountJsonTypes: counts(amountTypes),
    decimalsJsonTypes: counts(decimalsTypes),
    uiAmountJsonTypes: counts(uiAmountTypes),
    uiAmountStringJsonTypes: counts(uiAmountStringTypes),
    exactRawAmountCandidateCount,
  };
}

function summarizeSolBalances(meta: JsonObject, key: string): SolBalanceSummary {
  const state = fieldState(meta, key);
  if (state !== "array") return { state, entryCount: null, elementJsonTypes: [] };
  const values = meta[key] as unknown[];
  return { state, entryCount: values.length, elementJsonTypes: counts(values.map(jsonType)) };
}

function usableTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function loadedAddressState(meta: JsonObject | null): HeliusTransactionSummary["accounts"]["loadedAddressesState"] {
  if (meta === null) return "not_observable";
  if (!hasOwn(meta, "loadedAddresses")) return "omitted";
  if (meta.loadedAddresses === null) return "null";
  if (!isJsonObject(meta.loadedAddresses)) return "malformed";
  const loaded = meta.loadedAddresses;
  return Array.isArray(loaded.writable) && loaded.writable.every((item) => typeof item === "string") &&
    Array.isArray(loaded.readonly) && loaded.readonly.every((item) => typeof item === "string")
    ? "present"
    : "malformed";
}

function collectInstructionIndices(
  instructions: unknown[],
  programIds: number[],
  accountIndices: number[],
): number {
  let malformedIndexCount = 0;
  for (const instruction of instructions) {
    if (!isJsonObject(instruction)) {
      malformedIndexCount += 1;
      continue;
    }
    if (safeIndex(instruction.programIdIndex)) programIds.push(instruction.programIdIndex);
    else malformedIndexCount += 1;
    if (!Array.isArray(instruction.accounts)) {
      malformedIndexCount += 1;
      continue;
    }
    for (const accountIndex of instruction.accounts) {
      if (safeIndex(accountIndex)) accountIndices.push(accountIndex);
      else malformedIndexCount += 1;
    }
  }
  return malformedIndexCount;
}

function summarizeTransaction(transaction: JsonObject, requestedSignature: string): HeliusTransactionSummary {
  const signatures = transaction.transaction;
  const txObject = isJsonObject(signatures) ? signatures : null;
  const txSignatures = txObject?.signatures;
  const signatureCount = Array.isArray(txSignatures) ? txSignatures.length : null;
  const firstSignature = Array.isArray(txSignatures) ? txSignatures[0] : undefined;
  const requestedSignatureMatchesFirstPosition = typeof firstSignature === "string"
    ? firstSignature === requestedSignature
    : null;

  const message = txObject && isJsonObject(txObject.message) ? txObject.message : null;
  const accountKeysValue = message?.accountKeys;
  const staticAccountKeyState: FieldState = !message || !hasOwn(message, "accountKeys")
    ? "omitted"
    : accountKeysValue === null ? "null"
      : Array.isArray(accountKeysValue) ? "array" : "malformed";
  const staticKeys = staticAccountKeyState === "array" ? accountKeysValue as unknown[] : null;
  const staticAccountKeyCount = staticKeys?.length ?? null;
  const staticKeysUsable = staticKeys !== null && staticKeys.every((key) => typeof key === "string");

  const metaValue = transaction.meta;
  const metaState = !hasOwn(transaction, "meta") ? "omitted"
    : metaValue === null ? "null"
      : isJsonObject(metaValue) ? "present" : "malformed";
  const meta = metaState === "present" ? metaValue as JsonObject : null;
  const errorState = meta === null ? "not_applicable"
    : !hasOwn(meta, "err") ? "omitted"
      : meta.err === null ? "null" : "non_null";

  const loadedState = loadedAddressState(meta);
  let loadedWritableAddressCount: number | null = null;
  let loadedReadonlyAddressCount: number | null = null;
  if (loadedState === "present" && meta && isJsonObject(meta.loadedAddresses)) {
    loadedWritableAddressCount = (meta.loadedAddresses.writable as unknown[]).length;
    loadedReadonlyAddressCount = (meta.loadedAddresses.readonly as unknown[]).length;
  }

  const lookups = message && hasOwn(message, "addressTableLookups") ? message.addressTableLookups : undefined;
  const lookupState = Array.isArray(lookups) ? "array" : lookups === undefined ? "omitted" : "malformed";
  const lookupCount = Array.isArray(lookups) ? lookups.length : null;
  let totalResolvableAccountCount: number | null = null;
  if (staticKeysUsable) {
    if (loadedState === "present") {
      totalResolvableAccountCount = staticAccountKeyCount! + loadedWritableAddressCount! + loadedReadonlyAddressCount!;
    } else if ((lookupState === "array" && lookupCount === 0) || transaction.version === "legacy") {
      totalResolvableAccountCount = staticAccountKeyCount;
    }
  }

  const programIdIndices: number[] = [];
  const accountIndices: number[] = [];
  let malformedIndexCount = 0;
  const outerValue = message?.instructions;
  const outerInstructionCount = Array.isArray(outerValue) ? outerValue.length : null;
  const outerKnown = Array.isArray(outerValue);
  if (outerKnown) malformedIndexCount += collectInstructionIndices(outerValue, programIdIndices, accountIndices);

  const innerValue = meta?.innerInstructions;
  const innerInstructionGroupCount = Array.isArray(innerValue) ? innerValue.length : null;
  let innerInstructionCount: number | null = Array.isArray(innerValue) ? 0 : null;
  let innerKnown = Array.isArray(innerValue);
  if (Array.isArray(innerValue)) {
    for (const group of innerValue) {
      if (!isJsonObject(group) || !Array.isArray(group.instructions)) {
        innerKnown = false;
        innerInstructionCount = null;
        malformedIndexCount += 1;
        continue;
      }
      if (innerInstructionCount !== null) innerInstructionCount += group.instructions.length;
      malformedIndexCount += collectInstructionIndices(group.instructions, programIdIndices, accountIndices);
    }
  }

  const instructionStructureKnown = outerKnown && meta !== null && innerKnown;
  const allIndices = [...programIdIndices, ...accountIndices];
  let indexResolution: "resolved" | "unresolved" | "not_checkable" = "not_checkable";
  if (instructionStructureKnown && totalResolvableAccountCount !== null) {
    indexResolution = malformedIndexCount === 0 && allIndices.every((index) => index < totalResolvableAccountCount!)
      ? "resolved"
      : "unresolved";
  }

  const blockTime = !hasOwn(transaction, "blockTime") || transaction.blockTime === null
    ? { status: "unavailable" as const, reason: transaction.blockTime === null ? "null" as const : "missing_or_invalid" as const }
    : usableTime(transaction.blockTime)
      ? { status: "available" as const, value: transaction.blockTime }
      : { status: "unavailable" as const, reason: "missing_or_invalid" as const };
  const versionPresent = hasOwn(transaction, "version");
  const versionValue = transaction.version;
  const version = versionPresent && (
    typeof versionValue === "string" || typeof versionValue === "boolean" || versionValue === null ||
    (typeof versionValue === "number" && Number.isSafeInteger(versionValue))
  ) ? versionValue as string | number | boolean | null : null;

  const emptyTokenBalances = (): TokenBalanceSummary => ({
    state: "not_observable",
    entryCount: null,
    accountIndexJsonTypes: [], accountIndexValues: [], mintJsonTypes: [], ownerJsonTypes: [],
    uiTokenAmountJsonTypes: [], amountJsonTypes: [], decimalsJsonTypes: [], uiAmountJsonTypes: [],
    uiAmountStringJsonTypes: [], exactRawAmountCandidateCount: null,
  });
  const emptySolBalances = (): SolBalanceSummary => ({ state: "not_observable", entryCount: null, elementJsonTypes: [] });
  const summarizeMetaTokenField = (key: string): TokenBalanceSummary => meta ? summarizeTokenBalances(meta, key) : emptyTokenBalances();
  const summarizeMetaSolField = (key: string): SolBalanceSummary => meta ? summarizeSolBalances(meta, key) : emptySolBalances();

  return {
    slot: usableTime(transaction.slot)
      ? { status: "available", value: transaction.slot }
      : { status: "unavailable", reason: "missing_or_invalid" },
    blockTime,
    version: { status: versionPresent ? "present" : "omitted", jsonType: versionPresent ? jsonType(versionValue) : "undefined", value: version },
    meta: { state: metaState, errorState },
    signatures: { count: signatureCount, requestedSignatureMatchesFirstPosition },
    accounts: {
      staticAccountKeyState,
      staticAccountKeyCount,
      loadedAddressesState: loadedState,
      loadedWritableAddressCount,
      loadedReadonlyAddressCount,
      totalResolvableAccountCount,
    },
    instructions: {
      outerInstructionCount,
      innerInstructionGroupCount,
      innerInstructionCount,
      observedProgramIdIndexValues: programIdIndices,
      observedAccountIndexValues: accountIndices,
      malformedIndexCount,
      indexResolution,
    },
    tokenBalances: { pre: summarizeMetaTokenField("preTokenBalances"), post: summarizeMetaTokenField("postTokenBalances") },
    solBalances: { pre: summarizeMetaSolField("preBalances"), post: summarizeMetaSolField("postBalances") },
  };
}

export function parseHeliusTransactionProbeArguments(args: string[]): HeliusTransactionProbeInput {
  if (args.length !== 2 || args[0] !== "--signature" || args[1].startsWith("--")) {
    throw new Error("Supply exactly one --signature <signature> argument.");
  }
  if (!isSolanaTransactionSignatureSyntax(args[1])) {
    throw new Error("--signature must be a Base58-encoded 64-byte Solana transaction signature.");
  }
  return { signature: args[1] };
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 1000) / 1000);
}

function safeError(error: unknown): HeliusTransactionProbeError {
  if (error instanceof HeliusTransactionProviderError) {
    return {
      category: error.category,
      rpcCode: error.rpcCode,
      httpStatus: error.httpStatus,
      message: error.message,
    };
  }
  return { category: "unexpected", rpcCode: null, httpStatus: null, message: "Unexpected transaction probe failure." };
}

export async function runHeliusTransactionProbe(
  input: HeliusTransactionProbeInput,
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs?: number,
): Promise<HeliusTransactionProbeResult> {
  if (!isSolanaTransactionSignatureSyntax(input.signature)) {
    throw new Error("A Base58-encoded 64-byte Solana transaction signature is required.");
  }
  const started = performance.now();
  const request = {
    requestedSignature: input.signature,
    method: "getTransaction" as const,
    encoding: "json" as const,
    maxSupportedTransactionVersion: 1 as const,
    requestCount: 0,
  };
  if (process.env.HELIUS_API_KEY === undefined || process.env.HELIUS_API_KEY.trim() === "") {
    return {
      provider: "helius", request, elapsedMs: elapsedMs(started), status: "provider_error",
      error: {
        category: "configuration", rpcCode: null, httpStatus: null,
        message: "HELIUS_API_KEY is not configured.",
      },
      transaction: null,
    };
  }
  request.requestCount = 1;
  try {
    const result = await getHeliusTransaction(input.signature, fetchImpl, requestTimeoutMs);
    if (result.status === "provider_result_null") {
      return { provider: "helius", request, elapsedMs: elapsedMs(started), status: result.status, error: null, transaction: null };
    }
    const transaction = summarizeTransaction(result.transaction, input.signature);
    if (transaction.signatures.count === null || transaction.signatures.requestedSignatureMatchesFirstPosition === null) {
      return {
        provider: "helius", request, elapsedMs: elapsedMs(started), status: "provider_error",
        error: {
          category: "malformed_response", rpcCode: null, httpStatus: null,
          message: "The returned transaction did not contain a usable signatures array.",
        },
        transaction,
      };
    }
    if (transaction.signatures.requestedSignatureMatchesFirstPosition === false) {
      return {
        provider: "helius", request, elapsedMs: elapsedMs(started), status: "provider_error",
        error: {
          category: "signature_mismatch", rpcCode: null, httpStatus: null,
          message: "The returned transaction did not match the requested signature at position zero.",
        },
        transaction,
      };
    }
    return { provider: "helius", request, elapsedMs: elapsedMs(started), status: "returned", error: null, transaction };
  } catch (error: unknown) {
    return {
      provider: "helius", request, elapsedMs: elapsedMs(started), status: "provider_error",
      error: safeError(error), transaction: null,
    };
  }
}

async function main(): Promise<void> {
  try {
    const input = parseHeliusTransactionProbeArguments(process.argv.slice(2));
    const result = await runHeliusTransactionProbe(input);
    console.log(JSON.stringify(result));
    if (result.status === "provider_error") process.exitCode = 1;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid transaction probe request.";
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
