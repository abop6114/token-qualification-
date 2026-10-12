import { SOLANA_TOKEN_PROGRAM_IDS } from "../types/solana";
import type {
  SolanaCompiledInstructionEvidence,
  SolanaTransactionAccountReference,
  SolanaTransactionEvidence,
  SolanaTransactionExecutionEvidence,
  SolanaTransactionLookupEvidence,
} from "../types/solanaTransactionEvidence";
import {
  SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION,
  type SolanaInstructionCollectionCoverage,
  type SolanaSupportedTokenInstructionVariant,
  type SolanaTokenInstructionAccountEvidence,
  type SolanaTokenInstructionDecodeResult,
  type SolanaTokenInstructionExecutionLinkage,
  type SolanaTokenInstructionLocation,
  type SolanaTokenProgramIdentity,
  type SolanaTokenProgramInstructionEvidence,
  type SolanaTokenProgramInstructionRecord,
} from "../types/solanaTokenProgramInstructionEvidence";
import { decodeBase58, isSolanaPublicKeySyntax, isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";

const TOKEN_PROGRAM_BY_ADDRESS = new Map<string, SolanaTokenProgramIdentity>([
  [SOLANA_TOKEN_PROGRAM_IDS["spl-token"], "spl-token"],
  [SOLANA_TOKEN_PROGRAM_IDS["token-2022"], "token-2022"],
]);

// Variant tags and account ordering are pinned to the approved upstream source
// revisions: SPL Token b1c44c171bc95e6ee74af12365cb9cbab68be76c and
// Token-2022 8867f751c0f69367ba03af4f85510b5611989491.

type RecordValue = Record<string, unknown>;
type AccountSpaceState = "consistent" | "partial" | "conflicting";

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReference(value: unknown): value is SolanaTransactionAccountReference {
  if (!isRecord(value) || !safeIndex(value.accountIndex)) return false;
  if (value.status === "resolved") return typeof value.address === "string" && isSolanaPublicKeySyntax(value.address);
  return value.status === "unresolved" && value.address === null &&
    ["account_space_partial", "address_unusable", "index_out_of_range"].includes(String(value.reason));
}

function accountSpaceState(transaction: SolanaTransactionEvidence): AccountSpaceState {
  const space: unknown = transaction.accountSpace;
  const version: unknown = transaction.version;
  if (!isRecord(version) || !["available", "unavailable"].includes(String(version.status)) ||
    (version.status === "available" && version.value !== "legacy" && version.value !== 0) ||
    (version.status === "unavailable" && (version.value !== null || !["missing", "malformed"].includes(String(version.reason))))) return "conflicting";
  if (!isRecord(space) || !Array.isArray(space.accounts) ||
    !["complete", "partial", "unavailable"].includes(String(space.status))) return "conflicting";
  if (space.canonicalOrder !== "static_loaded_writable_loaded_readonly") return "conflicting";

  const accounts = space.accounts;
  const staticAccounts = accounts.filter((account: unknown) => isRecord(account) && account.source === "static");
  if (!isRecord(space.header) || space.header.status !== "available" ||
    !safeIndex(space.header.numRequiredSignatures) || !safeIndex(space.header.numReadonlySignedAccounts) ||
    !safeIndex(space.header.numReadonlyUnsignedAccounts) || space.header.numRequiredSignatures > staticAccounts.length ||
    space.header.numReadonlySignedAccounts > space.header.numRequiredSignatures ||
    space.header.numReadonlyUnsignedAccounts > staticAccounts.length - space.header.numRequiredSignatures ||
    space.signerWritableStatus !== "available") return "conflicting";
  const sourceOrder: Record<string, number> = { static: 0, loaded_writable: 1, loaded_readonly: 2 };
  const seen = new Set<string>();
  let previousSourceOrder = -1;
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (!isRecord(account) || account.accountIndex !== index || !safeIndex(account.accountIndex) ||
      typeof account.address !== "string" || !isSolanaPublicKeySyntax(account.address) ||
      !Object.hasOwn(sourceOrder, String(account.source)) ||
      !(typeof account.signer === "boolean" || account.signer === null) ||
      !(typeof account.writable === "boolean" || account.writable === null)) return "conflicting";
    const order = sourceOrder[String(account.source)];
    if (order < previousSourceOrder || seen.has(account.address)) return "conflicting";
    if (space.status !== "complete" && account.source !== "static") return "conflicting";
    previousSourceOrder = order;
    seen.add(account.address);
  }

  const lookupState = space.addressTableLookups;
  const loadedState = space.loadedAddresses;
  if (!isRecord(lookupState) || !isRecord(loadedState)) return "conflicting";
  if (!(["available", "unavailable"].includes(String(lookupState.status)) &&
      (lookupState.status === "available" || (lookupState.value === null && ["missing", "malformed"].includes(String(lookupState.reason))))) ||
    !(["available", "unavailable"].includes(String(loadedState.status)) &&
      (loadedState.status === "available" || (loadedState.value === null && ["meta_missing", "meta_null", "field_missing", "field_null", "malformed"].includes(String(loadedState.reason)))))) return "conflicting";
  if (lookupState.status === "available") {
    if (!Array.isArray(lookupState.value)) return "conflicting";
    const lookupEntries: unknown[] = lookupState.value;
    for (const lookup of lookupEntries) {
      if (!isRecord(lookup) || typeof lookup.accountKey !== "string" || !isSolanaPublicKeySyntax(lookup.accountKey) ||
        !Array.isArray(lookup.writableIndexes) || !Array.isArray(lookup.readonlyIndexes) ||
        ![...lookup.writableIndexes, ...lookup.readonlyIndexes].every((item) => safeIndex(item) && item <= 255)) return "conflicting";
    }
    if (loadedState.status === "available") {
      if (!isRecord(loadedState.value) || !Array.isArray(loadedState.value.writable) || !Array.isArray(loadedState.value.readonly) ||
        ![...loadedState.value.writable, ...loadedState.value.readonly].every((item) => typeof item === "string" && isSolanaPublicKeySyntax(item))) {
        return "conflicting";
      }
      const validLookups = lookupEntries as SolanaTransactionLookupEvidence[];
      const expectedWritable = validLookups.reduce((sum, lookup) => sum + lookup.writableIndexes.length, 0);
      const expectedReadonly = validLookups.reduce((sum, lookup) => sum + lookup.readonlyIndexes.length, 0);
      if (space.status === "complete" && (loadedState.value.writable.length !== expectedWritable || loadedState.value.readonly.length !== expectedReadonly)) return "conflicting";
      if (space.status === "complete" && accounts.length !== accounts.filter((item) => item.source === "static").length + expectedWritable + expectedReadonly) return "conflicting";
      if (space.status === "complete" && (accounts.filter((item) => item.source === "loaded_writable").map((item) => item.address).join("\u0000") !== loadedState.value.writable.join("\u0000") ||
        accounts.filter((item) => item.source === "loaded_readonly").map((item) => item.address).join("\u0000") !== loadedState.value.readonly.join("\u0000"))) return "conflicting";
    } else if (space.status === "complete" &&
      (lookupEntries as SolanaTransactionLookupEvidence[]).some((lookup) => lookup.writableIndexes.length + lookup.readonlyIndexes.length > 0)) return "conflicting";
  } else if (space.status === "complete" && (!isRecord(version) || version.status !== "available")) {
    return "conflicting";
  }

  if (space.status === "complete" && isRecord(version) && version.status === "available" && version.value === 0 && lookupState.status !== "available") return "conflicting";

  if (space.status === "complete" && isRecord(version) && version.status === "available" && version.value === "legacy" &&
    (accounts.some((account) => isRecord(account) && account.source !== "static") ||
      (lookupState.status === "available" && Array.isArray(lookupState.value) && lookupState.value.length !== 0) ||
      (loadedState.status === "available" && isRecord(loadedState.value) &&
        [...(Array.isArray(loadedState.value.writable) ? loadedState.value.writable : []),
          ...(Array.isArray(loadedState.value.readonly) ? loadedState.value.readonly : [])].length !== 0))) return "conflicting";

  const validSpaceReasons = [null, "lookup_metadata_missing", "lookup_metadata_malformed", "loaded_addresses_missing",
    "loaded_addresses_null", "loaded_addresses_malformed", "lookup_loaded_count_mismatch", "static_keys_unusable"];
  if (!validSpaceReasons.includes(space.reason as null | string)) return "conflicting";
  if (space.status === "complete" && (space.reason !== null || !isRecord(space.header) || space.header.status !== "available" || space.signerWritableStatus !== "available")) return "conflicting";
  if (space.status === "partial" && (space.reason === null || !isRecord(space.header) || space.header.status !== "available" || space.signerWritableStatus !== "available")) return "conflicting";
  if (space.status === "unavailable" && (accounts.length !== 0 || space.reason === null)) return "conflicting";

  return space.status === "complete" ? "consistent" : "partial";
}

