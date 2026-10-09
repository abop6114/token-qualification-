import { isBase58Syntax, isSolanaPublicKeySyntax, isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";
import type {
  SolanaHistoricalAmountEvidence,
} from "../types/solanaHistoricalSampling";
import type {
  SolanaCompiledInstructionEvidence,
  SolanaInnerInstructionCollection,
  SolanaInnerInstructionGroup,
  SolanaInstructionCollection,
  SolanaInstructionEntry,
  SolanaReportedSolBalance,
  SolanaTokenBalanceEntry,
  SolanaTokenBalanceObservation,
  SolanaTokenBalanceSide,
  SolanaTokenField,
  SolanaTokenAmountField,
  SolanaTransactionAccount,
  SolanaTransactionAccountReference,
  SolanaTransactionAccountSpace,
  SolanaTransactionAvailability,
  SolanaTransactionSafeIntegerEvidence,
  SolanaTransactionEvidence,
  SolanaTransactionExecutionEvidence,
  SolanaTransactionJsonValue,
  SolanaTransactionLoadedAddresses,
  SolanaTransactionLookupEvidence,
  SolanaSolBalanceSide,
} from "../types/solanaTransactionEvidence";

type JsonObject = Record<string, unknown>;

export class SolanaTransactionNormalizationError extends Error {
  constructor(
    readonly reason: "signature_mismatch" | "malformed_structure" | "unsupported_version",
    message: string,
  ) {
    super(message);
    this.name = "SolanaTransactionNormalizationError";
  }
}

const hasOwn = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUnsignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeSignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function malformed(message: string): never {
  throw new SolanaTransactionNormalizationError("malformed_structure", message);
}

function jsonValue(value: unknown, seen = new Set<object>()): SolanaTransactionJsonValue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => jsonValue(entry, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, SolanaTransactionJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = jsonValue(entry, seen);
    if (converted === null && entry !== null && typeof entry !== "object") {
      seen.delete(value);
      return null;
    }
    result[key] = converted;
  }
  seen.delete(value);
  return result;
}

function available<T>(value: T): SolanaTransactionAvailability<T, never> {
  return { status: "available", value };
}

function unavailable<T, R extends string>(reason: R): SolanaTransactionAvailability<T, R> {
  return { status: "unavailable", value: null, reason };
}

function numericField(
  object: JsonObject,
  key: string,
  kind: "unsigned" | "signed",
): SolanaTransactionSafeIntegerEvidence<"missing" | "null" | "unsafe_or_malformed"> {
  if (!hasOwn(object, key)) return { status: "unavailable", value: null, reason: "missing" };
  const value = object[key];
  if (value === null) return { status: "unavailable", value: null, reason: "null" };
  if (kind === "unsigned" ? safeUnsignedInteger(value) : safeSignedInteger(value)) {
    return { status: "available", value: value as number, exactness: "safe_json_integer" };
  }
  return { status: "unavailable", value: null, reason: "unsafe_or_malformed" };
}

function parseVersion(transaction: JsonObject): SolanaTransactionAvailability<"legacy" | number, "missing" | "malformed"> {
  if (!hasOwn(transaction, "version")) return unavailable("missing");
  const value = transaction.version;
  if (value === "legacy") return available("legacy");
  if (!safeUnsignedInteger(value)) {
    throw new SolanaTransactionNormalizationError("malformed_structure", "The returned transaction version is malformed.");
  }
  if (value !== 0) {
    throw new SolanaTransactionNormalizationError("unsupported_version", "The returned transaction version is not supported by this evidence normalizer.");
  }
  return available(value);
}

function parseLookupEntries(value: unknown): SolanaTransactionLookupEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const entries: SolanaTransactionLookupEvidence[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.accountKey !== "string" || !isSolanaPublicKeySyntax(entry.accountKey) ||
      !Array.isArray(entry.writableIndexes) || !Array.isArray(entry.readonlyIndexes)) return null;
    const writableIndexes = entry.writableIndexes;
    const readonlyIndexes = entry.readonlyIndexes;
    if (![...writableIndexes, ...readonlyIndexes].every((index) => safeUnsignedInteger(index) && index <= 255)) return null;
    entries.push({ accountKey: entry.accountKey, writableIndexes: [...writableIndexes], readonlyIndexes: [...readonlyIndexes] });
  }
  return entries;
}

