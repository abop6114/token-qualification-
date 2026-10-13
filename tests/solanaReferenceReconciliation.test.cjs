const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaTransactionEvidence } = require("../dist/normalization/solanaTransactionEvidence.js");
const { normalizeSolanaTokenBalanceFlowEvidence } = require("../dist/normalization/solanaTokenBalanceFlowEvidence.js");
const { decodeSolanaTokenProgramInstructionEvidence } = require("../dist/normalization/solanaTokenProgramInstructionEvidence.js");
const { normalizeSolanaReferenceReconciliation, SolanaReferenceReconciliationInputError } = require("../dist/normalization/solanaReferenceReconciliation.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let output = "";
  while (value > 0n) { output = ALPHABET[Number(value % 58n)] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = `1${output}`; }
  return output || "1";
}
const key = (n) => encodeSolanaPublicKey(Buffer.alloc(32, n));
const signature = base58(Buffer.alloc(64, 7));
const otherSignature = base58(Buffer.alloc(64, 8));
const mint = key(8);
const otherMint = key(9);
const tokenProgram = SOLANA_TOKEN_PROGRAM_IDS["spl-token"];

function data(tag = 3) {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(5n);
  const bytes = tag === 12 ? Buffer.from([tag, ...amount, 6]) : Buffer.from([tag, ...amount]);
  return base58(bytes);
}

function balance(accountIndex, amount, reportedMint = mint) {
  const tokenAddress = accountIndex === 2 ? key(3) : key(4);
  return { accountIndex, mint: reportedMint, owner: key(5),
    uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1_000_000 } };
}

function rawTransaction({
  sig = signature,
  pre = [balance(2, "10"), balance(3, "0")],
  post = [balance(2, "5"), balance(3, "5")],
  outer = [{ programIdIndex: 1, accounts: [2, 3, 4], data: data(3) }],
  inner = [],
  err = null,
  omitPre = false,
  omitPost = false,
} = {}) {
  const accountKeys = [key(1), tokenProgram, key(3), key(4), key(5), key(6), key(7), mint, key(10), key(11)];
  const meta = { err, innerInstructions: inner, loadedAddresses: { writable: [], readonly: [] },
    preTokenBalances: pre, postTokenBalances: post,
    preBalances: accountKeys.map(() => 1), postBalances: accountKeys.map(() => 1) };
  if (omitPre) delete meta.preTokenBalances;
  if (omitPost) delete meta.postTokenBalances;
  return { slot: 100, blockTime: 200, version: "legacy",
    transaction: { signatures: [sig], message: { accountKeys,
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 9 },
      instructions: outer } }, meta };
}

function sources(options = {}) {
  const transaction = normalizeSolanaTransactionEvidence(rawTransaction(options), options.sig ?? signature);
  const flow = normalizeSolanaTokenBalanceFlowEvidence(transaction);
  const instructionEvidence = decodeSolanaTokenProgramInstructionEvidence(transaction);
  return { transaction, flow, instructionEvidence };
}

function reconcile(options = {}) {
  const { flow, instructionEvidence } = sources(options);
  return normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
}

test("accepts matching Solana chain and transaction identity with exact source schema versions", () => {
  const result = reconcile();
  assert.deepEqual(result.transactionIdentity, { status: "matched", signature });
  assert.equal(result.chain, "solana");
  assert.equal(result.sourceSchemas.balanceFlow, "solana-token-balance-flow-evidence-v1");
  assert.equal(result.sourceSchemas.instructionEvidence, "solana-token-program-instruction-evidence-v1");
});

test("valid but different transaction signatures produce identity conflict and zero joins", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.transactionSignature = otherSignature;
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.deepEqual(result.transactionIdentity, { status: "conflicting", balanceFlowSignature: signature, instructionSignature: otherSignature });
  assert.deepEqual(result.instructionRelationships, []);
  assert.deepEqual(result.mintReferenceComparisons, []);
  assert.equal(result.executionComparison.status, "not_comparable_identity_mismatch");
  assert.equal(result.coverage.status, "conflicting");
});

