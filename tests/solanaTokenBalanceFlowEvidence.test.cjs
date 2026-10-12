const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaTokenBalanceFlowEvidence } = require("../dist/normalization/solanaTokenBalanceFlowEvidence.js");
const { normalizeSolanaTransactionEvidence } = require("../dist/normalization/solanaTransactionEvidence.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (n) => encodeSolanaPublicKey(Buffer.alloc(32, n));
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (value > 0n) { result = ALPHABET[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result || "1";
}
const signature = base58(Buffer.alloc(64, 7));
const MINT_A = key(50);
const MINT_B = key(51);
const TOKENS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function balance(index, mint = MINT_A, amount = "100", options = {}) {
  const uiTokenAmount = { amount, decimals: options.decimals ?? 6 };
  if (options.omitAmount) delete uiTokenAmount.amount;
  if (options.uiOnly) { delete uiTokenAmount.amount; uiTokenAmount.uiAmount = 1.25; }
  if (options.nullAmount) uiTokenAmount.amount = null;
  if (options.malformedAmount) uiTokenAmount.amount = "";
  if (options.decimalsValue !== undefined) uiTokenAmount.decimals = options.decimalsValue;
  const row = { accountIndex: index, mint, uiTokenAmount };
  if (options.owner !== "omit") {
    if (options.owner === null) row.owner = null;
    else if (typeof options.owner === "string") row.owner = options.owner;
    else row.owner = key(80 + index);
  }
  if (options.programId) row.programId = options.programId;
  return row;
}

function rawTransaction(pre = [], post = [], options = {}) {
  const accountKeys = options.accountKeys ?? [key(1), key(2), key(3), key(4), key(5)];
  const meta = {
    err: options.err ?? null,
    innerInstructions: [],
    loadedAddresses: options.loadedAddresses ?? { writable: [], readonly: [] },
    preTokenBalances: pre,
    postTokenBalances: post,
    preBalances: accountKeys.map(() => 10),
    postBalances: accountKeys.map(() => 10),
  };
  if (options.omitPre) delete meta.preTokenBalances;
  if (options.nullPre) meta.preTokenBalances = null;
  if (options.omitPost) delete meta.postTokenBalances;
  if (options.nullPost) meta.postTokenBalances = null;
  if (options.omitErr) delete meta.err;
  if (options.meta === null) return { slot: 1, transaction: { signatures: [signature], message: { accountKeys, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] } }, meta: null, version: options.version ?? "legacy" };
  const transaction = {
    slot: 1,
    transaction: { signatures: [signature], message: {
      accountKeys,
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: Math.max(0, accountKeys.length - 1) },
      instructions: options.outerInstructions ?? [],
      ...(options.lookups === undefined ? {} : { addressTableLookups: options.lookups }),
    } },
    meta,
    version: options.version ?? "legacy",
  };
  if (options.metaMissing) delete transaction.meta;
  return transaction;
}

function evidence(pre = [], post = [], options = {}) {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction(pre, post, options), signature);
  return normalizeSolanaTokenBalanceFlowEvidence(normalized, options.phase2AContext);
}

function one(result) { assert.equal(result.pairs.length, 1); return result.pairs[0]; }

test("derives unchanged, positive, and negative raw balance deltas exactly", () => {
  assert.equal(one(evidence([balance(0, MINT_A, "100")], [balance(0, MINT_A, "100")])).rawDelta.value, "0");
  assert.equal(one(evidence([balance(0, MINT_A, "100")], [balance(0, MINT_A, "125")])).rawDelta.value, "25");
  assert.equal(one(evidence([balance(0, MINT_A, "125")], [balance(0, MINT_A, "100")])).rawDelta.value, "-25");
});

test("uses BigInt for values beyond Number.MAX_SAFE_INTEGER and preserves leading-zero input", () => {
  const result = evidence([balance(0, MINT_A, "900719925474099312345")], [balance(0, MINT_A, "900719925474099412345")]);
  assert.equal(one(result).rawDelta.value, "100000");
  assert.equal(one(evidence([balance(0, MINT_A, "0009")], [balance(0, MINT_A, "0010")])).rawDelta.value, "1");
});

