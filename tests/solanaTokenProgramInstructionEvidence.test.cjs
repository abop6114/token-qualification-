const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaTransactionEvidence } = require("../dist/normalization/solanaTransactionEvidence.js");
const { decodeSolanaTokenProgramInstructionEvidence } = require("../dist/normalization/solanaTokenProgramInstructionEvidence.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let output = "";
  while (value > 0n) {
    output = ALPHABET[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}
const key = (byte) => base58(Buffer.alloc(32, byte));
const signature = base58(Buffer.alloc(64, 7));

function instructionData(tag, amount = 0n, decimals = null, trailing = []) {
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(amount);
  return base58(Buffer.from([tag, ...amountBytes, ...(decimals === null ? [] : [decimals]), ...trailing]));
}

function rawTransaction({ program = SOLANA_TOKEN_PROGRAM_IDS["spl-token"], data = instructionData(3, 5n), accountIndices = [2, 3, 4], inner = false } = {}) {
  const accountKeys = [key(1), program, ...Array.from({ length: 12 }, (_, index) => key(index + 2))];
  const compiled = { programIdIndex: 1, accounts: accountIndices, data };
  return {
    slot: 1,
    blockTime: 2,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        instructions: [compiled],
      },
    },
    meta: {
      err: null,
      innerInstructions: inner ? [{ index: 0, instructions: [compiled] }] : [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [],
      postTokenBalances: [],
      preBalances: Array(accountKeys.length).fill(1),
      postBalances: Array(accountKeys.length).fill(1),
    },
    version: "legacy",
  };
}

function normalized(options) {
  return normalizeSolanaTransactionEvidence(rawTransaction(options), signature);
}

test("decodes all six pinned base variants under both supported token programs", () => {
  const cases = [
    [3, "transfer", ["source", "destination", "authority_or_multisig"], null],
    [12, "transfer_checked", ["source", "mint_reference", "destination", "authority_or_multisig"], 9],
    [7, "mint_to", ["mint_reference", "destination", "authority_or_multisig"], null],
    [14, "mint_to_checked", ["mint_reference", "destination", "authority_or_multisig"], 9],
    [8, "burn", ["source", "mint_reference", "authority_or_multisig"], null],
    [15, "burn_checked", ["source", "mint_reference", "authority_or_multisig"], 9],
  ];
  for (const [program, identity] of [[SOLANA_TOKEN_PROGRAM_IDS["spl-token"], "spl-token"], [SOLANA_TOKEN_PROGRAM_IDS["token-2022"], "token-2022"]]) {
    for (const [tag, variant, roles, decimals] of cases) {
      const data = instructionData(tag, 1234567890123456789n, decimals);
      const evidence = decodeSolanaTokenProgramInstructionEvidence(normalized({ program, data, accountIndices: Array.from({ length: roles.length }, (_, i) => i + 2) }));
      const instruction = evidence.instructions[0];
      assert.equal(instruction.programIdentity, identity);
      assert.equal(instruction.decode.decodeStatus, "decoded_supported");
      assert.equal(instruction.decode.variant, variant);
      assert.equal(instruction.decode.tag, tag);
      assert.equal(instruction.decode.rawAmount, "1234567890123456789");
      assert.equal(instruction.decode.decimals, decimals);
      assert.deepEqual(instruction.decode.accounts.map((account) => account.role), roles);
    }
  }
});

test("decodes u64 zero and maximum exactly without Number conversion", () => {
  for (const amount of [0n, 18446744073709551615n]) {
    const result = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(3, amount) }));
    assert.equal(result.instructions[0].decode.rawAmount, amount.toString());
  }
});

test("distinguishes checked decimals from unchecked variants", () => {
  const checked = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(12, 1n, 6), accountIndices: [2, 3, 4, 5] }));
  const unchecked = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(3, 1n) }));
  assert.equal(checked.instructions[0].decode.decimals, 6);
  assert.equal(unchecked.instructions[0].decode.decimals, null);
});

test("retains explicit mint references without asserting mint identity", () => {
  const result = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(12, 1n, 4), accountIndices: [2, 3, 4, 5] }));
  assert.equal(result.instructions[0].decode.accounts[1].role, "mint_reference");
  assert.equal(result.instructions[0].decode.accounts[1].reference.address, key(3));
});