test("rejects malformed source signatures instead of emitting identity evidence", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.transactionSignature = "not-a-signature";
  assert.throws(() => normalizeSolanaReferenceReconciliation(flow, instructionEvidence), SolanaReferenceReconciliationInputError);
});

test("rejects wrong source schema versions and non-Solana chain values", () => {
  const a = sources();
  const wrongSchema = structuredClone(a.flow);
  wrongSchema.schemaVersion = "future-schema";
  assert.throws(() => normalizeSolanaReferenceReconciliation(wrongSchema, a.instructionEvidence), /unsupported schema/);
  const wrongChain = structuredClone(a.instructionEvidence);
  wrongChain.chain = "base";
  assert.throws(() => normalizeSolanaReferenceReconciliation(a.flow, wrongChain), /unsupported schema/);
});

test("classifies identical successful execution as confirmed compatible success", () => {
  assert.deepEqual(reconcile().executionComparison, { status: "confirmed_compatible_success" });
});

test("classifies identical failed execution as compatible failure without changing delta availability", () => {
  const { flow, instructionEvidence } = sources({ err: { InstructionError: [0, "Custom"] } });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.deepEqual(result.executionComparison, { status: "confirmed_compatible_failure" });
  assert.equal(flow.status, "not_applicable");
  assert.ok(flow.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
});

test("two unavailable execution states are not called confirmed agreement", () => {
  const { flow, instructionEvidence } = sources();
  flow.transactionExecution = { status: "unavailable", reason: "meta_null" };
  instructionEvidence.transactionExecution = { status: "available", evidence: { status: "unavailable", reason: "meta_null" } };
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.executionComparison.status, "one_or_both_unavailable");
  assert.equal(result.coverage.status, "partial");
});

test("definitive success-versus-failure execution is contradictory", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.transactionExecution = { status: "available", evidence: {
    status: "failed", basis: "provider_meta_err_non_null", reportedError: { InstructionError: [0, "Custom"] },
  } };
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.executionComparison.status, "contradictory_definitive_evidence");
  assert.equal(result.coverage.status, "conflicting");
});

test("Phase 2C contradictory execution linkage is preserved as malformed source evidence", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.transactionExecution = { status: "contradictory", reason: "malformed_execution_evidence" };
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.deepEqual(result.executionComparison, { status: "malformed_or_contradictory_source_evidence", source: "instruction_evidence" });
});

test("matches source and destination references by canonical index and address", () => {
  const result = reconcile();
  const refs = result.instructionRelationships[0].accountReferences;
  assert.deepEqual(refs.map((ref) => [ref.role, ref.accountIndex, ref.matchStatus, ref.candidatePairIndexes]), [
    ["source", 2, "index_address_agreement", [0]],
    ["destination", 3, "index_address_agreement", [1]],
  ]);
});

test("reports index overlap when the Phase 2B token-account address is unavailable", () => {
  const { flow, instructionEvidence } = sources();
  flow.pairs[0].tokenAccountAddress = { status: "unavailable", value: null, reason: "unresolved_account" };
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_overlap_address_unverified");
  assert.deepEqual(result.instructionRelationships[0].accountReferences[0].candidatePairIndexes, [0]);
});

test("reports an address contradiction without discarding unrelated references", () => {
  const { flow, instructionEvidence } = sources();
  flow.pairs[0].tokenAccountAddress = { status: "available", value: key(12) };
  flow.pairs[0].status = "conflicting";
  flow.conflicts.push({ reason: "account_address_mismatch", accountIndex: 2, mint,
    preProviderArrayIndexes: [0], postProviderArrayIndexes: [0] });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_address_contradiction");
  assert.equal(result.instructionRelationships[0].accountReferences[1].matchStatus, "index_address_agreement");
  assert.ok(result.coverage.reasonCodes.includes("pair_reference_conflict"));
  assert.equal(result.coverage.status, "partial");
});