test("explicit zero balances are exact observations, not missing-side inference", () => {
  const result = evidence([balance(0, MINT_A, "0")], [balance(0, MINT_A, "0")]);
  assert.equal(result.status, "complete");
  assert.equal(one(result).preRawAmount.value, "0");
  assert.equal(one(result).rawDelta.value, "0");
});

test("nonexact, missing, null, and malformed amount evidence never produces a delta", () => {
  for (const [sourceAmount, option, expectedReason] of [
    ["1.25", {}, "amount_not_exact"],
    ["100", { omitAmount: true }, "amount_unavailable"],
    ["100", { nullAmount: true }, "amount_unavailable"],
    ["100", { malformedAmount: true }, "amount_unavailable"],
  ]) {
    const result = evidence([balance(0, MINT_A, sourceAmount, option)], [balance(0, MINT_A, "120")]);
    assert.equal(result.status, "partial");
    assert.equal(one(result).rawDelta.status, "unavailable");
    assert.ok(result.reasonCodes.includes(expectedReason));
  }
  for (const [numericAmount, type] of [[100, "safe_integer_number"], [Number.MAX_SAFE_INTEGER + 1, "unsafe_integer_number"], [1.25, "non_integer_number"]]) {
    const result = evidence([balance(0, MINT_A, numericAmount)], [balance(0, MINT_A, "120")]);
    assert.equal(result.status, "partial");
    assert.equal(one(result).rawDelta.status, "unavailable");
    assert.equal(one(result).preRawAmount.status, "unavailable");
    assert.ok(result.reasonCodes.includes("amount_not_exact"), type);
  }
  const uiOnly = evidence([balance(0, MINT_A, "100", { uiOnly: true })], [balance(0, MINT_A, "120")]);
  assert.equal(one(uiOnly).rawDelta.status, "unavailable");
  assert.ok(uiOnly.reasonCodes.includes("amount_unavailable"));
});

test("invalid or missing pairing identity remains unmatched and cannot produce a delta", () => {
  const missingIndex = rawTransaction([balance(0)], [balance(0, MINT_A, "110")]);
  delete missingIndex.meta.preTokenBalances[0].accountIndex;
  const noIndex = normalizeSolanaTransactionEvidence(missingIndex, signature);
  const result = normalizeSolanaTokenBalanceFlowEvidence(noIndex);
  assert.equal(result.status, "partial");
  assert.ok(result.unmatchedObservations.some((row) => row.reason === "invalid_pair_identity"));
  assert.equal(result.pairs.length, 0);

  const badMint = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0, MINT_A, "110")]), signature);
  badMint.tokenBalances.pre.entries[0].observation.mint = { status: "unavailable", value: null, reason: "null" };
  badMint.tokenBalances.pre.entries[0].status = "partial";
  badMint.tokenBalances.pre.status = "partial";
  const noMint = normalizeSolanaTokenBalanceFlowEvidence(badMint);
  assert.equal(noMint.pairs.length, 0);
  assert.ok(noMint.reasonCodes.includes("invalid_pair_identity"));
});

test("pairs distinct mints and multiple same-mint accounts independently", () => {
  const result = evidence(
    [balance(0, MINT_A, "10"), balance(1, MINT_A, "20"), balance(2, MINT_B, "30")],
    [balance(0, MINT_A, "11"), balance(1, MINT_A, "22"), balance(2, MINT_B, "33")],
  );
  assert.equal(result.status, "complete");
  assert.deepEqual(result.pairs.map((pair) => [pair.accountIndex, pair.mint, pair.rawDelta.value]), [
    [0, MINT_A, "1"], [1, MINT_A, "2"], [2, MINT_B, "3"],
  ]);
});

test("duplicate pre keys are not collapsed, even when identical", () => {
  const result = evidence([balance(0, MINT_A, "10"), balance(0, MINT_A, "10")], [balance(0, MINT_A, "12")]);
  assert.equal(result.status, "conflicting");
  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.conflicts[0], { reason: "duplicate_pair_key", accountIndex: 0, mint: MINT_A, preProviderArrayIndexes: [0, 1], postProviderArrayIndexes: [0] });
  assert.ok(result.reasonCodes.includes("duplicate_pair_key"));
});