function parseLoadedAddresses(value: unknown): SolanaTransactionLoadedAddresses | null {
  if (!isObject(value) || !Array.isArray(value.writable) || !Array.isArray(value.readonly) ||
    ![...value.writable, ...value.readonly].every((address) => typeof address === "string" && isSolanaPublicKeySyntax(address))) {
    return null;
  }
  return { writable: [...value.writable] as string[], readonly: [...value.readonly] as string[] };
}

function validHeader(message: JsonObject, staticKeyCount: number): SolanaTransactionAccountSpace["header"] {
  if (!isObject(message.header)) return { status: "unavailable", reason: hasOwn(message, "header") ? "malformed" : "missing" };
  const required = message.header.numRequiredSignatures;
  const readonlySigned = message.header.numReadonlySignedAccounts;
  const readonlyUnsigned = message.header.numReadonlyUnsignedAccounts;
  const unsignedCount = staticKeyCount - (safeUnsignedInteger(required) ? required : staticKeyCount + 1);
  if (!safeUnsignedInteger(required) || !safeUnsignedInteger(readonlySigned) || !safeUnsignedInteger(readonlyUnsigned) ||
    required > staticKeyCount || readonlySigned > required || readonlyUnsigned > unsignedCount) {
    return { status: "unavailable", reason: "malformed" };
  }
  return {
    status: "available",
    numRequiredSignatures: required,
    numReadonlySignedAccounts: readonlySigned,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
  };
}