test("unresolved reference with one candidate remains unresolved and preserves contextual index", () => {
  const { flow, instructionEvidence } = sources();
  const ref = instructionEvidence.instructions[0].decode.accounts[0].reference;
  ref.status = "unresolved";
  ref.address = null;
  ref.reason = "account_space_partial";
  instructionEvidence.instructions[0].sourceInstruction.accounts[0] = structuredClone(ref);
  instructionEvidence.instructions[0].sourceInstruction.status = "partial";
  instructionEvidence.coverage.accountSpace = "partial";
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  const source = result.instructionRelationships[0].accountReferences[0];
  assert.equal(source.matchStatus, "instruction_reference_unresolved");
  assert.equal(source.address, null);
  assert.deepEqual(source.candidatePairIndexes, [0]);
  assert.equal(source.referenceStatus, "unresolved");
  assert.ok(result.coverage.reasonCodes.includes("unresolved_instruction_reference"));
  assert.equal(source.matchStatus === "index_address_agreement", false);
  assert.equal(result.coverage.status, "partial");
});

test("unresolved reference with multiple distinct-mint candidates stays unresolved, not ambiguous", () => {
  const { flow, instructionEvidence } = sources();
  const duplicateIndexPair = structuredClone(flow.pairs[0]);
  duplicateIndexPair.mint = otherMint;
  duplicateIndexPair.status = "conflicting";
  flow.pairs.push(duplicateIndexPair);
  flow.conflicts.push({ reason: "account_index_multiple_mints", accountIndex: 2, mint: null,
    preProviderArrayIndexes: [0], postProviderArrayIndexes: [0] });
  const ref = instructionEvidence.instructions[0].decode.accounts[0].reference;
  ref.status = "unresolved";
  ref.address = null;
  ref.reason = "account_space_partial";
  instructionEvidence.instructions[0].sourceInstruction.accounts[0] = structuredClone(ref);
  instructionEvidence.instructions[0].sourceInstruction.status = "partial";
  instructionEvidence.coverage.accountSpace = "partial";
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  const source = result.instructionRelationships[0].accountReferences[0];
  assert.equal(source.matchStatus, "instruction_reference_unresolved");
  assert.deepEqual(source.candidatePairIndexes, [0, 2]);
  assert.equal(source.address, null);
  assert.ok(result.coverage.reasonCodes.includes("unresolved_instruction_reference"));
  assert.equal(result.coverage.reasonCodes.includes("ambiguous_account_index"), false);
  assert.equal(result.coverage.status, "partial");
});

test("unresolved reference with no candidate pair remains unresolved", () => {
  const { flow, instructionEvidence } = sources();
  const ref = instructionEvidence.instructions[0].decode.accounts[0].reference;
  ref.status = "unresolved";
  ref.address = null;
  ref.reason = "account_space_partial";
  instructionEvidence.instructions[0].sourceInstruction.accounts[0] = structuredClone(ref);
  instructionEvidence.instructions[0].sourceInstruction.status = "partial";
  instructionEvidence.coverage.accountSpace = "partial";
  flow.pairs = [];
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  const source = result.instructionRelationships[0].accountReferences[0];
  assert.equal(source.matchStatus, "instruction_reference_unresolved");
  assert.deepEqual(source.candidatePairIndexes, []);
  assert.equal(source.address, null);
  assert.ok(result.coverage.reasonCodes.includes("unresolved_instruction_reference"));
  assert.equal(result.coverage.reasonCodes.includes("ambiguous_account_index"), false);
});

test("reports no pair only for available or partial supplied Phase 2B evidence", () => {
  const result = reconcile({ pre: [], post: [] });
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "no_pair_in_supplied_evidence");
});

test("ambiguous distinct-mint pairs at one account index preserve every candidate", () => {
  const { flow, instructionEvidence } = sources();
  const duplicateIndexPair = structuredClone(flow.pairs[0]);
  duplicateIndexPair.mint = otherMint;
  duplicateIndexPair.status = "conflicting";
  flow.pairs.push(duplicateIndexPair);
  flow.conflicts.push({ reason: "account_index_multiple_mints", accountIndex: 2, mint: null,
    preProviderArrayIndexes: [0], postProviderArrayIndexes: [0] });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  const source = result.instructionRelationships[0].accountReferences[0];
  assert.equal(source.matchStatus, "ambiguous_account_index");
  assert.deepEqual(source.candidatePairIndexes, [0, 2]);
});