test("duplicate post keys and conflicting duplicate amounts remain conflicting", () => {
  const result = evidence([balance(0, MINT_A, "10")], [balance(0, MINT_A, "12"), balance(0, MINT_A, "99")]);
  assert.equal(result.status, "conflicting");
  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.conflicts[0].postProviderArrayIndexes, [0, 1]);
});

test("contradictory exact-raw amount tuples are conflicting, not accepted as exact deltas", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0, MINT_A, "120")]), signature);
  normalized.tokenBalances.pre.entries[0].observation.amount.evidence.reportedAmount = "999";
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "conflicting");
  assert.equal(one(result).preRawAmount.status, "unavailable");
  assert.equal(one(result).rawDelta.status, "unavailable");
  assert.ok(result.reasonCodes.includes("amount_evidence_conflicting"));
});

test("multiple mints at one account index on one side are conflicting identity evidence", () => {
  const result = evidence([balance(0, MINT_A, "10"), balance(0, MINT_B, "20")], [balance(0, MINT_A, "11")]);
  assert.equal(result.status, "conflicting");
  assert.equal(result.pairs.length, 0);
  assert.ok(result.reasonCodes.includes("account_index_multiple_mints"));
});

test("same account index with different pre/post mints remains two unmatched rows", () => {
  const result = evidence([balance(0, MINT_A, "10")], [balance(0, MINT_B, "20")]);
  assert.equal(result.status, "partial");
  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.unmatchedObservations.map((row) => [row.side, row.reason]), [["pre", "unmatched_pre"], ["post", "unmatched_post"]]);
});

test("pre-only and post-only observations remain unmatched without zero inference", () => {
  const preOnly = evidence([balance(0, MINT_A, "10")], []);
  assert.equal(preOnly.status, "partial");
  assert.deepEqual(preOnly.unmatchedObservations, [{ side: "pre", providerArrayIndex: 0, reason: "unmatched_pre" }]);
  const postOnly = evidence([], [balance(0, MINT_A, "10")]);
  assert.equal(postOnly.status, "partial");
  assert.deepEqual(postOnly.unmatchedObservations, [{ side: "post", providerArrayIndex: 0, reason: "unmatched_post" }]);
});

test("missing, null, and differing owners do not alter exact balance arithmetic", () => {
  const missing = evidence([balance(0, MINT_A, "10", { owner: "omit" })], [balance(0, MINT_A, "12", { owner: "omit" })]);
  assert.equal(missing.status, "complete");
  assert.equal(one(missing).rawDelta.value, "2");
  assert.equal(one(missing).preOwner.status, "unavailable");
  const nullOwner = evidence([balance(0, MINT_A, "10", { owner: null })], [balance(0, MINT_A, "12", { owner: null })]);
  assert.equal(nullOwner.status, "complete");
  assert.equal(one(nullOwner).preOwner.reason, "null");
  const changed = evidence([balance(0, MINT_A, "10", { owner: key(90) })], [balance(0, MINT_A, "12", { owner: key(91) })]);
  assert.equal(changed.status, "complete");
  assert.equal(one(changed).rawDelta.value, "2");
  assert.notEqual(one(changed).preOwner.value, one(changed).postOwner.value);
});

