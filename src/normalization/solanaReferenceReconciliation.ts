import {
  SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION,
  type SolanaInstructionAccountReferenceRelationship,
  type SolanaInstructionReferenceRelationship,
  type SolanaMintReferenceComparison,
  type SolanaReferenceExecutionComparison,
  type SolanaReferenceExecutionState,
  type SolanaReferenceReconciliationCoverageStatus,
  type SolanaReferenceReconciliationEvidence,
  type SolanaReferenceReconciliationReason,
  type SolanaReferenceMatchStatus,
} from "../types/solanaReferenceReconciliation";
import type { SolanaTokenBalanceFlowEvidence, SolanaTokenBalanceFlowPair } from "../types/solanaTokenBalanceFlowEvidence";
import {
  SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION,
  type SolanaSupportedTokenInstructionVariant,
  type SolanaTokenInstructionAccountEvidence,
  type SolanaTokenInstructionDecodeResult,
  type SolanaTokenInstructionLocation,
  type SolanaTokenProgramInstructionEvidence,
  type SolanaTokenProgramInstructionRecord,
} from "../types/solanaTokenProgramInstructionEvidence";
import type { SolanaTransactionExecutionEvidence } from "../types/solanaTransactionEvidence";
import { isSolanaPublicKeySyntax, isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";

type RecordValue = Record<string, unknown>;

const FLOW_SCHEMA_VERSION = "solana-token-balance-flow-evidence-v1";
const FLOW_STATUSES = ["complete", "partial", "unavailable", "conflicting", "not_applicable"] as const;
const INSTRUCTION_STATUSES = [
  "decoded_supported", "account_reference_unresolved", "unsupported_variant", "malformed_payload",
  "source_instruction_unavailable", "unresolved_program", "unsupported_program", "account_space_conflicting",
  "malformed_account_list",
] as const;
const VARIANTS: readonly SolanaSupportedTokenInstructionVariant[] = [
  "transfer", "transfer_checked", "mint_to", "mint_to_checked", "burn", "burn_checked",
];
const FLOW_CONFLICT_REASONS = [
  "duplicate_pair_key", "account_index_multiple_mints", "account_address_mismatch", "decimals_mismatch",
  "amount_evidence_conflicting", "decimals_evidence_conflicting", "balance_side_conflicting",
] as const;

const REASON_ORDER: readonly SolanaReferenceReconciliationReason[] = [
  "transaction_identity_mismatch", "execution_unavailable", "execution_conflicting", "balance_flow_partial",
  "balance_flow_unavailable", "balance_flow_conflicting", "balance_flow_not_applicable",
  "outer_instructions_partial", "outer_instructions_unavailable", "inner_instructions_partial",
  "inner_instructions_unavailable", "instruction_processing_partial", "account_space_partial",
  "account_space_conflicting", "unresolved_instruction_reference", "ambiguous_account_index",
  "pair_reference_conflict", "unsupported_or_malformed_instruction",
];

export class SolanaReferenceReconciliationInputError extends Error {
  constructor(message: string) {
    super(`Invalid Solana reference reconciliation input: ${message}`);
    this.name = "SolanaReferenceReconciliationInputError";
  }
}

function fail(message: string): never {
  throw new SolanaReferenceReconciliationInputError(message);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value as RecordValue).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function validExecution(value: unknown): value is SolanaTransactionExecutionEvidence {
  if (!isRecord(value)) return false;
  if (value.status === "succeeded") return exactKeys(value, ["status", "basis"]) && value.basis === "provider_meta_err_null";
  if (value.status === "failed") return exactKeys(value, ["status", "basis", "reportedError"]) &&
    value.basis === "provider_meta_err_non_null" && value.reportedError !== null && isJsonValue(value.reportedError);
  return value.status === "unavailable" && exactKeys(value, ["status", "reason"]) &&
    ["meta_missing", "meta_null", "meta_malformed", "err_missing"].includes(String(value.reason));
}

function validLocation(value: unknown): value is SolanaTokenInstructionLocation {
  if (!isRecord(value) || !safeIndex(value.outerInstructionIndex)) return false;
  if (value.instructionSet === "outer") {
    return exactKeys(value, ["instructionSet", "outerInstructionIndex", "innerGroupPosition", "innerInstructionIndex"]) &&
      value.innerGroupPosition === null && value.innerInstructionIndex === null;
  }
  return value.instructionSet === "inner" && exactKeys(value, ["instructionSet", "outerInstructionIndex", "innerGroupPosition", "innerInstructionIndex"]) &&
    safeIndex(value.innerGroupPosition) && safeIndex(value.innerInstructionIndex);
}

function validAccountReference(value: unknown): boolean {
  if (!isRecord(value) || !safeIndex(value.accountIndex)) return false;
  if (value.status === "resolved") return exactKeys(value, ["accountIndex", "status", "address"]) &&
    typeof value.address === "string" && isSolanaPublicKeySyntax(value.address);
  return value.status === "unresolved" && exactKeys(value, ["accountIndex", "status", "address", "reason"]) && value.address === null &&
    ["account_space_partial", "address_unusable", "index_out_of_range"].includes(String(value.reason));
}

function validDecode(value: unknown): value is SolanaTokenInstructionDecodeResult {
  if (!isRecord(value) || !enumValue(value.decodeStatus, INSTRUCTION_STATUSES) || !Array.isArray(value.accounts)) return false;
  if (!value.accounts.every((account) => isRecord(account) &&
    ["source", "destination", "mint_reference", "authority_or_multisig", "additional_signer_reference", "unknown_account_reference"].includes(String(account.role)) &&
    safeIndex(account.rolePosition) && validAccountReference(account.reference))) return false;
  if (value.decodeStatus === "decoded_supported" || value.decodeStatus === "account_reference_unresolved") {
    return enumValue(value.variant, VARIANTS) && safeIndex(value.tag) && typeof value.rawAmount === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value.rawAmount) && (value.decimals === null || (safeIndex(value.decimals) && value.decimals <= 255)) &&
      safeIndex(value.trailingByteCount) && (value.reason === null || value.reason === "account_reference_unresolved");
  }
  return value.variant === null && value.rawAmount === null && value.decimals === null &&
    (value.tag === null || safeIndex(value.tag)) && (value.trailingByteCount === null || safeIndex(value.trailingByteCount)) &&
    typeof value.reason === "string";
}