test("an unresolved reference preserves multi-mint candidates without asserting ambiguity", () => {
  const { flow, instructionEvidence } = sources();
  const duplicateIndexPair = structuredClone(flow.pairs[0]);
  duplicateIndexPair.mint = otherMint;
  flow.pairs.push(duplicateIndexPair);
  flow.conflicts.push({ reason: "account_index_multiple_mints", accountIndex: 2, mint: null,
    preProviderArrayIndexes: [0], postProviderArrayIndexes: [0] });
  const ref = instructionEvidence.instructions[0].decode.accounts[0].reference;
  ref.status = "unresolved";
  ref.address = null;
  ref.reason = "account_space_partial";
  instructionEvidence.instructions[0].sourceInstruction.accounts[0] = structuredClone(ref);
  instructionEvidence.instructions[0].sourceInstruction.status = "partial";
  instructionEvidence.coverage.accountSpace = "partial";
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "instruction_reference_unresolved");
  assert.deepEqual(result.instructionRelationships[0].accountReferences[0].candidatePairIndexes, [0, 2]);
  assert.ok(result.coverage.reasonCodes.includes("unresolved_instruction_reference"));
  assert.equal(result.coverage.reasonCodes.includes("ambiguous_account_index"), false);
});

test("matches explicit resolved mint_reference strings separately and returns every pair index", () => {
  const checked = rawTransaction({ outer: [{ programIdIndex: 1, accounts: [2, 7, 3, 4], data: data(12) }] });
  const transaction = normalizeSolanaTransactionEvidence(checked, signature);
  const flow = normalizeSolanaTokenBalanceFlowEvidence(transaction);
  const instructionEvidence = decodeSolanaTokenProgramInstructionEvidence(transaction);
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.deepEqual(result.mintReferenceComparisons.map((item) => [item.matchStatus, item.candidatePairIndexes]), [
    ["reported_mint_string_match", [0, 1]],
  ]);
  assert.equal(result.instructionRelationships[0].accountReferences.some((item) => item.role === "mint_reference"), false);
});

test("explicit mint-reference mismatch is separate from token-account relationship", () => {
  const checked = rawTransaction({ outer: [{ programIdIndex: 1, accounts: [2, 7, 3, 4], data: data(12) }] });
  const transaction = normalizeSolanaTransactionEvidence(checked, signature);
  const flow = normalizeSolanaTokenBalanceFlowEvidence(transaction);
  flow.pairs.forEach((pair) => { pair.mint = otherMint; });
  const instructionEvidence = decodeSolanaTokenProgramInstructionEvidence(transaction);
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.mintReferenceComparisons[0].matchStatus, "reported_mint_string_mismatch");
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_address_agreement");
  assert.equal(result.coverage.reasonCodes.includes("pair_reference_conflict"), false);
});

test("unmatched explicit mint under partial Phase 2B coverage is not a confirmed conflict", () => {
  const checked = rawTransaction({ outer: [{ programIdIndex: 1, accounts: [2, 7, 3, 4], data: data(12) }] });
  const transaction = normalizeSolanaTransactionEvidence(checked, signature);
  const flow = normalizeSolanaTokenBalanceFlowEvidence(transaction);
  flow.pairs.forEach((pair) => { pair.mint = otherMint; });
  flow.status = "partial";
  flow.reasonCodes.push("unmatched_post");
  const instructionEvidence = decodeSolanaTokenProgramInstructionEvidence(transaction);
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.mintReferenceComparisons[0].matchStatus, "reported_mint_string_mismatch");
  assert.deepEqual(result.mintReferenceComparisons[0].candidatePairIndexes, []);
  assert.equal(result.coverage.status, "partial");
  assert.equal(result.coverage.reasonCodes.includes("pair_reference_conflict"), false);
});

test("unchecked Transfer has no mint comparison and does not infer a mint", () => {
  const result = reconcile();
  assert.deepEqual(result.mintReferenceComparisons, []);
  assert.ok(result.instructionRelationships[0].accountReferences.every((item) => item.role !== "mint_reference"));
});