test("decimals mismatch conflicts; missing or malformed decimals withholds only that pair delta", () => {
  const mismatch = evidence([balance(0, MINT_A, "10", { decimals: 6 })], [balance(0, MINT_A, "12", { decimals: 9 })]);
  assert.equal(mismatch.status, "conflicting");
  assert.equal(one(mismatch).rawDelta.reason, "decimals_mismatch");
  const normalizedMissing = normalizeSolanaTransactionEvidence(rawTransaction([balance(0, MINT_A, "10")], [balance(0, MINT_A, "12")]), signature);
  normalizedMissing.tokenBalances.post.entries[0].observation.decimals = { status: "unavailable", value: null, reason: "missing" };
  normalizedMissing.tokenBalances.post.entries[0].status = "partial";
  normalizedMissing.tokenBalances.post.status = "partial";
  const missingResult = normalizeSolanaTokenBalanceFlowEvidence(normalizedMissing);
  assert.equal(missingResult.status, "partial");
  assert.equal(one(missingResult).rawDelta.reason, "decimals_unavailable");
  const malformedNormalized = normalizeSolanaTransactionEvidence(rawTransaction([balance(0, MINT_A, "10")], [balance(0, MINT_A, "12")]), signature);
  malformedNormalized.tokenBalances.post.entries[0].observation.decimals = { status: "unavailable", value: null, reason: "malformed" };
  malformedNormalized.tokenBalances.post.entries[0].status = "partial";
  malformedNormalized.tokenBalances.post.status = "partial";
  const malformed = normalizeSolanaTokenBalanceFlowEvidence(malformedNormalized);
  assert.equal(malformed.status, "conflicting");
  assert.ok(malformed.reasonCodes.includes("decimals_evidence_conflicting"));
});

test("unresolved addresses permit index-scoped exact delta but make overall evidence partial", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)]), signature);
  for (const side of [normalized.tokenBalances.pre, normalized.tokenBalances.post]) {
    side.entries[0].observation.tokenAccountAddress = { status: "unavailable", value: null, reason: "unresolved_account" };
    side.entries[0].status = "partial";
    side.status = "partial";
  }
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "partial");
  assert.equal(one(result).rawDelta.value, "0");
  assert.ok(result.reasonCodes.includes("unresolved_account_address"));
});

test("resolved loaded-address accounts are checked against canonical static/writable/readonly order", () => {
  const loaded = rawTransaction([balance(2, MINT_A, "10")], [balance(2, MINT_A, "14")], {
    accountKeys: [key(1), key(2)], version: 0,
    lookups: [{ accountKey: key(3), writableIndexes: [0], readonlyIndexes: [1] }],
    loadedAddresses: { writable: [key(4)], readonly: [key(5)] },
  });
  const normalized = normalizeSolanaTransactionEvidence(loaded, signature);
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "complete");
  assert.equal(one(result).tokenAccountAddress.value, key(4));
  assert.equal(one(result).rawDelta.value, "4");
});

test("contradictory resolved account addresses withhold delta and mark conflict", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)]), signature);
  normalized.tokenBalances.post.entries[0].observation.tokenAccountAddress = { status: "available", value: key(99) };
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "conflicting");
  assert.equal(one(result).rawDelta.status, "unavailable");
  assert.ok(result.reasonCodes.includes("account_address_mismatch"));
});

test("transaction-wide canonical account-space contradictions withhold every raw delta", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction(
    [balance(0, MINT_A, "10"), balance(1, MINT_A, "20")],
    [balance(0, MINT_A, "12"), balance(1, MINT_A, "24")],
  ), signature);
  // The identities and amounts in both balance sides are otherwise exact and matched.
  normalized.accountSpace.accounts[0].source = "loaded_readonly";
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "conflicting");
  assert.ok(result.reasonCodes.includes("account_space_conflicting"));
  assert.ok(result.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  assert.ok(result.pairs.every((pair) => pair.rawDelta.reason === "account_space_conflicting"));
});

test("isolated pair-local address conflicts preserve other valid pair deltas", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction(
    [balance(0, MINT_A, "10"), balance(1, MINT_A, "20")],
    [balance(0, MINT_A, "12"), balance(1, MINT_A, "24")],
  ), signature);
  normalized.tokenBalances.post.entries[0].observation.tokenAccountAddress = { status: "available", value: key(99) };
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "conflicting");
  assert.equal(result.pairs[0].rawDelta.status, "unavailable");
  assert.equal(result.pairs[0].rawDelta.reason, "account_address_mismatch");
  assert.equal(result.pairs[1].rawDelta.status, "available");
  assert.equal(result.pairs[1].rawDelta.value, "4");
});