test("truncated known payloads and malformed source entries remain distinct", () => {
  const truncated = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: base58(Buffer.from([3, 1, 2])) }));
  assert.equal(truncated.instructions[0].decode.decodeStatus, "malformed_payload");
  assert.equal(truncated.instructions[0].decode.reason, "truncated_payload");

  const tx = normalized();
  tx.outerInstructions.entries[0] = { status: "malformed", position: 0, reason: "malformed_compiled_instruction" };
  tx.outerInstructions.status = "partial";
  tx.outerInstructions.reason = "malformed";
  const malformed = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(malformed.instructions[0].decode.decodeStatus, "source_instruction_unavailable");
});

test("preserves accepted trailing bytes without inferring their meaning", () => {
  const result = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(3, 8n, null, [0xaa, 0xbb]) }));
  assert.equal(result.instructions[0].decode.decodeStatus, "decoded_supported");
  assert.equal(result.instructions[0].decode.rawAmount, "8");
  assert.equal(result.instructions[0].decode.trailingByteCount, 2);
});

test("keeps unknown and Token-2022 extension tags unsupported rather than malformed", () => {
  for (const tag of [25, 255]) {
    const result = decodeSolanaTokenProgramInstructionEvidence(normalized({ program: SOLANA_TOKEN_PROGRAM_IDS["token-2022"], data: base58(Buffer.from([tag, 1, 2])) }));
    assert.equal(result.instructions[0].decode.decodeStatus, "unsupported_variant");
    assert.equal(result.instructions[0].decode.tag, tag);
  }
});

test("distinguishes unsupported programs and unresolved program references", () => {
  const unsupported = decodeSolanaTokenProgramInstructionEvidence(normalized({ program: key(99) }));
  assert.equal(unsupported.instructions[0].decode.decodeStatus, "unsupported_program");

  const unresolvedTx = normalized();
  const source = unresolvedTx.outerInstructions.entries[0].instruction;
  source.programIdIndex = 99;
  source.program = { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" };
  source.status = "partial";
  const unresolved = decodeSolanaTokenProgramInstructionEvidence(unresolvedTx);
  assert.equal(unresolved.instructions[0].decode.decodeStatus, "unresolved_program");
});

test("preserves unresolved account references without presenting a fully resolved instruction", () => {
  const tx = normalized();
  const source = tx.outerInstructions.entries[0].instruction;
  source.accountIndices[0] = 99;
  source.accounts[0] = { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" };
  source.status = "partial";
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.instructions[0].decode.decodeStatus, "account_reference_unresolved");
  assert.equal(result.instructions[0].decode.accounts[0].reference.status, "unresolved");
});

test("labels multisigner-shaped account positions as references only", () => {
  const result = decodeSolanaTokenProgramInstructionEvidence(normalized({ data: instructionData(3, 1n), accountIndices: [2, 3, 4, 5, 6] }));
  assert.deepEqual(result.instructions[0].decode.accounts.map((entry) => entry.role), [
    "source", "destination", "authority_or_multisig", "additional_signer_reference", "additional_signer_reference",
  ]);
  assert.equal(result.instructions[0].decode.accounts[3].reference.address, key(5));
});

test("preserves outer and inner instruction locations and parent indexes", () => {
  const outer = decodeSolanaTokenProgramInstructionEvidence(normalized());
  assert.deepEqual(outer.instructions[0].location, { instructionSet: "outer", outerInstructionIndex: 0, innerGroupPosition: null, innerInstructionIndex: null });
  const inner = decodeSolanaTokenProgramInstructionEvidence(normalized({ inner: true }));
  assert.deepEqual(inner.instructions[1].location, { instructionSet: "inner", outerInstructionIndex: 0, innerGroupPosition: 0, innerInstructionIndex: 0 });
});

test("distinguishes missing inner instruction coverage from explicitly empty coverage", () => {
  const missingTx = normalized();
  missingTx.innerInstructions = { status: "unavailable", reason: "field_missing", reportedGroupCount: null, groups: [] };
  const missing = decodeSolanaTokenProgramInstructionEvidence(missingTx);
  assert.equal(missing.coverage.inner.status, "unavailable");
  assert.equal(missing.coverage.inner.reason, "field_missing");

  const empty = decodeSolanaTokenProgramInstructionEvidence(normalized());
  assert.equal(empty.coverage.inner.status, "available");
  assert.equal(empty.coverage.inner.suppliedEntryCount, 0);
});

test("preserves valid partial account-space evidence and marks unresolved references", () => {
  const tx = normalized();
  tx.accountSpace.status = "partial";
  tx.accountSpace.reason = "lookup_metadata_missing";
  tx.accountSpace.addressTableLookups = { status: "unavailable", value: null, reason: "missing" };
  const source = tx.outerInstructions.entries[0].instruction;
  source.program = { accountIndex: 99, status: "unresolved", address: null, reason: "account_space_partial" };
  source.programIdIndex = 99;
  source.status = "partial";
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.coverage.accountSpace, "partial");
  assert.equal(result.instructions[0].decode.decodeStatus, "unresolved_program");
  assert.equal(result.coverage.processing, "complete_for_supplied_instruction_entries");
});