function accountSpace(
  message: JsonObject,
  meta: JsonObject | null,
  metaState: "present" | "missing" | "null" | "malformed",
  explicitVersion: SolanaTransactionAvailability<"legacy" | number, "missing" | "malformed">,
): SolanaTransactionAccountSpace {
  if (!Array.isArray(message.accountKeys) || !message.accountKeys.every((key) => typeof key === "string" && isSolanaPublicKeySyntax(key))) {
    malformed("The transaction static account keys are missing or malformed.");
  }
  const staticKeys = message.accountKeys as string[];
  const header = validHeader(message, staticKeys.length);
  if (header.status !== "available") malformed("The transaction message header is missing or structurally invalid.");

  const hasLookups = hasOwn(message, "addressTableLookups");
  const parsedLookups = hasLookups ? parseLookupEntries(message.addressTableLookups) : null;
  const lookupsState: SolanaTransactionAccountSpace["addressTableLookups"] = parsedLookups === null
    ? { status: "unavailable", value: null, reason: hasLookups ? "malformed" : "missing" }
    : { status: "available", value: parsedLookups };

  let loadedState: SolanaTransactionAccountSpace["loadedAddresses"];
  if (metaState === "missing") loadedState = { status: "unavailable", value: null, reason: "meta_missing" };
  else if (metaState === "null") loadedState = { status: "unavailable", value: null, reason: "meta_null" };
  else if (metaState === "malformed") loadedState = { status: "unavailable", value: null, reason: "malformed" };
  else if (!meta || !hasOwn(meta, "loadedAddresses")) loadedState = { status: "unavailable", value: null, reason: "field_missing" };
  else if (meta.loadedAddresses === null) loadedState = { status: "unavailable", value: null, reason: "field_null" };
  else {
    const parsed = parseLoadedAddresses(meta.loadedAddresses);
    loadedState = parsed === null
      ? { status: "unavailable", value: null, reason: "malformed" }
      : { status: "available", value: parsed };
  }

  let status: SolanaTransactionAccountSpace["status"] = "complete";
  let reason: SolanaTransactionAccountSpace["reason"] = null;
  let writableCount = 0;
  let readonlyCount = 0;
  if (lookupsState.status !== "available") {
    if (explicitVersion.status === "available" && explicitVersion.value === "legacy" && !hasLookups) {
      // Explicit legacy version establishes a static-only message; loadedAddresses may be omitted or empty.
    } else {
      status = "partial";
      reason = hasLookups ? "lookup_metadata_malformed" : "lookup_metadata_missing";
    }
  } else {
    for (const lookup of lookupsState.value) {
      writableCount += lookup.writableIndexes.length;
      readonlyCount += lookup.readonlyIndexes.length;
    }
    if (loadedState.status === "available") {
      if (loadedState.value.writable.length !== writableCount || loadedState.value.readonly.length !== readonlyCount) {
        status = "partial";
        reason = "lookup_loaded_count_mismatch";
      }
    } else if (writableCount + readonlyCount > 0) {
      status = "partial";
      reason = loadedState.reason === "field_missing" ? "loaded_addresses_missing"
        : loadedState.reason === "field_null" ? "loaded_addresses_null"
          : loadedState.reason === "meta_null" ? "loaded_addresses_null"
            : loadedState.reason === "meta_missing" ? "loaded_addresses_missing"
              : "loaded_addresses_malformed";
    }
  }

  if (loadedState.status === "available" && lookupsState.status === "available" &&
    (loadedState.value.writable.length !== writableCount || loadedState.value.readonly.length !== readonlyCount)) {
    status = "partial";
    reason = "lookup_loaded_count_mismatch";
  }
  if (explicitVersion.status === "available" && explicitVersion.value === "legacy" &&
    (writableCount + readonlyCount > 0 || (loadedState.status === "available" &&
      (loadedState.value.writable.length > 0 || loadedState.value.readonly.length > 0)))) {
    status = "partial";
    reason = "lookup_loaded_count_mismatch";
  }
  if (status === "complete" && loadedState.status === "unavailable" &&
    loadedState.reason === "malformed") {
    status = "partial";
    reason = "loaded_addresses_malformed";
  }

  const accounts: SolanaTransactionAccount[] = [];
  for (let index = 0; index < staticKeys.length; index += 1) {
    const isSigner = index < header.numRequiredSignatures;
    const isWritable = isSigner
      ? index < header.numRequiredSignatures - header.numReadonlySignedAccounts
      : index < staticKeys.length - header.numReadonlyUnsignedAccounts;
    accounts.push({ accountIndex: index, address: staticKeys[index], source: "static", signer: isSigner, writable: isWritable });
  }
  if (status === "complete" && loadedState.status === "available") {
    for (const address of loadedState.value.writable) {
      accounts.push({ accountIndex: accounts.length, address, source: "loaded_writable", signer: false, writable: true });
    }
    for (const address of loadedState.value.readonly) {
      accounts.push({ accountIndex: accounts.length, address, source: "loaded_readonly", signer: false, writable: false });
    }
  }

  return {
    canonicalOrder: "static_loaded_writable_loaded_readonly",
    status,
    reason,
    addressTableLookups: lookupsState,
    loadedAddresses: loadedState,
    accounts,
    signerWritableStatus: header.status === "available" ? "available" : "unavailable",
    header,
  };
}

function accountReference(index: number, space: SolanaTransactionAccountSpace): SolanaTransactionAccountReference {
  const account = space.accounts[index];
  if (account) return { accountIndex: index, status: "resolved", address: account.address };
  return {
    accountIndex: index,
    status: "unresolved",
    address: null,
    reason: space.status === "complete" ? "index_out_of_range" : "account_space_partial",
  };
}

function normalizeInstruction(value: unknown, position: number, space: SolanaTransactionAccountSpace): SolanaInstructionEntry {
  if (!isObject(value) || !safeUnsignedInteger(value.programIdIndex) || !Array.isArray(value.accounts) ||
    !value.accounts.every(safeUnsignedInteger) || typeof value.data !== "string" ||
    (value.data.length > 0 && !isBase58Syntax(value.data))) {
    return { status: "malformed", position, reason: "malformed_compiled_instruction" };
  }
  const program = accountReference(value.programIdIndex, space);
  const accounts = (value.accounts as number[]).map((index) => accountReference(index, space));
  const references = [program, ...accounts];
  const complete = references.every((reference) => reference.status === "resolved");
  const instruction: SolanaCompiledInstructionEvidence = {
    position,
    programIdIndex: value.programIdIndex,
    program,
    accountIndices: [...value.accounts] as number[],
    accounts,
    data: value.data,
    status: complete ? "complete" : "partial",
  };
  return { status: "available", instruction };
}