function validInstructionRecord(value: unknown): value is SolanaTokenProgramInstructionRecord {
  if (!isRecord(value) || !validLocation(value.location) || !safeIndex(value.sourcePosition) ||
    !enumValue(value.programIdentity, ["spl-token", "token-2022", "unsupported", "unresolved", "unavailable"] as const) ||
    !(value.sourceInstruction === null || isRecord(value.sourceInstruction)) ||
    !(value.sourceInstructionReason === null || value.sourceInstructionReason === "malformed_compiled_instruction") ||
    !(value.sourceProgram === null || validAccountReference(value.sourceProgram)) ||
    !(value.dataBase58 === null || typeof value.dataBase58 === "string") || !validDecode(value.decode)) return false;
  if ((value.sourceInstruction === null) !== (value.sourceInstructionReason !== null)) return false;
  if (value.sourceInstruction === null) return value.decode.decodeStatus === "source_instruction_unavailable";
  if (!isRecord(value.sourceInstruction) || !safeIndex(value.sourceInstruction.position) ||
    !safeIndex(value.sourceInstruction.programIdIndex) || !Array.isArray(value.sourceInstruction.accounts) ||
    !value.sourceInstruction.accounts.every(validAccountReference)) return false;
  const sourceInstructionAccounts: unknown[] = value.sourceInstruction.accounts;
  if (value.decode.accounts.length > 0 && (value.decode.accounts.length !== value.sourceInstruction.accounts.length ||
    value.decode.accounts.some((account, index) => account.rolePosition !== index ||
      stableJson(account.reference) !== stableJson(sourceInstructionAccounts[index])))) return false;
  if (value.decode.decodeStatus === "decoded_supported" || value.decode.decodeStatus === "account_reference_unresolved") {
    const roles = expectedRoles(value.decode.variant);
    if (value.decode.accounts.length < roles.length || value.decode.accounts.length > roles.length + 11 ||
      value.decode.accounts.some((account, index) => account.role !== (roles[index] ?? "additional_signer_reference"))) return false;
  }
  return true;
}