test("preserves inner instruction location and relationships", () => {
  const inner = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2, 3, 4], data: data(3) }] }];
  const result = reconcile({ inner });
  const record = result.instructionRelationships.find((item) => item.location.instructionSet === "inner");
  assert.ok(record);
  assert.equal(record.location.outerInstructionIndex, 0);
  assert.equal(record.location.innerGroupPosition, 0);
  assert.equal(record.location.innerInstructionIndex, 0);
  assert.equal(record.accountReferences[0].matchStatus, "index_address_agreement");
});

test("multiple instructions sharing one pair remain separate and receive no allocated delta", () => {
  const instruction = { programIdIndex: 1, accounts: [2, 3, 4], data: data(3) };
  const result = reconcile({ outer: [instruction, instruction] });
  assert.equal(result.instructionRelationships.length, 2);
  assert.deepEqual(result.instructionRelationships.map((item) => item.instructionSourceIndex), [0, 1]);
  assert.deepEqual(result.instructionRelationships.map((item) => item.accountReferences[0].candidatePairIndexes), [[0], [0]]);
  assert.ok(result.instructionRelationships.every((item) => !Object.hasOwn(item, "rawDelta")));
});

test("failed transaction keeps instruction observations while Phase 2B deltas remain unavailable", () => {
  const { flow, instructionEvidence } = sources({ err: { InstructionError: [0, "Custom"] } });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships.length, 1);
  assert.ok(flow.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  assert.equal(result.executionComparison.status, "confirmed_compatible_failure");
});

test("exact zero net balance change remains only in Phase 2B source evidence", () => {
  const { flow, instructionEvidence } = sources({ pre: [balance(2, "10"), balance(3, "0")], post: [balance(2, "10"), balance(3, "0")] });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(flow.pairs[0].rawDelta.value, "0");
  assert.ok(result.instructionRelationships.every((item) => !Object.hasOwn(item, "rawDelta")));
  assert.equal(result.coverage.status, "complete_for_supplied_evidence");
});

test("partial Phase 2B coverage preserves known matches and marks reconciliation partial", () => {
  const { flow, instructionEvidence } = sources();
  flow.status = "partial";
  flow.reasonCodes.push("unmatched_post");
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_address_agreement");
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.coverage.reasonCodes.includes("balance_flow_partial"));
});

test("unavailable Phase 2B with empty pairs is not converted to no-pair evidence", () => {
  const { flow, instructionEvidence } = sources();
  flow.status = "unavailable";
  flow.pairs = [];
  flow.reasonCodes.push("balance_side_unavailable");
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "not_comparable");
  assert.equal(result.coverage.status, "unavailable");
  assert.ok(result.coverage.reasonCodes.includes("balance_flow_unavailable"));
});

test("not_applicable Phase 2B with empty pairs is not converted to no-pair evidence", () => {
  const { flow, instructionEvidence } = sources({ err: { InstructionError: [0, "Custom"] } });
  flow.status = "not_applicable";
  flow.pairs = [];
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "not_comparable");
  assert.equal(result.coverage.status, "unavailable");
  assert.ok(result.coverage.reasonCodes.includes("balance_flow_not_applicable"));
});

test("explicitly available empty Phase 2B evidence can report no supplied pair", () => {
  const result = reconcile({ pre: [], post: [] });
  assert.equal(result.sourceCoverage.balanceFlowStatus, "complete");
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "no_pair_in_supplied_evidence");
});

test("entirely unsupported instruction collections are partial, not absent activity", () => {
  const result = reconcile({ outer: [{ programIdIndex: 1, accounts: [2, 3, 4], data: data(99) }] });
  assert.equal(result.instructionRelationships[0].decodeStatus, "unsupported_variant");
  assert.deepEqual(result.instructionRelationships[0].accountReferences, []);
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.coverage.reasonCodes.includes("unsupported_or_malformed_instruction"));
});

test("empty but explicitly available instruction collections remain distinct and can be complete", () => {
  const result = reconcile({ outer: [], inner: [], pre: [], post: [] });
  assert.equal(result.sourceCoverage.instructionOuter.status, "available");
  assert.equal(result.sourceCoverage.instructionInner.status, "available");
  assert.deepEqual(result.instructionRelationships, []);
  assert.equal(result.coverage.status, "complete_for_supplied_evidence");
});