function normalizeInstructionCollection(value: unknown, space: SolanaTransactionAccountSpace): SolanaInstructionCollection {
  if (!Array.isArray(value)) {
    return {
      status: "unavailable",
      reason: value === null ? "field_null" : "field_missing",
      reportedCount: null,
      entries: [],
    };
  }
  const entries = value.map((entry, position) => normalizeInstruction(entry, position, space));
  const isComplete = entries.every((entry) => entry.status === "available" && entry.instruction.status === "complete");
  return {
    status: isComplete ? "available" : "partial",
    reason: entries.some((entry) => entry.status === "malformed") ? "malformed" : null,
    reportedCount: value.length,
    entries,
  };
}

function normalizeInnerInstructions(
  meta: JsonObject | null,
  metaState: "present" | "missing" | "null" | "malformed",
  space: SolanaTransactionAccountSpace,
  outerCount: number,
): SolanaInnerInstructionCollection {
  if (metaState !== "present" || !meta) {
    const reason = metaState === "missing" ? "meta_missing" : metaState === "null" ? "meta_null" : "malformed";
    return { status: "unavailable", reason, reportedGroupCount: null, groups: [] };
  }
  if (!hasOwn(meta, "innerInstructions")) return { status: "unavailable", reason: "field_missing", reportedGroupCount: null, groups: [] };
  if (meta.innerInstructions === null) return { status: "unavailable", reason: "field_null", reportedGroupCount: null, groups: [] };
  if (!Array.isArray(meta.innerInstructions)) return { status: "unavailable", reason: "malformed", reportedGroupCount: null, groups: [] };
  const groups: SolanaInnerInstructionGroup[] = meta.innerInstructions.map((rawGroup, groupPosition) => {
    if (!isObject(rawGroup) || !safeUnsignedInteger(rawGroup.index) || rawGroup.index >= outerCount || !Array.isArray(rawGroup.instructions)) {
      return { status: "malformed", groupPosition, reason: "malformed_inner_instruction_group" };
    }
    return {
      status: "available",
      parentOuterInstructionIndex: rawGroup.index,
      instructions: rawGroup.instructions.map((instruction, position) => normalizeInstruction(instruction, position, space)),
    };
  });
  const complete = groups.every((group) => group.status === "available" &&
    group.instructions.every((entry) => entry.status === "available" && entry.instruction.status === "complete"));
  return {
    status: complete ? "available" : "partial",
    reason: groups.some((group) => group.status === "malformed" ||
      (group.status === "available" && group.instructions.some((entry) => entry.status === "malformed"))) ? "malformed" : null,
    reportedGroupCount: groups.length,
    groups,
  };
}

function field<T>(object: JsonObject, key: string, validate: (value: unknown) => value is T): SolanaTokenField<T> {
  if (!hasOwn(object, key)) return { status: "unavailable", value: null, reason: "missing" };
  const value = object[key];
  if (value === null) return { status: "unavailable", value: null, reason: "null" };
  if (!validate(value)) return { status: "unavailable", value: null, reason: "malformed" };
  return { status: "available", value };
}

function parsedUiAmount(ui: JsonObject): Pick<SolanaHistoricalAmountEvidence, "reportedUiAmount" | "reportedUiAmountType"> {
  if (!hasOwn(ui, "uiAmount")) return {};
  if (ui.uiAmount === null) return { reportedUiAmount: null, reportedUiAmountType: "null" };
  if (typeof ui.uiAmount === "string") return { reportedUiAmount: ui.uiAmount, reportedUiAmountType: "string" };
  if (typeof ui.uiAmount === "number" && Number.isFinite(ui.uiAmount)) return { reportedUiAmountType: "number" };
  return {};
}