test("failed, unavailable, and contradictory execution states never emit available deltas", () => {
  const failed = evidence([balance(0)], [balance(0)], { err: { InstructionError: [0, "Custom"] } });
  assert.equal(failed.status, "not_applicable");
  assert.ok(failed.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  assert.ok(failed.reasonCodes.includes("transaction_failed"));

  const unknown = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)], { omitErr: true }), signature);
  const unavailable = normalizeSolanaTokenBalanceFlowEvidence(unknown);
  assert.equal(unavailable.status, "unavailable");
  assert.ok(unavailable.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  assert.ok(unavailable.reasonCodes.includes("execution_state_unavailable"));

  const contradictory = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)]), signature);
  contradictory.execution = { status: "succeeded", basis: "provider_meta_err_non_null" };
  const conflicting = normalizeSolanaTokenBalanceFlowEvidence(contradictory);
  assert.equal(conflicting.status, "conflicting");
  assert.ok(conflicting.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  assert.ok(conflicting.reasonCodes.includes("execution_state_conflicting"));
});

test("explicit empty arrays are complete empty reconciliation; missing and null sides are unavailable", () => {
  const empty = evidence([], []);
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.pairs, []);
  assert.deepEqual(empty.unmatchedObservations, []);

  for (const options of [{ omitPre: true }, { nullPre: true }, { omitPost: true }, { nullPost: true }]) {
    const unavailable = evidence([balance(0)], [balance(0)], options);
    assert.equal(unavailable.status, "unavailable");
    assert.ok(unavailable.reasonCodes.includes("balance_side_unavailable"));
    assert.ok(unavailable.pairs.every((pair) => pair.rawDelta.status === "unavailable"));
  }
});

test("an unavailable required side keeps confirmed-success evidence unavailable and preserves observed rows", () => {
  const transaction = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)], { omitPost: true }), signature);
  assert.equal(transaction.execution.status, "succeeded");
  assert.equal(transaction.tokenBalances.pre.status, "available");
  assert.equal(transaction.tokenBalances.post.status, "unavailable");
  assert.equal(transaction.tokenBalances.post.entries.length, 0);
  const result = normalizeSolanaTokenBalanceFlowEvidence(transaction);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.unmatchedObservations, [
    { side: "pre", providerArrayIndex: 0, reason: "balance_side_unavailable" },
  ]);
  assert.ok(result.reasonCodes.includes("balance_side_unavailable"));
  assert.ok(result.pairs.every((pair) => pair.rawDelta.status !== "available"));
});

test("unrelated partial transaction structure does not weaken valid balance-flow evidence", () => {
  const normalized = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)]), signature);
  // Keep execution and balance sides valid while making instruction structure unavailable.
  normalized.outerInstructions.status = "partial";
  normalized.structuralCompleteness = "partial";
  const result = normalizeSolanaTokenBalanceFlowEvidence(normalized);
  assert.equal(result.status, "complete");
  assert.equal(one(result).rawDelta.value, "0");
});

test("Token-2022 reported rows retain raw observed deltas without extension interpretation", () => {
  const result = evidence([balance(0, MINT_A, "100", { programId: TOKEN_2022 })], [balance(0, MINT_A, "125", { programId: TOKEN_2022 })]);
  assert.equal(result.status, "complete");
  assert.equal(one(result).rawDelta.value, "25");
  assert.deepEqual(Object.keys(result).sort(), ["chain", "conflicts", "pairs", "phase2A", "reasonCodes", "schemaVersion", "status", "transactionExecution", "transactionSignature", "unmatchedObservations"].sort());
  assert.equal(JSON.stringify(result).includes("buy"), false);
  assert.equal(JSON.stringify(result).includes("sell"), false);
});

test("one invalid pair preserves independent valid pairs and reports partial completeness", () => {
  const result = evidence([balance(0, MINT_A, "10"), balance(1, MINT_A, "20")], [balance(0, MINT_A, "15"), balance(1, MINT_A, "22.5")]);
  assert.equal(result.status, "partial");
  assert.equal(result.pairs[0].rawDelta.value, "5");
  assert.equal(result.pairs[1].rawDelta.status, "unavailable");
  assert.ok(result.reasonCodes.includes("amount_not_exact"));
});