test("index_out_of_range in partial account space is instruction-local malformed evidence, not a global conflict", () => {
  const tx = normalized();
  tx.accountSpace.status = "partial";
  tx.accountSpace.reason = "lookup_metadata_missing";
  tx.accountSpace.addressTableLookups = { status: "unavailable", value: null, reason: "missing" };
  const instruction = tx.outerInstructions.entries[0].instruction;
  instruction.programIdIndex = 99;
  instruction.program = { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" };
  instruction.status = "partial";

  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.instructions[0].decode.decodeStatus, "source_instruction_unavailable");
  assert.equal(result.coverage.accountSpace, "partial");
  assert.equal(result.coverage.processing, "partial");
});

test("malformed instruction data is not confused with an account-space conflict", () => {
  const tx = normalized();
  tx.outerInstructions.entries[0].instruction.data = "0";
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.coverage.accountSpace, "consistent");
  assert.equal(result.instructions[0].decode.decodeStatus, "malformed_payload");
  assert.equal(result.instructions[0].decode.reason, "malformed_base58_data");
});

test("malformed normalized instruction rows downgrade collection and processing coverage", () => {
  const tx = normalized();
  tx.outerInstructions.entries[0].instruction.position = 1;
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.coverage.outer.status, "partial");
  assert.equal(result.coverage.outer.processedEntryCount, 1);
  assert.equal(result.coverage.processing, "partial");
  assert.equal(result.coverage.accountSpace, "consistent");
  assert.equal(result.instructions[0].decode.decodeStatus, "source_instruction_unavailable");
});

test("preserves successful, failed, unavailable, and contradictory execution evidence independently", () => {
  const succeeded = decodeSolanaTokenProgramInstructionEvidence(normalized());
  assert.deepEqual(succeeded.transactionExecution, { status: "available", evidence: { status: "succeeded", basis: "provider_meta_err_null" } });

  const failedTx = normalized();
  failedTx.execution = { status: "failed", basis: "provider_meta_err_non_null", reportedError: { InstructionError: [0, "Custom"] } };
  assert.equal(decodeSolanaTokenProgramInstructionEvidence(failedTx).transactionExecution.evidence.status, "failed");

  const unknownTx = normalized();
  unknownTx.execution = { status: "unavailable", reason: "meta_null" };
  assert.deepEqual(decodeSolanaTokenProgramInstructionEvidence(unknownTx).transactionExecution, {
    status: "available", evidence: { status: "unavailable", reason: "meta_null" },
  });

  const contradictoryTx = normalized();
  contradictoryTx.execution = { status: "succeeded", basis: "made_up" };
  const contradictory = decodeSolanaTokenProgramInstructionEvidence(contradictoryTx);
  assert.equal(contradictory.transactionExecution.status, "contradictory");
  assert.ok(contradictory.coverage.reasonCodes.includes("execution_evidence_contradictory"));
});

test("a transaction-wide account-space contradiction suppresses decoded payloads", () => {
  const tx = normalized();
  tx.accountSpace.accounts[1].address = tx.accountSpace.accounts[0].address;
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.coverage.accountSpace, "conflicting");
  assert.equal(result.coverage.reasonCodes.includes("account_space_conflicting"), true);
  assert.equal(result.instructions[0].decode.decodeStatus, "account_space_conflicting");
});