function tokenAmount(ui: unknown): SolanaTokenAmountField {
  if (ui === undefined) return { status: "unavailable", evidence: null, reason: "missing" };
  if (ui === null) return { status: "unavailable", evidence: null, reason: "null" };
  if (!isObject(ui)) return { status: "unavailable", evidence: null, reason: "malformed" };
  const uiFields = parsedUiAmount(ui);
  if (!hasOwn(ui, "amount")) {
    return { status: "available", evidence: {
      rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "not_reported",
      reportedAmount: null, reportedAmountType: "missing", ...uiFields,
    } };
  }
  const value = ui.amount;
  if (value === null) {
    return { status: "available", evidence: {
      rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "not_reported",
      reportedAmount: null, reportedAmountType: "null", ...uiFields,
    } };
  }
  if (typeof value === "string") {
    if (value.length === 0) return { status: "unavailable", evidence: null, reason: "malformed" };
    if (/^[0-9]+$/.test(value)) {
      return { status: "available", evidence: {
        rawAmount: value, exactRawAvailable: true, exactnessBasis: "provider_integer_string", unavailableReason: null,
        reportedAmount: value, reportedAmountType: "integer_string", ...uiFields,
      } };
    }
    return { status: "available", evidence: {
      rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "provider_representation_not_exact",
      reportedAmount: value, reportedAmountType: "non_integer_string", ...uiFields,
    } };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { status: "unavailable", evidence: null, reason: "malformed" };
  }
  if (Number.isSafeInteger(value)) {
    return { status: "available", evidence: {
      rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "provider_representation_not_exact",
      reportedAmount: String(value), reportedAmountType: "safe_integer_number", ...uiFields,
    } };
  }
  if (Number.isInteger(value)) {
    return { status: "available", evidence: {
      rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "provider_representation_not_exact",
      reportedAmount: null, reportedAmountType: "unsafe_integer_number", ...uiFields,
    } };
  }
  return { status: "available", evidence: {
    rawAmount: null, exactRawAvailable: false, exactnessBasis: null, unavailableReason: "provider_representation_not_exact",
    reportedAmount: String(value), reportedAmountType: "non_integer_number", ...uiFields,
  } };
}

function tokenBalanceObservation(
  raw: unknown,
  providerArrayIndex: number,
  space: SolanaTransactionAccountSpace,
): SolanaTokenBalanceEntry {
  if (!isObject(raw)) {
    const unavailable = (reason: "malformed"): SolanaTokenField<never> => ({ status: "unavailable", value: null, reason });
    return { status: "partial", observation: {
      providerArrayIndex,
      accountIndex: unavailable("malformed"),
      tokenAccountAddress: unavailable("malformed"),
      mint: unavailable("malformed"),
      owner: unavailable("malformed"),
      amount: { status: "unavailable", evidence: null, reason: "malformed" },
      decimals: unavailable("malformed"),
    } };
  }
  const accountIndex = field(raw, "accountIndex", safeUnsignedInteger);
  let tokenAccountAddress: SolanaTokenField<string>;
  if (accountIndex.status !== "available") {
    tokenAccountAddress = { status: "unavailable", value: null, reason: "unresolved_account" };
  } else {
    const reference = accountReference(accountIndex.value, space);
    tokenAccountAddress = reference.status === "resolved"
      ? { status: "available", value: reference.address }
      : { status: "unavailable", value: null, reason: "unresolved_account" };
  }
  const mint = field(raw, "mint", (value): value is string => typeof value === "string" && isSolanaPublicKeySyntax(value));
  const owner = field(raw, "owner", (value): value is string => typeof value === "string" && isSolanaPublicKeySyntax(value));
  const uiTokenAmount = raw.uiTokenAmount;
  const amount = tokenAmount(uiTokenAmount);
  const decimals = isObject(uiTokenAmount)
    ? field(uiTokenAmount, "decimals", (value): value is number => safeUnsignedInteger(value) && value <= 255)
    : {
        status: "unavailable" as const,
        value: null,
        reason: uiTokenAmount === undefined ? "missing" as const : uiTokenAmount === null ? "null" as const : "malformed" as const,
      };
  const fields = [accountIndex, tokenAccountAddress, mint, owner, amount, decimals];
  const isPartial = fields.some((entry) => entry.status === "unavailable");
  return {
    status: isPartial ? "partial" : "available",
    observation: { providerArrayIndex, accountIndex, tokenAccountAddress, mint, owner, amount, decimals },
  };
}