function expectedRoles(variant: SolanaSupportedTokenInstructionVariant): readonly string[] {
  switch (variant) {
    case "transfer": return ["source", "destination", "authority_or_multisig"];
    case "transfer_checked": return ["source", "mint_reference", "destination", "authority_or_multisig"];
    case "mint_to":
    case "mint_to_checked": return ["mint_reference", "destination", "authority_or_multisig"];
    case "burn":
    case "burn_checked": return ["source", "mint_reference", "authority_or_multisig"];
  }
}

function validCollectionCoverage(value: unknown): value is {
  status: "available" | "partial" | "unavailable";
  reason: string | null;
  reportedCount: number | null;
  suppliedEntryCount: number;
  processedEntryCount: number;
} {
  return isRecord(value) && enumValue(value.status, ["available", "partial", "unavailable"] as const) &&
    (value.reason === null || typeof value.reason === "string") &&
    (value.reportedCount === null || safeIndex(value.reportedCount)) && safeIndex(value.suppliedEntryCount) &&
    safeIndex(value.processedEntryCount) && value.processedEntryCount <= value.suppliedEntryCount;
}

function validPair(value: unknown): value is SolanaTokenBalanceFlowPair {
  if (!isRecord(value) || !enumValue(value.status, ["matched", "conflicting"] as const) || !safeIndex(value.accountIndex) ||
    typeof value.mint !== "string" || !isSolanaPublicKeySyntax(value.mint) || !safeIndex(value.preProviderArrayIndex) ||
    !safeIndex(value.postProviderArrayIndex) || !isRecord(value.tokenAccountAddress) ||
    !enumValue(value.tokenAccountAddress.status, ["available", "unavailable"] as const)) return false;
  if (value.tokenAccountAddress.status === "available") {
    if (!exactKeys(value.tokenAccountAddress, ["status", "value"]) || typeof value.tokenAccountAddress.value !== "string" ||
      !isSolanaPublicKeySyntax(value.tokenAccountAddress.value)) return false;
  } else if (!exactKeys(value.tokenAccountAddress, ["status", "value", "reason"]) || value.tokenAccountAddress.value !== null ||
    !["missing", "null", "malformed", "unresolved_account"].includes(String(value.tokenAccountAddress.reason))) return false;
  if (!isRecord(value.rawDelta) || !enumValue(value.rawDelta.status, ["available", "unavailable"] as const)) return false;
  if (value.rawDelta.status === "available") return exactKeys(value.rawDelta, ["status", "value", "basis"]) &&
    typeof value.rawDelta.value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value.rawDelta.value) && value.rawDelta.basis === "post_minus_pre_bigint";
  return exactKeys(value.rawDelta, ["status", "value", "reason"]) && value.rawDelta.value === null && typeof value.rawDelta.reason === "string";
}