test("unavailable instruction collections remain unavailable rather than empty-complete", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.coverage.outer.status = "unavailable";
  instructionEvidence.coverage.inner.status = "unavailable";
  instructionEvidence.coverage.outer.reason = "field_missing";
  instructionEvidence.coverage.inner.reason = "field_missing";
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.coverage.status, "unavailable");
  assert.ok(result.coverage.reasonCodes.includes("outer_instructions_unavailable"));
});

test("Phase 2C partial account space permits resolved references and preserves unresolved ones", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.coverage.accountSpace = "partial";
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_address_agreement");
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.coverage.reasonCodes.includes("account_space_partial"));
});

test("a local Phase 2B conflict leaves an unrelated valid relationship intact", () => {
  const { flow, instructionEvidence } = sources();
  flow.status = "conflicting";
  flow.conflicts.push({ reason: "decimals_mismatch", accountIndex: 2, mint,
    preProviderArrayIndexes: [0], postProviderArrayIndexes: [0] });
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].accountReferences[0].matchStatus, "index_address_agreement");
  assert.equal(result.instructionRelationships[0].accountReferences[1].matchStatus, "index_address_agreement");
  assert.equal(result.coverage.status, "partial");
});

test("transaction-wide Phase 2B balance-side conflict prevents all index joins", () => {
  const { flow, instructionEvidence } = sources();
  flow.status = "conflicting";
  flow.reasonCodes.push("balance_side_conflicting");
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.ok(result.instructionRelationships[0].accountReferences.every((item) => item.matchStatus === "not_comparable"));
  assert.equal(result.coverage.status, "conflicting");
});

test("Phase 2C canonical account-space conflict prevents index-based relationships", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.coverage.accountSpace = "conflicting";
  instructionEvidence.coverage.reasonCodes.push("account_space_conflicting");
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.ok(result.instructionRelationships[0].accountReferences.every((item) => item.matchStatus === "not_comparable"));
  assert.equal(result.coverage.status, "conflicting");
});

test("malformed instruction entries remain explicit and make coverage partial", () => {
  const { flow, instructionEvidence } = sources();
  const malformed = structuredClone(instructionEvidence.instructions[0]);
  malformed.sourceInstruction = null;
  malformed.sourceInstructionReason = "malformed_compiled_instruction";
  malformed.sourceProgram = null;
  malformed.dataBase58 = null;
  malformed.decode = { decodeStatus: "source_instruction_unavailable", variant: null, tag: null, rawAmount: null,
    decimals: null, trailingByteCount: null, accounts: [], reason: "malformed_compiled_instruction" };
  instructionEvidence.instructions[0] = malformed;
  const result = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.equal(result.instructionRelationships[0].decodeStatus, "source_instruction_unavailable");
  assert.equal(result.coverage.status, "partial");
});

test("orders relationships deterministically and does not mutate either input", () => {
  const instruction = { programIdIndex: 1, accounts: [2, 3, 4], data: data(3) };
  const { flow, instructionEvidence } = sources({ outer: [instruction, instruction] });
  const flowBefore = structuredClone(flow);
  const instructionsBefore = structuredClone(instructionEvidence);
  const first = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  const second = normalizeSolanaReferenceReconciliation(flow, instructionEvidence);
  assert.deepEqual(first, second);
  assert.deepEqual(first.instructionRelationships.map((item) => item.instructionSourceIndex), [0, 1]);
  assert.deepEqual(flow, flowBefore);
  assert.deepEqual(instructionEvidence, instructionsBefore);
});

test("rejects inconsistent decoded roles rather than trusting fabricated account labels", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.instructions[0].decode.accounts[0].role = "destination";
  assert.throws(() => normalizeSolanaReferenceReconciliation(flow, instructionEvidence), /Phase 2C evidence is malformed/);
});

test("rejects Phase 2C coverage counts that contradict its supplied instruction records", () => {
  const { flow, instructionEvidence } = sources();
  instructionEvidence.coverage.outer.suppliedEntryCount = 0;
  assert.throws(() => normalizeSolanaReferenceReconciliation(flow, instructionEvidence), /Phase 2C evidence is malformed|counts do not reconcile/);
});