function tokenBalanceSide(
  meta: JsonObject | null,
  metaState: "present" | "missing" | "null" | "malformed",
  key: "preTokenBalances" | "postTokenBalances",
  space: SolanaTransactionAccountSpace,
): SolanaTokenBalanceSide {
  if (metaState !== "present" || !meta) {
    return { status: "unavailable", entries: [], reportedEntryCount: null,
      reason: metaState === "missing" ? "meta_missing" : metaState === "null" ? "meta_null" : "meta_malformed" };
  }
  if (!hasOwn(meta, key)) return { status: "unavailable", entries: [], reportedEntryCount: null, reason: "field_missing" };
  if (meta[key] === null) return { status: "unavailable", entries: [], reportedEntryCount: null, reason: "field_null" };
  if (!Array.isArray(meta[key])) return { status: "unavailable", entries: [], reportedEntryCount: null, reason: "malformed" };
  const entries = (meta[key] as unknown[]).map((entry, index) => tokenBalanceObservation(entry, index, space));
  return {
    status: entries.every((entry) => entry.status === "available") ? "available" : "partial",
    entries,
    reportedEntryCount: entries.length,
  };
}

function solBalanceSide(
  meta: JsonObject | null,
  metaState: "present" | "missing" | "null" | "malformed",
  key: "preBalances" | "postBalances",
  accountSpace: SolanaTransactionAccountSpace,
): SolanaSolBalanceSide {
  const exactness = "non_exact_json_number_observations" as const;
  if (metaState !== "present" || !meta) {
    return { status: "unavailable", values: [], reportedEntryCount: null, exactness,
      reason: metaState === "missing" ? "meta_missing" : metaState === "null" ? "meta_null" : "meta_malformed" };
  }
  if (!hasOwn(meta, key)) return { status: "unavailable", values: [], reportedEntryCount: null, exactness, reason: "field_missing" };
  if (meta[key] === null) return { status: "unavailable", values: [], reportedEntryCount: null, exactness, reason: "field_null" };
  if (!Array.isArray(meta[key])) return { status: "unavailable", values: [], reportedEntryCount: null, exactness, reason: "malformed" };
  const values: SolanaReportedSolBalance[] = (meta[key] as unknown[]).map((value, accountIndex) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return { status: "malformed", accountIndex, reason: "not_a_number" };
    if (value < 0) return { status: "malformed", accountIndex, reason: "negative" };
    return { status: "reported", accountIndex, value, exactRawAvailable: false };
  });
  const hasBad = values.some((value) => value.status === "malformed");
  const lengthMismatch = accountSpace.status === "complete" && values.length !== accountSpace.accounts.length;
  return { status: hasBad || lengthMismatch ? "partial" : "available", values, reportedEntryCount: values.length, exactness };
}

function metaEvidence(transaction: JsonObject): {
  meta: JsonObject | null;
  state: "present" | "missing" | "null" | "malformed";
} {
  if (!hasOwn(transaction, "meta")) return { meta: null, state: "missing" };
  if (transaction.meta === null) return { meta: null, state: "null" };
  if (!isObject(transaction.meta)) return { meta: null, state: "malformed" };
  return { meta: transaction.meta, state: "present" };
}

function executionEvidence(meta: JsonObject | null, state: "present" | "missing" | "null" | "malformed"): SolanaTransactionExecutionEvidence {
  if (state === "missing") return { status: "unavailable", reason: "meta_missing" };
  if (state === "null") return { status: "unavailable", reason: "meta_null" };
  if (state === "malformed" || !meta) return { status: "unavailable", reason: "meta_malformed" };
  if (!hasOwn(meta, "err")) return { status: "unavailable", reason: "err_missing" };
  if (meta.err === null) return { status: "succeeded", basis: "provider_meta_err_null" };
  const error = jsonValue(meta.err);
  if (error === null) return { status: "unavailable", reason: "meta_malformed" };
  return { status: "failed", basis: "provider_meta_err_non_null", reportedError: error };
}