test("pairs use deterministic accountIndex/mint ordering, not provider-array position", () => {
  const result = evidence([balance(2, MINT_B, "3"), balance(1, MINT_A, "2")], [balance(1, MINT_A, "4"), balance(2, MINT_B, "8")]);
  assert.deepEqual(result.pairs.map((pair) => [pair.accountIndex, pair.mint]), [[1, MINT_A], [2, MINT_B]]);
  assert.deepEqual(result.pairs.map((pair) => pair.preProviderArrayIndex), [1, 0]);
});

test("does not mutate transaction input", () => {
  const transaction = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0, MINT_A, "15")]), signature);
  const before = structuredClone(transaction);
  normalizeSolanaTokenBalanceFlowEvidence(transaction);
  assert.deepEqual(transaction, before);
});

test("rejects contradictory side counts rather than silently reconciling them", () => {
  const transaction = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0)]), signature);
  transaction.tokenBalances.pre.reportedEntryCount = 2;
  assert.throws(() => normalizeSolanaTokenBalanceFlowEvidence(transaction), /side count is inconsistent/);
});

test("emits stable schema/reason codes and contains no economic classification fields", () => {
  const result = evidence([balance(0)], []);
  assert.equal(result.schemaVersion, "solana-token-balance-flow-evidence-v1");
  assert.deepEqual(result.reasonCodes, ["unmatched_pre"]);
  for (const forbidden of ["buy", "sell", "swap", "trade", "trader", "wallet", "economicOwner", "funding", "score"]) {
    assert.equal(forbidden in result, false);
  }
});

test("links validated Phase 2A selection and request provenance without inventing it", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const reference = { sourceFingerprint: fingerprint, authorityAddress: key(70), authoritySelectionPosition: 0,
    historicalObservationIndex: 0, rank: { basis: "sourceRank", value: 1 } };
  const selection = {
    schemaVersion: "solana-historical-transaction-selection-v1", chain: "solana", mintAddress: MINT_A,
    sourceHistoricalPlanVersion: "solana-bounded-history-query-plan-v1", sourceFingerprint: fingerprint,
    requestedWindow: { fromUnixSecondsInclusive: 1, toUnixSecondsExclusive: 2 }, sourceEvidenceFetchedAt: "2026-10-06T11:00:00.000Z",
    signatureCap: 5, selectionCompleteness: "complete",
    sourceCoverage: { holderCandidateFrameCompleteness: "partial", candidateAuthorityCount: 1, selectedAuthorityCount: 1,
      naturallyCompleteAuthorityCount: 1, truncatedAuthorityCount: 0, providerErrorAuthorityCount: 0, unqueriedAuthorityCount: 0, signatureSourceCompleteness: "partial" },
    uniqueSignatureCount: 1, selectedUniqueSignatureCount: 1,
    candidates: [{ signature, sourceObservations: [reference], disposition: { status: "selected", selectionPosition: 0 } }],
  };
  const transactionRequest = { chain: "solana", provider: "helius", method: "getTransaction", encoding: "json", commitment: "finalized",
    maxSupportedTransactionVersion: 0, requestedSignature: signature, fetchedAt: "2026-10-06T12:00:00.000Z" };
  const transaction = normalizeSolanaTransactionEvidence(rawTransaction([balance(0)], [balance(0, MINT_A, "102")]), signature);
  const result = normalizeSolanaTokenBalanceFlowEvidence(transaction, { selection, transactionRequest });
  assert.equal(result.phase2A.sourceFingerprint, fingerprint);
  assert.equal(result.phase2A.selectionPosition, 0);
  assert.equal(result.phase2A.sourceObservations[0].historicalObservationIndex, 0);
  assert.equal(result.phase2A.transactionRequest.fetchedAt, transactionRequest.fetchedAt);
  assert.equal(result.status, "complete");

  assert.throws(() => normalizeSolanaTokenBalanceFlowEvidence(transaction, { selection, transactionRequest: { ...transactionRequest, requestedSignature: base58(Buffer.alloc(64, 8)) } }), /provenance is inconsistent/);
});