function validateBalanceFlow(value: unknown): asserts value is SolanaTokenBalanceFlowEvidence {
  if (!isRecord(value) || value.schemaVersion !== FLOW_SCHEMA_VERSION || value.chain !== "solana" ||
    typeof value.transactionSignature !== "string" || !isSolanaTransactionSignatureSyntax(value.transactionSignature) ||
    !FLOW_STATUSES.includes(value.status as typeof FLOW_STATUSES[number]) || !Array.isArray(value.reasonCodes) ||
    !value.reasonCodes.every((reason) => typeof reason === "string") || !Array.isArray(value.pairs) || !value.pairs.every(validPair) ||
    !Array.isArray(value.unmatchedObservations) || !Array.isArray(value.conflicts) || value.phase2A === undefined ||
    !validExecution(value.transactionExecution)) fail("Phase 2B evidence is malformed or has an unsupported schema.");
  for (const conflict of value.conflicts) {
    if (!isRecord(conflict) || !enumValue(conflict.reason, FLOW_CONFLICT_REASONS) || !safeIndex(conflict.accountIndex) ||
      !(conflict.mint === null || (typeof conflict.mint === "string" && isSolanaPublicKeySyntax(conflict.mint))) ||
      !Array.isArray(conflict.preProviderArrayIndexes) || !conflict.preProviderArrayIndexes.every(safeIndex) ||
      !Array.isArray(conflict.postProviderArrayIndexes) || !conflict.postProviderArrayIndexes.every(safeIndex)) {
      fail("Phase 2B conflict evidence is malformed.");
    }
  }
}

function validateInstructionEvidence(value: unknown): asserts value is SolanaTokenProgramInstructionEvidence {
  if (!isRecord(value) || value.schemaVersion !== SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION ||
    value.chain !== "solana" || typeof value.transactionSignature !== "string" ||
    !isSolanaTransactionSignatureSyntax(value.transactionSignature) || !Array.isArray(value.instructions) ||
    !value.instructions.every(validInstructionRecord) || !isRecord(value.coverage) ||
    !validCollectionCoverage(value.coverage.outer) || !validCollectionCoverage(value.coverage.inner) ||
    !enumValue(value.coverage.processing, ["complete_for_supplied_instruction_entries", "partial"] as const) ||
    !enumValue(value.coverage.accountSpace, ["consistent", "partial", "conflicting"] as const) ||
    !Array.isArray(value.coverage.reasonCodes) || !value.coverage.reasonCodes.every((reason) => typeof reason === "string")) {
    fail("Phase 2C evidence is malformed or has an unsupported schema.");
  }
  const coverage = value.coverage;
  if (!isRecord(coverage) || !validCollectionCoverage(coverage.outer) || !validCollectionCoverage(coverage.inner)) {
    fail("Phase 2C collection coverage is malformed.");
  }
  const linkage = value.transactionExecution;
  if (!isRecord(linkage) || !enumValue(linkage.status, ["available", "contradictory"] as const) ||
    (linkage.status === "available" && !validExecution(linkage.evidence)) ||
    (linkage.status === "contradictory" && linkage.reason !== "malformed_execution_evidence")) {
    fail("Phase 2C execution evidence is malformed.");
  }
  for (let index = 0; index < value.instructions.length; index += 1) {
    if (value.instructions[index].sourcePosition < 0) fail("Phase 2C instruction source position is malformed.");
  }
  const outerRecords = value.instructions.filter((record) => record.location.instructionSet === "outer");
  const innerRecords = value.instructions.filter((record) => record.location.instructionSet === "inner");
  const outerCoverage = coverage.outer;
  const innerCoverage = coverage.inner;
  if (outerCoverage.suppliedEntryCount !== outerRecords.length ||
    outerCoverage.processedEntryCount !== outerRecords.length ||
    innerCoverage.suppliedEntryCount !== innerRecords.length ||
    innerCoverage.processedEntryCount !== innerRecords.length) {
    fail("Phase 2C instruction counts do not reconcile with supplied instruction records.");
  }
  if (outerCoverage.status === "available" &&
    (outerCoverage.reason !== null || outerCoverage.reportedCount !== outerRecords.length)) {
    fail("Phase 2C available outer-instruction coverage is inconsistent.");
  }
  if (innerCoverage.status === "available" &&
    (innerCoverage.reason !== null || innerCoverage.reportedCount === null)) {
    fail("Phase 2C available inner-instruction coverage is inconsistent.");
  }
  const outerIndexes = outerRecords.map((record) => record.location.outerInstructionIndex).sort((a, b) => a - b);
  if (outerIndexes.some((index, position) => index !== position)) {
    fail("Phase 2C outer-instruction locations are duplicated or non-sequential.");
  }
  const innerByGroup = new Map<string, number[]>();
  for (const record of innerRecords) {
    if (record.location.innerGroupPosition === null || record.location.innerInstructionIndex === null) {
      fail("Phase 2C inner-instruction location is malformed.");
    }
    const groupKey = `${record.location.outerInstructionIndex}:${record.location.innerGroupPosition}`;
    const indexes = innerByGroup.get(groupKey) ?? [];
    indexes.push(record.location.innerInstructionIndex);
    innerByGroup.set(groupKey, indexes);
  }
  for (const indexes of innerByGroup.values()) {
    indexes.sort((a, b) => a - b);
    if (indexes.some((index, position) => index !== position)) {
      fail("Phase 2C inner-instruction locations are duplicated or non-sequential.");
    }
  }
  if (value.coverage.processing === "complete_for_supplied_instruction_entries" &&
    (outerCoverage.processedEntryCount !== outerCoverage.suppliedEntryCount ||
      innerCoverage.processedEntryCount !== innerCoverage.suppliedEntryCount)) {
    fail("Phase 2C processing completeness contradicts its instruction counts.");
  }
}