function structuralCompleteness(
  execution: SolanaTransactionExecutionEvidence,
  space: SolanaTransactionAccountSpace,
  outerInstructions: SolanaInstructionCollection,
  innerInstructions: SolanaInnerInstructionCollection,
  tokenBalances: { pre: SolanaTokenBalanceSide; post: SolanaTokenBalanceSide },
  solBalances: { pre: SolanaSolBalanceSide; post: SolanaSolBalanceSide },
): "complete" | "partial" {
  const complete = execution.status !== "unavailable" &&
    space.status === "complete" &&
    outerInstructions.status === "available" &&
    innerInstructions.status === "available" &&
    tokenBalances.pre.status === "available" &&
    tokenBalances.post.status === "available" &&
    solBalances.pre.status === "available" &&
    solBalances.post.status === "available";
  return complete ? "complete" : "partial";
}

export function normalizeSolanaTransactionEvidence(raw: unknown, requestedSignature: string): SolanaTransactionEvidence {
  if (!isSolanaTransactionSignatureSyntax(requestedSignature)) {
    malformed("The requested transaction signature is malformed.");
  }
  if (!isObject(raw)) malformed("The transaction result is not an object.");
  const transaction = raw.transaction;
  if (!isObject(transaction) || !Array.isArray(transaction.signatures) || transaction.signatures.length === 0 ||
    !transaction.signatures.every((signature) => typeof signature === "string" && isSolanaTransactionSignatureSyntax(signature))) {
    malformed("The returned transaction signature array is missing or malformed.");
  }
  const signatures = transaction.signatures as string[];
  if (signatures[0] !== requestedSignature) {
    throw new SolanaTransactionNormalizationError("signature_mismatch", "The returned transaction does not match the requested signature.");
  }
  if (!isObject(transaction.message)) malformed("The returned transaction message is missing or malformed.");
  const message = transaction.message;
  if (!isObject(message.header) || !safeUnsignedInteger(message.header.numRequiredSignatures) ||
    signatures.length !== message.header.numRequiredSignatures) {
    malformed("The returned transaction signature count does not match its required signer count.");
  }
  // The RPC response reports transaction version beside (not inside) the
  // transaction/message object.
  const version = parseVersion(raw);
  const metaResult = metaEvidence(raw);
  const space = accountSpace(message, metaResult.meta, metaResult.state, version);
  const outerRaw = message.instructions;
  if (!Array.isArray(outerRaw)) malformed("The returned transaction outer instruction list is missing or malformed.");
  const outerInstructions = normalizeInstructionCollection(outerRaw, space);
  const innerInstructions = normalizeInnerInstructions(metaResult.meta, metaResult.state, space, outerRaw.length);

  const execution = executionEvidence(metaResult.meta, metaResult.state);
  const tokenBalances = {
    pre: tokenBalanceSide(metaResult.meta, metaResult.state, "preTokenBalances", space),
    post: tokenBalanceSide(metaResult.meta, metaResult.state, "postTokenBalances", space),
  };
  const solBalances = {
    pre: solBalanceSide(metaResult.meta, metaResult.state, "preBalances", space),
    post: solBalanceSide(metaResult.meta, metaResult.state, "postBalances", space),
  };

  return {
    signatures: [...signatures],
    slot: numericField(raw, "slot", "unsigned"),
    blockTime: numericField(raw, "blockTime", "signed"),
    version,
    execution,
    accountSpace: space,
    outerInstructions,
    innerInstructions,
    tokenBalances,
    solBalances,
    structuralCompleteness: structuralCompleteness(execution, space, outerInstructions, innerInstructions, tokenBalances, solBalances),
    historicalCoverage: "not_assessed",
  };
}