test("isolated unresolved references do not become transaction-wide account-space conflicts", () => {
  const tx = normalized();
  const instruction = tx.outerInstructions.entries[0].instruction;
  instruction.accountIndices[0] = 99;
  instruction.accounts[0] = { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" };
  instruction.status = "partial";
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.equal(result.coverage.accountSpace, "consistent");
  assert.equal(result.instructions[0].decode.decodeStatus, "account_reference_unresolved");
});

test("a valid unresolved instruction does not prevent another supported instruction from decoding", () => {
  const tx = normalized();
  const unresolved = tx.outerInstructions.entries[0].instruction;
  unresolved.accountIndices[0] = 99;
  unresolved.accounts[0] = { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" };
  unresolved.status = "partial";
  const valid = structuredClone(unresolved);
  valid.position = 1;
  valid.accountIndices[0] = 2;
  valid.accounts[0] = { accountIndex: 2, status: "resolved", address: key(2) };
  valid.status = "complete";
  tx.outerInstructions.entries.push({ status: "available", instruction: valid });
  tx.outerInstructions.reportedCount = 2;

  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.deepEqual(result.instructions.map((item) => item.decode.decodeStatus), ["account_reference_unresolved", "decoded_supported"]);
  assert.equal(result.coverage.accountSpace, "consistent");
  assert.equal(result.coverage.processing, "complete_for_supplied_instruction_entries");
});

test("a contradictory resolved reference is isolated to its instruction", () => {
  const tx = normalized();
  const contradictory = tx.outerInstructions.entries[0].instruction;
  contradictory.accounts[0].address = key(99);
  const valid = structuredClone(contradictory);
  valid.position = 1;
  valid.accounts[0] = { accountIndex: 2, status: "resolved", address: key(2) };
  tx.outerInstructions.entries.push({ status: "available", instruction: valid });
  tx.outerInstructions.reportedCount = 2;

  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.deepEqual(result.instructions.map((item) => item.decode.decodeStatus), ["source_instruction_unavailable", "decoded_supported"]);
  assert.equal(result.coverage.accountSpace, "consistent");
  assert.equal(result.coverage.processing, "partial");
});

test("preserves mixed supported and unsupported instructions without economic labels", () => {
  const tx = normalized();
  const instruction = tx.outerInstructions.entries[0].instruction;
  tx.outerInstructions.entries.push({ status: "available", instruction: { ...instruction, position: 1, programIdIndex: 1, program: { accountIndex: 1, status: "resolved", address: SOLANA_TOKEN_PROGRAM_IDS["spl-token"] }, data: instructionData(9) } });
  tx.outerInstructions.reportedCount = 2;
  const result = decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.deepEqual(result.instructions.map((item) => item.decode.decodeStatus), ["decoded_supported", "unsupported_variant"]);
  assert.equal(JSON.stringify(result).toLowerCase().includes("buy"), false);
  assert.equal(JSON.stringify(result).toLowerCase().includes("sell"), false);
  assert.equal(JSON.stringify(result).toLowerCase().includes("trade"), false);
});

test("reports malformed required account lists without decoding an effect", () => {
  const missingRequired = decodeSolanaTokenProgramInstructionEvidence(normalized({ accountIndices: [2] }));
  assert.equal(missingRequired.instructions[0].decode.decodeStatus, "malformed_account_list");
  assert.equal(missingRequired.instructions[0].decode.reason, "required_account_missing");

  const tooMany = decodeSolanaTokenProgramInstructionEvidence(normalized({ accountIndices: Array.from({ length: 15 }, (_, index) => index + 2) }));
  assert.equal(tooMany.instructions[0].decode.decodeStatus, "malformed_account_list");
  assert.equal(tooMany.instructions[0].decode.reason, "too_many_additional_signers");
});

test("does not mutate the transaction evidence input", () => {
  const tx = normalized({ data: instructionData(12, 42n, 8) });
  const before = structuredClone(tx);
  decodeSolanaTokenProgramInstructionEvidence(tx);
  assert.deepEqual(tx, before);
});