function executionState(value: SolanaTransactionExecutionEvidence): Exclude<SolanaReferenceExecutionState, "contradictory"> {
  return value.status;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as RecordValue;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function compareExecution(balanceFlow: SolanaTokenBalanceFlowEvidence, instructions: SolanaTokenProgramInstructionEvidence): SolanaReferenceExecutionComparison {
  const instructionExecution = instructions.transactionExecution;
  if (instructionExecution.status === "contradictory") {
    return { status: "malformed_or_contradictory_source_evidence", source: "instruction_evidence" };
  }
  const left = executionState(balanceFlow.transactionExecution);
  const right = executionState(instructionExecution.evidence);
  if (left === "unavailable" || right === "unavailable") {
    return { status: "one_or_both_unavailable", balanceFlow: left, instructionEvidence: right };
  }
  if (left !== right) return {
    status: "contradictory_definitive_evidence", balanceFlow: left, instructionEvidence: right,
  };
  if (left === "succeeded") return { status: "confirmed_compatible_success" };
  const leftError = (balanceFlow.transactionExecution as Extract<SolanaTransactionExecutionEvidence, { status: "failed" }>).reportedError;
  const rightError = instructionExecution.evidence.status === "failed" ? instructionExecution.evidence.reportedError : null;
  if (rightError === null || stableJson(leftError) !== stableJson(rightError)) {
    return { status: "malformed_or_contradictory_source_evidence", source: "both" };
  }
  return { status: "confirmed_compatible_failure" };
}

function addReason(reasons: Set<SolanaReferenceReconciliationReason>, reason: SolanaReferenceReconciliationReason): void {
  reasons.add(reason);
}

function sourceCoverage(balanceFlow: SolanaTokenBalanceFlowEvidence, instructions: SolanaTokenProgramInstructionEvidence) {
  return {
    balanceFlowStatus: balanceFlow.status,
    instructionOuter: structuredClone(instructions.coverage.outer),
    instructionInner: structuredClone(instructions.coverage.inner),
    instructionProcessing: instructions.coverage.processing,
    instructionAccountSpace: instructions.coverage.accountSpace,
  };
}

function pairConflictForIndex(balanceFlow: SolanaTokenBalanceFlowEvidence, accountIndex: number): boolean {
  return balanceFlow.conflicts.some((conflict) => conflict.accountIndex === accountIndex &&
    ["account_address_mismatch", "duplicate_pair_key", "account_index_multiple_mints"].includes(conflict.reason));
}

function hasGlobalFlowConflict(balanceFlow: SolanaTokenBalanceFlowEvidence): boolean {
  return balanceFlow.reasonCodes.includes("account_space_conflicting") ||
    balanceFlow.reasonCodes.includes("balance_side_conflicting") ||
    balanceFlow.reasonCodes.includes("execution_state_conflicting");
}

function comparablePairs(balanceFlow: SolanaTokenBalanceFlowEvidence): boolean {
  return balanceFlow.status !== "unavailable" && balanceFlow.status !== "not_applicable" && !hasGlobalFlowConflict(balanceFlow);
}

function accountReferenceRelationship(
  account: SolanaTokenInstructionAccountEvidence,
  role: "source" | "destination",
  balanceFlow: SolanaTokenBalanceFlowEvidence,
  globalAccountConflict: boolean,
): SolanaInstructionAccountReferenceRelationship {
  const reference = account.reference;
  const sameIndex = balanceFlow.pairs.map((pair, index) => ({ pair, index }))
    .filter(({ pair }) => pair.accountIndex === reference.accountIndex);
  let matchStatus: SolanaReferenceMatchStatus;
  let candidatePairIndexes = sameIndex.map(({ index }) => index);
  if (globalAccountConflict || !comparablePairs(balanceFlow)) {
    matchStatus = "not_comparable";
    candidatePairIndexes = [];
  } else if (reference.status === "unresolved") {
    // Same-index pairs are contextual candidates only; without a resolved
    // instruction address they cannot establish a match or ambiguity.
    matchStatus = "instruction_reference_unresolved";
  } else {
    const conflictDeclaresMultiMint = balanceFlow.conflicts.some((conflict) => conflict.accountIndex === reference.accountIndex &&
      conflict.reason === "account_index_multiple_mints");
    const distinctMints = new Set(sameIndex.map(({ pair }) => pair.mint));
    if (conflictDeclaresMultiMint || distinctMints.size > 1) {
      matchStatus = "ambiguous_account_index";
    } else if (sameIndex.length === 0) {
      matchStatus = "no_pair_in_supplied_evidence";
    } else if (sameIndex.length > 1) {
      matchStatus = "ambiguous_account_index";
    } else {
      const { pair } = sameIndex[0];
      const addressConflict = pairConflictForIndex(balanceFlow, pair.accountIndex) &&
        balanceFlow.conflicts.some((conflict) => conflict.accountIndex === pair.accountIndex &&
          (conflict.mint === null || conflict.mint === pair.mint) && conflict.reason === "account_address_mismatch");
      if (addressConflict || (pair.tokenAccountAddress.status === "available" && pair.tokenAccountAddress.value !== reference.address)) {
        matchStatus = "index_address_contradiction";
      } else if (pair.tokenAccountAddress.status === "unavailable") {
        matchStatus = "index_overlap_address_unverified";
      } else {
        matchStatus = "index_address_agreement";
      }
    }
  }
  return {
    role,
    rolePosition: account.rolePosition,
    accountIndex: reference.accountIndex,
    referenceStatus: reference.status,
    address: reference.status === "resolved" ? reference.address : null,
    matchStatus,
    candidatePairIndexes,
  };
}

function decodeVariant(decode: SolanaTokenInstructionDecodeResult): SolanaSupportedTokenInstructionVariant | null {
  return decode.decodeStatus === "decoded_supported" || decode.decodeStatus === "account_reference_unresolved"
    ? decode.variant : null;
}

function isRecognizedInstruction(record: SolanaTokenProgramInstructionRecord): boolean {
  return record.decode.decodeStatus === "decoded_supported" || record.decode.decodeStatus === "account_reference_unresolved";
}

function relationshipRecords(
  balanceFlow: SolanaTokenBalanceFlowEvidence,
  instructions: SolanaTokenProgramInstructionEvidence,
  reasons: Set<SolanaReferenceReconciliationReason>,
  globalAccountConflict: boolean,
): { relationships: SolanaInstructionReferenceRelationship[]; mintComparisons: SolanaMintReferenceComparison[] } {
  const relationships: SolanaInstructionReferenceRelationship[] = [];
  const mintComparisons: SolanaMintReferenceComparison[] = [];
  instructions.instructions.forEach((instruction, instructionSourceIndex) => {
    if (!isRecognizedInstruction(instruction)) {
      addReason(reasons, "unsupported_or_malformed_instruction");
    }
    const accountReferences: SolanaInstructionAccountReferenceRelationship[] = [];
    for (const account of instruction.decode.accounts) {
      if (account.role === "source" || account.role === "destination") {
        const relationship = accountReferenceRelationship(account, account.role, balanceFlow, globalAccountConflict);
        accountReferences.push(relationship);
        if (relationship.matchStatus === "instruction_reference_unresolved") addReason(reasons, "unresolved_instruction_reference");
        if (relationship.matchStatus === "ambiguous_account_index") addReason(reasons, "ambiguous_account_index");
        if (relationship.matchStatus === "index_address_contradiction") addReason(reasons, "pair_reference_conflict");
      }
      if (account.role === "mint_reference" && account.reference.status === "resolved") {
        let matchStatus: SolanaMintReferenceComparison["matchStatus"];
        let candidatePairIndexes: number[] = [];
        if (globalAccountConflict || !comparablePairs(balanceFlow)) {
          matchStatus = "not_comparable";
        } else {
          candidatePairIndexes = balanceFlow.pairs.map((pair, index) => pair.mint === account.reference.address ? index : -1)
            .filter((index) => index >= 0);
          matchStatus = candidatePairIndexes.length > 0 ? "reported_mint_string_match"
            : balanceFlow.pairs.length > 0 ? "reported_mint_string_mismatch"
              : "no_pair_with_reported_mint_in_supplied_evidence";
        }
        mintComparisons.push({ instructionSourceIndex, location: structuredClone(instruction.location),
          rolePosition: account.rolePosition, accountIndex: account.reference.accountIndex,
          referencedAddress: account.reference.address, matchStatus, candidatePairIndexes });
      } else if (account.role === "mint_reference" && account.reference.status === "unresolved") {
        addReason(reasons, "unresolved_instruction_reference");
      }
    }
    relationships.push({ instructionSourceIndex, location: structuredClone(instruction.location),
      decodeStatus: instruction.decode.decodeStatus, variant: decodeVariant(instruction.decode), accountReferences });
  });
  return { relationships, mintComparisons };
}

function deriveCoverage(
  balanceFlow: SolanaTokenBalanceFlowEvidence,
  instructions: SolanaTokenProgramInstructionEvidence,
  execution: SolanaReferenceExecutionComparison,
  reasons: Set<SolanaReferenceReconciliationReason>,
  identityMatches: boolean,
): SolanaReferenceReconciliationCoverageStatus {
  if (!identityMatches || instructions.coverage.accountSpace === "conflicting" || hasGlobalFlowConflict(balanceFlow) ||
    execution.status === "contradictory_definitive_evidence" || execution.status === "malformed_or_contradictory_source_evidence") return "conflicting";
  const noInstructionSource = instructions.coverage.outer.status === "unavailable" && instructions.coverage.inner.status === "unavailable";
  if (!comparablePairs(balanceFlow) || noInstructionSource) return "unavailable";
  if (reasons.size > 0 || balanceFlow.status !== "complete" || instructions.coverage.outer.status !== "available" ||
    instructions.coverage.inner.status !== "available" || instructions.coverage.processing !== "complete_for_supplied_instruction_entries" ||
    instructions.coverage.accountSpace !== "consistent") return "partial";
  return "complete_for_supplied_evidence";
}

/**
 * Reconciles only references between existing Phase 2B and Phase 2C evidence.
 * It does not attribute a balance delta to an instruction or infer economic effect.
 */
export function normalizeSolanaReferenceReconciliation(
  balanceFlowInput: SolanaTokenBalanceFlowEvidence,
  instructionEvidenceInput: SolanaTokenProgramInstructionEvidence,
): SolanaReferenceReconciliationEvidence {
  validateBalanceFlow(balanceFlowInput);
  validateInstructionEvidence(instructionEvidenceInput);
  const balanceFlow = balanceFlowInput;
  const instructions = instructionEvidenceInput;
  const identityMatches = balanceFlow.chain === instructions.chain &&
    balanceFlow.transactionSignature === instructions.transactionSignature;
  const reasons = new Set<SolanaReferenceReconciliationReason>();
  const sourceCoverage = sourceCoverageFor(balanceFlow, instructions);
  if (!identityMatches) {
    addReason(reasons, "transaction_identity_mismatch");
    return {
      schemaVersion: SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION,
      chain: "solana",
      transactionIdentity: { status: "conflicting", balanceFlowSignature: balanceFlow.transactionSignature,
        instructionSignature: instructions.transactionSignature },
      sourceSchemas: { balanceFlow: balanceFlow.schemaVersion, instructionEvidence: instructions.schemaVersion },
      executionComparison: { status: "not_comparable_identity_mismatch" },
      instructionRelationships: [],
      mintReferenceComparisons: [],
      sourceCoverage,
      coverage: { status: "conflicting", reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)) },
    };
  }

  const executionComparison = compareExecution(balanceFlow, instructions);
  if (executionComparison.status === "one_or_both_unavailable") addReason(reasons, "execution_unavailable");
  if (executionComparison.status === "contradictory_definitive_evidence" ||
    executionComparison.status === "malformed_or_contradictory_source_evidence") addReason(reasons, "execution_conflicting");
  if (balanceFlow.status === "partial") addReason(reasons, "balance_flow_partial");
  if (balanceFlow.status === "unavailable") addReason(reasons, "balance_flow_unavailable");
  if (balanceFlow.status === "conflicting") addReason(reasons, "balance_flow_conflicting");
  if (balanceFlow.status === "not_applicable") addReason(reasons, "balance_flow_not_applicable");
  if (instructions.coverage.outer.status === "partial") addReason(reasons, "outer_instructions_partial");
  if (instructions.coverage.outer.status === "unavailable") addReason(reasons, "outer_instructions_unavailable");
  if (instructions.coverage.inner.status === "partial") addReason(reasons, "inner_instructions_partial");
  if (instructions.coverage.inner.status === "unavailable") addReason(reasons, "inner_instructions_unavailable");
  if (instructions.coverage.processing === "partial") addReason(reasons, "instruction_processing_partial");
  if (instructions.coverage.accountSpace === "partial") addReason(reasons, "account_space_partial");
  if (instructions.coverage.accountSpace === "conflicting" || balanceFlow.reasonCodes.includes("account_space_conflicting")) {
    addReason(reasons, "account_space_conflicting");
  }
  if (balanceFlow.reasonCodes.includes("balance_side_conflicting")) addReason(reasons, "balance_flow_conflicting");
  if (balanceFlow.reasonCodes.includes("execution_state_conflicting")) addReason(reasons, "execution_conflicting");
  if (balanceFlow.conflicts.length > 0) addReason(reasons, "pair_reference_conflict");

  const globalAccountConflict = instructions.coverage.accountSpace === "conflicting" ||
    balanceFlow.reasonCodes.includes("account_space_conflicting");
  const { relationships, mintComparisons } = relationshipRecords(balanceFlow, instructions, reasons, globalAccountConflict);
  const coverageStatus = deriveCoverage(balanceFlow, instructions, executionComparison, reasons, true);
  return {
    schemaVersion: SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION,
    chain: "solana",
    transactionIdentity: { status: "matched", signature: balanceFlow.transactionSignature },
    sourceSchemas: { balanceFlow: balanceFlow.schemaVersion, instructionEvidence: instructions.schemaVersion },
    executionComparison,
    instructionRelationships: relationships,
    mintReferenceComparisons: mintComparisons,
    sourceCoverage,
    coverage: { status: coverageStatus, reasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)) },
  };
}

function sourceCoverageFor(balanceFlow: SolanaTokenBalanceFlowEvidence, instructions: SolanaTokenProgramInstructionEvidence) {
  return sourceCoverage(balanceFlow, instructions);
}