function referenceConflict(reference: SolanaTransactionAccountReference, accounts: unknown[], spaceStatus: AccountSpaceState): boolean {
  const account = accounts[reference.accountIndex];
  if (reference.status === "resolved") {
    return !isRecord(account) || account.address !== reference.address;
  }
  if (account !== undefined) return true;
  // The transaction normalizer uses index_out_of_range only after a complete
  // account space, and account_space_partial only while indices may be missing.
  // A mismatch is local to this instruction reference; it does not invalidate
  // other instructions or turn an otherwise coherent account space conflicting.
  if (reference.reason === "index_out_of_range") return spaceStatus !== "consistent";
  if (reference.reason === "account_space_partial") return spaceStatus === "consistent";
  return false;
}

type InstructionValidation = "valid" | "malformed" | "reference_conflict";

function validateInstruction(instruction: unknown, position: number, accounts: unknown[], spaceStatus: AccountSpaceState): InstructionValidation {
  if (!isRecord(instruction) || instruction.position !== position || !safeIndex(instruction.programIdIndex) ||
    !Array.isArray(instruction.accountIndices) || !instruction.accountIndices.every(safeIndex) ||
    !Array.isArray(instruction.accounts) || instruction.accounts.length !== instruction.accountIndices.length ||
    !isReference(instruction.program) || instruction.program.accountIndex !== instruction.programIdIndex ||
    typeof instruction.data !== "string" || !["complete", "partial"].includes(String(instruction.status))) return "malformed";
  if (referenceConflict(instruction.program, accounts, spaceStatus)) return "reference_conflict";
  for (let index = 0; index < instruction.accounts.length; index += 1) {
    const reference = instruction.accounts[index];
    if (!isReference(reference) || reference.accountIndex !== instruction.accountIndices[index]) return "malformed";
    if (referenceConflict(reference, accounts, spaceStatus)) return "reference_conflict";
  }
  const refs = [instruction.program, ...instruction.accounts];
  const shouldBeComplete = refs.every((reference) => reference.status === "resolved");
  return (instruction.status === "complete") !== shouldBeComplete ? "malformed" : "valid";
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function executionLinkage(value: unknown): SolanaTokenInstructionExecutionLinkage {
  if (!isRecord(value)) return { status: "contradictory", reason: "malformed_execution_evidence" };
  if (value.status === "succeeded" && value.basis === "provider_meta_err_null") {
    return { status: "available", evidence: { status: "succeeded", basis: "provider_meta_err_null" } };
  }
  if (value.status === "failed" && value.basis === "provider_meta_err_non_null" &&
    "reportedError" in value && isJsonValue(value.reportedError)) {
    return { status: "available", evidence: { status: "failed", basis: "provider_meta_err_non_null", reportedError: structuredClone(value.reportedError) as Extract<SolanaTransactionExecutionEvidence, { status: "failed" }>["reportedError"] } };
  }
  if (value.status === "unavailable" && ["meta_missing", "meta_null", "meta_malformed", "err_missing"].includes(String(value.reason))) {
    return { status: "available", evidence: { status: "unavailable", reason: value.reason as "meta_missing" | "meta_null" | "meta_malformed" | "err_missing" } };
  }
  return { status: "contradictory", reason: "malformed_execution_evidence" };
}

function collectionShape(value: unknown, kind: "outer" | "inner"): { status: "available" | "partial" | "unavailable"; reason: string | null; reportedCount: number | null; entries: unknown[] } {
  if (!isRecord(value) || !["available", "partial", "unavailable"].includes(String(value.status)) ||
    !Array.isArray(kind === "inner" ? value.groups : value.entries)) {
    return { status: "unavailable", reason: "malformed_collection", reportedCount: null, entries: [] };
  }
  const entries = (kind === "inner" ? value.groups : value.entries) as unknown[];
  if (value.status === "unavailable") {
    const reported = kind === "inner" ? value.reportedGroupCount : value.reportedCount;
    return reported === null && entries.length === 0
      ? { status: "unavailable", reason: typeof value.reason === "string" ? value.reason : "malformed_collection", reportedCount: null, entries: [] }
      : { status: "partial", reason: "contradictory_collection", reportedCount: safeIndex(reported) ? reported : null, entries };
  }
  const reported = kind === "inner" ? value.reportedGroupCount : value.reportedCount;
  if (!safeIndex(reported) || reported !== entries.length) return { status: "partial", reason: "collection_count_mismatch", reportedCount: safeIndex(reported) ? reported : null, entries };
  const containsPartialEntry = kind === "outer"
    ? entries.some((entry) => !isRecord(entry) || entry.status !== "available" || !isRecord(entry.instruction) || entry.instruction.status !== "complete")
    : entries.some((group) => !isRecord(group) || group.status !== "available" || !Array.isArray(group.instructions) ||
      group.instructions.some((entry) => !isRecord(entry) || entry.status !== "available" || !isRecord(entry.instruction) || entry.instruction.status !== "complete"));
  const resultingStatus = value.status === "available" && containsPartialEntry ? "partial" : value.status as "available" | "partial";
  return { status: resultingStatus, reason: typeof value.reason === "string" ? value.reason : containsPartialEntry ? "entry_partial" : null, reportedCount: reported, entries };
}

function decodeAmount(bytes: Uint8Array, offset: number): string {
  let amount = 0n;
  for (let index = 7; index >= 0; index -= 1) amount = (amount << 8n) | BigInt(bytes[offset + index]);
  return amount.toString(10);
}

interface VariantDefinition {
  variant: SolanaSupportedTokenInstructionVariant;
  minimumLength: number;
  accountRoles: Array<"source" | "destination" | "mint_reference" | "authority_or_multisig">;
  checked: boolean;
}

const VARIANTS: Readonly<Record<number, VariantDefinition>> = {
  3: { variant: "transfer", minimumLength: 9, accountRoles: ["source", "destination", "authority_or_multisig"], checked: false },
  12: { variant: "transfer_checked", minimumLength: 10, accountRoles: ["source", "mint_reference", "destination", "authority_or_multisig"], checked: true },
  7: { variant: "mint_to", minimumLength: 9, accountRoles: ["mint_reference", "destination", "authority_or_multisig"], checked: false },
  14: { variant: "mint_to_checked", minimumLength: 10, accountRoles: ["mint_reference", "destination", "authority_or_multisig"], checked: true },
  8: { variant: "burn", minimumLength: 9, accountRoles: ["source", "mint_reference", "authority_or_multisig"], checked: false },
  15: { variant: "burn_checked", minimumLength: 10, accountRoles: ["source", "mint_reference", "authority_or_multisig"], checked: true },
};

function genericAccounts(instruction: SolanaCompiledInstructionEvidence): SolanaTokenInstructionAccountEvidence[] {
  return instruction.accounts.map((reference, rolePosition) => ({
    role: "unknown_account_reference", rolePosition, reference: structuredClone(reference),
  }));
}

function decodePayload(
  instruction: SolanaCompiledInstructionEvidence,
  _identity: SolanaTokenProgramIdentity,
  accountSpaceConflict: boolean,
): SolanaTokenInstructionDecodeResult {
  if (accountSpaceConflict) return {
    decodeStatus: "account_space_conflicting", variant: null, tag: null, rawAmount: null, decimals: null,
    trailingByteCount: null, accounts: [], reason: "transaction_account_space_conflicting",
  };
  const bytes = decodeBase58(instruction.data);
  if (bytes === null) return {
    decodeStatus: "malformed_payload", variant: null, tag: null, rawAmount: null, decimals: null,
    trailingByteCount: null, accounts: [], reason: instruction.data.length === 0 ? "empty_data" : "malformed_base58_data",
  };
  if (bytes.length === 0) return {
    decodeStatus: "malformed_payload", variant: null, tag: null, rawAmount: null, decimals: null,
    trailingByteCount: null, accounts: [], reason: "empty_data",
  };
  const tag = bytes[0];
  const definition = VARIANTS[tag];
  if (!definition) return {
    decodeStatus: "unsupported_variant", variant: null, tag, rawAmount: null, decimals: null,
    trailingByteCount: null, accounts: [], reason: "variant_not_supported",
  };
  if (bytes.length < definition.minimumLength) return {
    decodeStatus: "malformed_payload", variant: null, tag, rawAmount: null, decimals: null,
    trailingByteCount: null, accounts: [], reason: "truncated_payload",
  };

  const trailingByteCount = bytes.length - definition.minimumLength;
  const roleCount = definition.accountRoles.length;
  const signerCount = instruction.accounts.length - roleCount;
  if (signerCount < 0) return {
    decodeStatus: "malformed_account_list", variant: null, tag, rawAmount: null, decimals: null,
    trailingByteCount, accounts: genericAccounts(instruction), reason: "required_account_missing",
  };
  if (signerCount > 11) return {
    decodeStatus: "malformed_account_list", variant: null, tag, rawAmount: null, decimals: null,
    trailingByteCount, accounts: genericAccounts(instruction), reason: "too_many_additional_signers",
  };
  const accounts: SolanaTokenInstructionAccountEvidence[] = instruction.accounts.map((reference, rolePosition) => ({
    role: rolePosition < roleCount ? definition.accountRoles[rolePosition] : "additional_signer_reference",
    rolePosition,
    reference: structuredClone(reference),
  }));
  const unresolved = accounts.some((account) => account.reference.status === "unresolved");
  return {
    decodeStatus: unresolved ? "account_reference_unresolved" : "decoded_supported",
    variant: definition.variant,
    tag,
    rawAmount: decodeAmount(bytes, 1),
    decimals: definition.checked ? bytes[9] : null,
    trailingByteCount,
    accounts,
    reason: unresolved ? "account_reference_unresolved" : null,
  };
}

function record(
  instruction: SolanaCompiledInstructionEvidence,
  location: SolanaTokenInstructionLocation,
  identity: SolanaTokenProgramIdentity | "unsupported" | "unresolved",
  spaceConflict: boolean,
): SolanaTokenProgramInstructionRecord {
  const program = instruction.program;
  const decode: SolanaTokenInstructionDecodeResult = identity === "unresolved"
    ? { decodeStatus: "unresolved_program", variant: null, tag: null, rawAmount: null, decimals: null, trailingByteCount: null,
      accounts: genericAccounts(instruction), reason: "program_reference_unresolved" }
    : identity === "unsupported"
      ? { decodeStatus: "unsupported_program", variant: null, tag: null, rawAmount: null, decimals: null, trailingByteCount: null,
        accounts: genericAccounts(instruction), reason: "program_not_supported" }
      : decodePayload(instruction, identity, spaceConflict);
  return {
    location,
    sourcePosition: instruction.position,
    sourceInstruction: structuredClone(instruction),
    sourceInstructionReason: null,
    sourceProgram: structuredClone(program),
    programIdentity: identity,
    dataBase58: instruction.data,
    decode,
  };
}

function unavailableRecord(position: number, location: SolanaTokenInstructionLocation, reason: "malformed_compiled_instruction"): SolanaTokenProgramInstructionRecord {
  return {
    location,
    sourcePosition: position,
    sourceInstruction: null,
    sourceInstructionReason: reason,
    sourceProgram: null,
    programIdentity: "unavailable",
    dataBase58: null,
    decode: { decodeStatus: "source_instruction_unavailable", variant: null, tag: null, rawAmount: null, decimals: null,
      trailingByteCount: null, accounts: [], reason },
  };
}

function programIdentity(reference: SolanaTransactionAccountReference): SolanaTokenProgramIdentity | "unsupported" | "unresolved" {
  if (reference.status === "unresolved") return "unresolved";
  return TOKEN_PROGRAM_BY_ADDRESS.get(reference.address) ?? "unsupported";
}

function collectionCoverage(
  status: "available" | "partial" | "unavailable",
  reason: string | null,
  reportedCount: number | null,
  suppliedEntryCount: number,
  processedEntryCount: number,
): SolanaInstructionCollectionCoverage {
  return { status, reason, reportedCount, suppliedEntryCount, processedEntryCount };
}

function executionReason(linkage: SolanaTokenInstructionExecutionLinkage): boolean {
  return linkage.status === "contradictory";
}

/**
 * Decodes only source-pinned SPL Token and Token-2022 base instruction variants.
 * Results are instruction observations, never economic-effect classifications.
 */
export function decodeSolanaTokenProgramInstructionEvidence(
  transaction: SolanaTransactionEvidence,
): SolanaTokenProgramInstructionEvidence {
  if (!isRecord(transaction) || !Array.isArray(transaction.signatures) || transaction.signatures.length === 0 ||
    typeof transaction.signatures[0] !== "string" || !isSolanaTransactionSignatureSyntax(transaction.signatures[0])) {
    throw new Error("Solana transaction evidence has an invalid signature.");
  }

  const spaceState = accountSpaceState(transaction);
  const accountSpaceAccounts = isRecord(transaction.accountSpace) && Array.isArray(transaction.accountSpace.accounts)
    ? transaction.accountSpace.accounts : [];
  const linkage = executionLinkage(transaction.execution);
  const outer = collectionShape(transaction.outerInstructions, "outer");
  const inner = collectionShape(transaction.innerInstructions, "inner");
  const instructions: SolanaTokenProgramInstructionRecord[] = [];
  let sourceConflict = spaceState === "conflicting";
  let outerMalformed = false;
  let innerMalformed = false;
  let suppliedInnerInstructionCount = 0;

  for (let outerIndex = 0; outerIndex < outer.entries.length; outerIndex += 1) {
    const entry = outer.entries[outerIndex];
    const location: SolanaTokenInstructionLocation = { instructionSet: "outer", outerInstructionIndex: outerIndex, innerGroupPosition: null, innerInstructionIndex: null };
    if (!isRecord(entry)) {
      instructions.push(unavailableRecord(outerIndex, location, "malformed_compiled_instruction"));
      continue;
    }
    if (entry.status === "malformed") {
      instructions.push(unavailableRecord(safeIndex(entry.position) ? entry.position : outerIndex, location, "malformed_compiled_instruction"));
      continue;
    }
    if (entry.status !== "available" || !isRecord(entry.instruction)) {
      instructions.push(unavailableRecord(outerIndex, location, "malformed_compiled_instruction"));
      outerMalformed = true;
      continue;
    }
    const instruction = entry.instruction as unknown as SolanaCompiledInstructionEvidence;
    const validation = validateInstruction(instruction, outerIndex, accountSpaceAccounts, spaceState);
    if (validation === "malformed" || (validation === "reference_conflict" && spaceState !== "conflicting") || !isReference(instruction.program)) {
      instructions.push(unavailableRecord(outerIndex, location, "malformed_compiled_instruction"));
      outerMalformed = true;
      continue;
    }
    instructions.push(record(instruction, location, programIdentity(instruction.program), spaceState === "conflicting"));
  }

  for (let groupPosition = 0; groupPosition < inner.entries.length; groupPosition += 1) {
    const group = inner.entries[groupPosition];
    if (!isRecord(group) || group.status !== "available" || !safeIndex(group.parentOuterInstructionIndex) ||
      group.parentOuterInstructionIndex >= outer.entries.length || !Array.isArray(group.instructions)) {
      innerMalformed = true;
      continue;
    }
    suppliedInnerInstructionCount += group.instructions.length;
    for (let innerIndex = 0; innerIndex < group.instructions.length; innerIndex += 1) {
      const entry = group.instructions[innerIndex];
      const location: SolanaTokenInstructionLocation = {
        instructionSet: "inner", outerInstructionIndex: group.parentOuterInstructionIndex,
        innerGroupPosition: groupPosition, innerInstructionIndex: innerIndex,
      };
      if (!isRecord(entry)) {
        instructions.push(unavailableRecord(innerIndex, location, "malformed_compiled_instruction"));
        continue;
      }
      if (entry.status === "malformed") {
        instructions.push(unavailableRecord(safeIndex(entry.position) ? entry.position : innerIndex, location, "malformed_compiled_instruction"));
        continue;
      }
      if (entry.status !== "available" || !isRecord(entry.instruction)) {
        instructions.push(unavailableRecord(innerIndex, location, "malformed_compiled_instruction"));
        innerMalformed = true;
        continue;
      }
      const instruction = entry.instruction as unknown as SolanaCompiledInstructionEvidence;
      const validation = validateInstruction(instruction, innerIndex, accountSpaceAccounts, spaceState);
      if (validation === "malformed" || (validation === "reference_conflict" && spaceState !== "conflicting") || !isReference(instruction.program)) {
        instructions.push(unavailableRecord(innerIndex, location, "malformed_compiled_instruction"));
        innerMalformed = true;
        continue;
      }
      instructions.push(record(instruction, location, programIdentity(instruction.program), spaceState === "conflicting"));
    }
  }

  const accountSpaceStatus = sourceConflict ? "conflicting" : spaceState;
  if (accountSpaceStatus === "conflicting") {
    for (const item of instructions) {
      if (item.sourceInstruction) {
        item.decode = { decodeStatus: "account_space_conflicting", variant: null, tag: null, rawAmount: null, decimals: null,
          trailingByteCount: null, accounts: [], reason: "transaction_account_space_conflicting" };
      }
    }
  }

  const outerStatus = outerMalformed && outer.status === "available" ? "partial" : outer.status;
  const innerStatus = innerMalformed && inner.status === "available" ? "partial" : inner.status;
  const outerProcessed = instructions.filter((item) => item.location.instructionSet === "outer").length;
  const innerProcessed = instructions.filter((item) => item.location.instructionSet === "inner").length;
  const outerCoverage = collectionCoverage(outerStatus, outer.reason ?? (outerMalformed ? "malformed_instruction_entry" : null), outer.reportedCount, outer.entries.length, outerProcessed);
  const innerCoverage = collectionCoverage(innerStatus, inner.reason ?? (innerMalformed ? "malformed_inner_instruction_entry" : null), inner.reportedCount, suppliedInnerInstructionCount, innerProcessed);
  const reasons: SolanaTokenProgramInstructionEvidence["coverage"]["reasonCodes"] = [];
  if (outerStatus === "unavailable") reasons.push("outer_instructions_unavailable");
  else if (outerStatus === "partial") reasons.push("outer_instructions_partial");
  if (innerStatus === "unavailable") reasons.push("inner_instructions_unavailable");
  else if (innerStatus === "partial") reasons.push("inner_instructions_partial");
  if (accountSpaceStatus === "partial") reasons.push("account_space_partial");
  if (accountSpaceStatus === "conflicting") reasons.push("account_space_conflicting");
  if (executionReason(linkage)) reasons.push("execution_evidence_contradictory");

  const processingComplete = outerProcessed === outer.entries.length &&
    innerProcessed === suppliedInnerInstructionCount && !outerMalformed && !innerMalformed;
  return {
    schemaVersion: SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION,
    chain: "solana",
    transactionSignature: transaction.signatures[0],
    transactionExecution: linkage,
    coverage: {
      outer: outerCoverage,
      inner: innerCoverage,
      processing: processingComplete ? "complete_for_supplied_instruction_entries" : "partial",
      accountSpace: accountSpaceStatus,
      reasonCodes: reasons,
    },
    instructions,
  };
}
