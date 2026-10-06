const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  executeSolanaTransactionEvidence,
} = require("../dist/execution/solanaTransactionEvidence.js");
const {
  normalizeSolanaTransactionEvidence,
  SolanaTransactionNormalizationError,
} = require("../dist/normalization/solanaTransactionEvidence.js");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
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
const signature = (byte) => base58(Buffer.alloc(64, byte));
const REQUESTED = signature(7);
const API_KEY = "transaction-evidence-test-secret";
const NOW = () => new Date("2026-10-06T12:00:00.000Z");

function rpcResponse(result, extra = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transaction-probe", result, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function legacyTransaction(overrides = {}) {
  const keys = [key(1), key(2), key(3), key(4)];
  return {
    slot: 451369028,
    blockTime: 1790611915,
    transaction: {
      signatures: [REQUESTED],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 1 },
        instructions: [{ programIdIndex: 2, accounts: [0, 3], data: "3Sby4Ya7yebR" }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: "2fX7imjEaEwy" }] }],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [
        { accountIndex: 0, mint: key(20), owner: key(21), uiTokenAmount: { amount: "18446744073709551615", decimals: 9, uiAmount: null } },
        { accountIndex: 1, mint: key(20), owner: key(22), uiTokenAmount: { amount: "2", decimals: 9 } },
        { accountIndex: 2, mint: key(20), owner: key(23), uiTokenAmount: { amount: "3", decimals: 9 } },
        { accountIndex: 3, mint: key(20), owner: key(24), uiTokenAmount: { amount: "4", decimals: 9 } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: key(20), owner: key(21), uiTokenAmount: { amount: "18446744073709551615", decimals: 9, uiAmount: null } },
        { accountIndex: 1, mint: key(20), owner: key(22), uiTokenAmount: { amount: "2", decimals: 9 } },
        { accountIndex: 2, mint: key(20), owner: key(23), uiTokenAmount: { amount: "3", decimals: 9 } },
      ],
      preBalances: [100, 200, 300, 400],
      postBalances: [99, 201, 300, 400],
    },
    version: "legacy",
    ...overrides,
  };
}

function v0Transaction() {
  const staticKeys = [key(31), key(32)];
  const writable = [key(33)];
  const readonly = Array.from({ length: 10 }, (_, index) => key(34 + index));
  return {
    slot: 451369100,
    blockTime: 1790612000,
    transaction: {
      signatures: [REQUESTED, signature(8)],
      message: {
        accountKeys: staticKeys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        addressTableLookups: [{ accountKey: key(60), writableIndexes: [4], readonlyIndexes: [140, 144, 141, 33, 26, 20, 3, 34, 143, 142] }],
        instructions: [{ programIdIndex: 12, accounts: [2, 0, 3, 12], data: "6vx8P" }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [12], data: "2BfZXS1GQrCLZ1vzWVcaYz6Kpzd9QSStQWUgg9fK2UEsEo" }] }],
      loadedAddresses: { writable, readonly },
      preTokenBalances: [],
      postTokenBalances: [],
      preBalances: Array(13).fill(10),
      postBalances: Array(13).fill(10),
    },
    version: 0,
  };
}

async function withKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = API_KEY;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
}

test("normalizes a legacy transaction, empty loaded-address arrays, execution, and unequal token sides", () => {
  const result = normalizeSolanaTransactionEvidence(legacyTransaction(), REQUESTED);
  assert.equal(result.version.status, "available");
  assert.equal(result.version.value, "legacy");
  assert.equal(result.execution.status, "succeeded");
  assert.equal(result.accountSpace.status, "complete");
  assert.equal(result.accountSpace.accounts.length, 4);
  assert.equal(result.accountSpace.accounts[0].source, "static");
  assert.equal(result.accountSpace.loadedAddresses.status, "available");
  assert.equal(result.accountSpace.loadedAddresses.value.writable.length, 0);
  assert.equal(result.outerInstructions.status, "available");
  assert.equal(result.innerInstructions.status, "available");
  assert.equal(result.structuralCompleteness, "complete");
  assert.equal(result.tokenBalances.pre.reportedEntryCount, 4);
  assert.equal(result.tokenBalances.post.reportedEntryCount, 3);
  assert.equal(result.tokenBalances.pre.entries[0].observation.amount.evidence.rawAmount, "18446744073709551615");
  assert.equal(result.tokenBalances.pre.entries[0].observation.amount.evidence.exactRawAvailable, true);
  assert.equal(result.tokenBalances.pre.entries[0].observation.amount.evidence.reportedUiAmountType, "null");
  assert.equal(result.historicalCoverage, "not_assessed");
});

test("structural completeness requires complete account, instruction, metadata, and balance evidence", () => {
  const cases = [
    ["partial account space", (tx) => { delete tx.meta.loadedAddresses; tx.version = 0; tx.transaction.message.addressTableLookups = [{ accountKey: key(44), writableIndexes: [0], readonlyIndexes: [] }]; }],
    ["partial outer instructions", (tx) => { tx.transaction.message.instructions[0].programIdIndex = 99; }],
    ["partial inner instructions", (tx) => { tx.meta.innerInstructions[0].instructions[0].programIdIndex = 99; }],
    ["partial token balances", (tx) => { tx.meta.preTokenBalances[0] = null; }],
    ["unavailable token balances", (tx) => { tx.meta.postTokenBalances = null; }],
    ["partial SOL balances", (tx) => { tx.meta.preBalances[0] = "100"; }],
    ["unavailable SOL balances", (tx) => { delete tx.meta.postBalances; }],
    ["unavailable execution/meta", (tx) => { tx.meta = null; }],
  ];

  for (const [label, mutate] of cases) {
    const transaction = legacyTransaction();
    mutate(transaction);
    assert.equal(normalizeSolanaTransactionEvidence(transaction, REQUESTED).structuralCompleteness, "partial", label);
  }
});

test("legitimate empty instruction and token-balance arrays can be structurally complete", () => {
  const transaction = legacyTransaction();
  transaction.transaction.message.instructions = [];
  transaction.meta.innerInstructions = [];
  transaction.meta.preTokenBalances = [];
  transaction.meta.postTokenBalances = [];

  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.outerInstructions.status, "available");
  assert.equal(result.innerInstructions.status, "available");
  assert.equal(result.tokenBalances.pre.status, "available");
  assert.equal(result.tokenBalances.post.status, "available");
  assert.equal(result.structuralCompleteness, "complete");
});

test("normalizes v0 account order and resolves a high loaded-address instruction index", () => {
  const result = normalizeSolanaTransactionEvidence(v0Transaction(), REQUESTED);
  assert.equal(result.version.value, 0);
  assert.equal(result.accountSpace.status, "complete");
  assert.equal(result.accountSpace.accounts.length, 13);
  assert.deepEqual(result.accountSpace.accounts.map((account) => account.source), [
    "static", "static", "loaded_writable", ...Array(10).fill("loaded_readonly"),
  ]);
  assert.equal(result.accountSpace.accounts[2].signer, false);
  assert.equal(result.accountSpace.accounts[2].writable, true);
  assert.equal(result.accountSpace.accounts[12].signer, false);
  assert.equal(result.accountSpace.accounts[12].writable, false);
  const instruction = result.outerInstructions.entries[0].instruction;
  assert.equal(instruction.programIdIndex, 12);
  assert.equal(instruction.program.address, key(43));
  assert.equal(instruction.accounts[0].address, key(33));
  assert.equal(instruction.accounts[3].address, key(43));
  assert.equal(result.innerInstructions.groups[0].parentOuterInstructionIndex, 0);
  assert.equal(result.innerInstructions.groups[0].instructions[0].instruction.position, 0);
});

test("derives static signer and writable flags from header counts", () => {
  const accounts = normalizeSolanaTransactionEvidence(legacyTransaction(), REQUESTED).accountSpace.accounts;
  assert.deepEqual(accounts.map(({ signer, writable }) => [signer, writable]), [
    [true, true], [true, false], [false, true], [false, false],
  ]);
});

test("marks missing or count-inconsistent lookup addresses partial without fabricating mappings", () => {
  const missing = v0Transaction();
  delete missing.meta.loadedAddresses;
  const missingResult = normalizeSolanaTransactionEvidence(missing, REQUESTED);
  assert.equal(missingResult.accountSpace.status, "partial");
  assert.equal(missingResult.accountSpace.reason, "loaded_addresses_missing");
  assert.equal(missingResult.outerInstructions.entries[0].instruction.accounts[0].status, "unresolved");
  assert.equal(missingResult.outerInstructions.entries[0].instruction.accounts[0].accountIndex, 2);

  const mismatch = v0Transaction();
  mismatch.meta.loadedAddresses.readonly.pop();
  const mismatchResult = normalizeSolanaTransactionEvidence(mismatch, REQUESTED);
  assert.equal(mismatchResult.accountSpace.status, "partial");
  assert.equal(mismatchResult.accountSpace.reason, "lookup_loaded_count_mismatch");
  assert.equal(mismatchResult.accountSpace.accounts.length, 2);
});

test("keeps outer and inner instruction evidence partial for out-of-range account references", () => {
  const transaction = legacyTransaction();
  transaction.transaction.message.instructions[0].programIdIndex = 99;
  transaction.transaction.message.instructions[0].accounts.push(98);
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.outerInstructions.status, "partial");
  const instruction = result.outerInstructions.entries[0].instruction;
  assert.deepEqual(instruction.program, { accountIndex: 99, status: "unresolved", address: null, reason: "index_out_of_range" });
  assert.equal(instruction.accounts.at(-1).accountIndex, 98);
  assert.equal(instruction.accounts.at(-1).status, "unresolved");
});

test("retains malformed instruction rows as explicit partial entries", () => {
  const transaction = legacyTransaction();
  transaction.transaction.message.instructions.push({ programIdIndex: "bad", accounts: [], data: "" });
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.outerInstructions.status, "partial");
  assert.deepEqual(result.outerInstructions.entries[1], { status: "malformed", position: 1, reason: "malformed_compiled_instruction" });
});

test("retains malformed inner groups with their provider group position", () => {
  const transaction = legacyTransaction();
  transaction.meta.innerInstructions = [
    { index: 99, instructions: [] },
    { index: 0, instructions: [{ programIdIndex: 1, accounts: "bad", data: "" }] },
  ];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.innerInstructions.status, "partial");
  assert.deepEqual(result.innerInstructions.groups[0], {
    status: "malformed", groupPosition: 0, reason: "malformed_inner_instruction_group",
  });
  assert.equal(result.innerInstructions.groups[1].instructions[0].status, "malformed");
});

test("preserves token sides independently and classifies only integer strings as exact", () => {
  const transaction = legacyTransaction();
  const owner = key(90);
  const mint = key(91);
  const rows = [
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: "9007199254740993", decimals: 6, uiAmount: null } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: 42, decimals: 6 } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: 1.25, decimals: 6 } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: "1.25", decimals: 6 } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: null, decimals: 6 } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { decimals: 6, uiAmount: 8 } },
    { accountIndex: 0, mint, owner, uiTokenAmount: { amount: Number.MAX_SAFE_INTEGER + 1, decimals: 6 } },
  ];
  transaction.meta.preTokenBalances = rows;
  transaction.meta.postTokenBalances = [rows[0]];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  const pre = result.tokenBalances.pre.entries.map((entry) => entry.observation.amount);
  assert.equal(pre[0].evidence.rawAmount, "9007199254740993");
  assert.equal(pre[0].evidence.exactRawAvailable, true);
  assert.deepEqual(pre.slice(1).map((amount) => amount.status === "available" ? amount.evidence.exactRawAvailable : null), [false, false, false, false, false, false]);
  assert.equal(pre[1].evidence.reportedAmountType, "safe_integer_number");
  assert.equal(pre[2].evidence.reportedAmountType, "non_integer_number");
  assert.equal(pre[3].evidence.reportedAmountType, "non_integer_string");
  assert.equal(pre[4].evidence.reportedAmountType, "null");
  assert.equal(pre[5].evidence.reportedAmountType, "missing");
  assert.equal(pre[6].evidence.reportedAmountType, "unsafe_integer_number");
  assert.equal(result.tokenBalances.pre.status, "available");
  assert.equal(result.tokenBalances.post.reportedEntryCount, 1);
});

test("marks malformed amount, mint, owner, decimals, and token account index without fabricating values", () => {
  const transaction = legacyTransaction();
  transaction.meta.preTokenBalances = [
    { accountIndex: 99, mint: "bad-mint", owner: "bad-owner", uiTokenAmount: { amount: -1, decimals: 999 } },
    { accountIndex: 0, mint: key(92), uiTokenAmount: { amount: "-2", decimals: 6 } },
    { accountIndex: "0", mint: key(93), owner: key(94), uiTokenAmount: { amount: "1", decimals: 6 } },
  ];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  const first = result.tokenBalances.pre.entries[0].observation;
  assert.equal(first.accountIndex.value, 99);
  assert.equal(first.tokenAccountAddress.reason, "unresolved_account");
  assert.equal(first.mint.status, "unavailable");
  assert.equal(first.owner.reason, "malformed");
  assert.equal(first.amount.status, "unavailable");
  assert.equal(first.decimals.status, "unavailable");
  const second = result.tokenBalances.pre.entries[1].observation;
  assert.equal(second.owner.reason, "missing");
  assert.equal(second.amount.status, "available");
  assert.equal(second.amount.evidence.exactRawAvailable, false);
  assert.equal(result.tokenBalances.pre.entries[2].observation.accountIndex.reason, "malformed");
  assert.equal(result.tokenBalances.pre.status, "partial");
});

test("keeps pre-only and post-only token balance observations without position pairing", () => {
  const transaction = legacyTransaction();
  transaction.meta.preTokenBalances = [
    { accountIndex: 0, mint: key(95), owner: key(96), uiTokenAmount: { amount: "11", decimals: 6 } },
  ];
  transaction.meta.postTokenBalances = [
    { accountIndex: 1, mint: key(95), owner: key(97), uiTokenAmount: { amount: "22", decimals: 6 } },
    { accountIndex: 2, mint: key(95), owner: key(98), uiTokenAmount: { amount: "33", decimals: 6 } },
  ];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.tokenBalances.pre.entries.length, 1);
  assert.equal(result.tokenBalances.pre.entries[0].observation.accountIndex.value, 0);
  assert.equal(result.tokenBalances.post.entries.length, 2);
  assert.deepEqual(result.tokenBalances.post.entries.map((entry) => entry.observation.accountIndex.value), [1, 2]);
});

test("distinguishes missing and null metadata, execution errors, and block-time null", () => {
  const nullMeta = legacyTransaction({ meta: null, blockTime: null });
  const nullResult = normalizeSolanaTransactionEvidence(nullMeta, REQUESTED);
  assert.deepEqual(nullResult.execution, { status: "unavailable", reason: "meta_null" });
  assert.equal(nullResult.blockTime.reason, "null");
  assert.equal(nullResult.tokenBalances.pre.reason, "meta_null");

  const missingMeta = legacyTransaction();
  delete missingMeta.meta;
  const missingResult = normalizeSolanaTransactionEvidence(missingMeta, REQUESTED);
  assert.deepEqual(missingResult.execution, { status: "unavailable", reason: "meta_missing" });

  const failed = legacyTransaction({ meta: { err: { InstructionError: [0, "Custom"] } } });
  const failedResult = normalizeSolanaTransactionEvidence(failed, REQUESTED);
  assert.equal(failedResult.execution.status, "failed");
  assert.deepEqual(failedResult.execution.reportedError, { InstructionError: [0, "Custom"] });
});

test("returns sanitized malformed outcomes for signature, static key, header, and version failures", async () => {
  const mismatched = legacyTransaction();
  mismatched.transaction.signatures[0] = signature(9);
  assert.throws(() => normalizeSolanaTransactionEvidence(mismatched, REQUESTED), (error) =>
    error instanceof SolanaTransactionNormalizationError && error.reason === "signature_mismatch");

  for (const mutate of [
    (tx) => { tx.transaction.signatures = "bad"; },
    (tx) => { tx.transaction.message.accountKeys = ["bad-key"]; },
    (tx) => { tx.transaction.message.header.numReadonlySignedAccounts = 99; },
  ]) {
    const transaction = legacyTransaction();
    mutate(transaction);
    assert.throws(() => normalizeSolanaTransactionEvidence(transaction, REQUESTED), SolanaTransactionNormalizationError);
  }
  const unsupported = legacyTransaction({ version: 1 });
  assert.throws(() => normalizeSolanaTransactionEvidence(unsupported, REQUESTED), (error) =>
    error instanceof SolanaTransactionNormalizationError && error.reason === "unsupported_version");
  const malformedVersion = legacyTransaction({ version: "v0" });
  assert.throws(() => normalizeSolanaTransactionEvidence(malformedVersion, REQUESTED), (error) =>
    error instanceof SolanaTransactionNormalizationError && error.reason === "malformed_structure");
});

test("preserves unavailable slot and block-time evidence rather than coercing malformed numbers", () => {
  const transaction = legacyTransaction({ slot: Number.MAX_SAFE_INTEGER + 1, blockTime: "1790611915" });
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.deepEqual(result.slot, { status: "unavailable", value: null, reason: "unsafe_or_malformed" });
  assert.deepEqual(result.blockTime, { status: "unavailable", value: null, reason: "unsafe_or_malformed" });
});

test("keeps malformed lookup declarations and loaded addresses explicitly incomplete", () => {
  const transaction = v0Transaction();
  transaction.transaction.message.addressTableLookups = [{ accountKey: "bad", writableIndexes: [], readonlyIndexes: [] }];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.accountSpace.status, "partial");
  assert.equal(result.accountSpace.addressTableLookups.reason, "malformed");

  const badLoaded = v0Transaction();
  badLoaded.meta.loadedAddresses.readonly[0] = "not-a-public-key";
  const badLoadedResult = normalizeSolanaTransactionEvidence(badLoaded, REQUESTED);
  assert.equal(badLoadedResult.accountSpace.status, "partial");
  assert.equal(badLoadedResult.accountSpace.loadedAddresses.reason, "malformed");
});

test("preserves SOL balances only as non-exact JSON number observations", () => {
  const transaction = legacyTransaction();
  transaction.meta.preBalances = [9007199254740992, 10, 20, 30];
  const result = normalizeSolanaTransactionEvidence(transaction, REQUESTED);
  assert.equal(result.solBalances.pre.exactness, "non_exact_json_number_observations");
  assert.equal(result.solBalances.pre.values[0].exactRawAvailable, false);
  assert.equal(result.solBalances.pre.values[0].value, 9007199254740992);
  assert.equal(result.solBalances.pre.status, "available");
});

test("one-request production boundary preserves provenance and separates null from provider errors", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return rpcResponse(legacyTransaction());
      },
    });
    assert.equal(result.evidence.status, "returned");
    assert.equal(result.evidence.provenance.chain, "solana");
    assert.equal(result.evidence.provenance.provider, "helius");
    assert.equal(result.evidence.provenance.method, "getTransaction");
    assert.equal(result.evidence.provenance.encoding, "json");
    assert.equal(result.evidence.provenance.maxSupportedTransactionVersion, 1);
    assert.equal(result.evidence.provenance.fetchedAt, "2026-10-06T12:00:00.000Z");
    assert.equal(result.telemetry.requestCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.method, "getTransaction");
    assert.deepEqual(requests[0].body.params, [REQUESTED, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(result), /api-key=/);
  });
});

test("normalization failures are malformed_response outcomes rather than null results", async () => {
  await withKey(async () => {
    const mismatched = legacyTransaction();
    mismatched.transaction.signatures[0] = signature(10);
    const result = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      fetchImpl: async () => rpcResponse(mismatched),
    });
    assert.equal(result.evidence.status, "malformed_response");
    assert.equal(result.evidence.reason, "signature_mismatch");
    assert.equal(result.evidence.transaction, null);
    assert.equal(result.telemetry.requestCount, 1);
  });
});

test("malformed provider JSON is distinct from result null and provider failure", async () => {
  await withKey(async () => {
    const result = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    assert.equal(result.evidence.status, "malformed_response");
    assert.equal(result.evidence.reason, "malformed_structure");
    assert.equal(result.telemetry.requestCount, 1);
  });
});

test("provider result null remains distinct from provider RPC failure", async () => {
  await withKey(async () => {
    const nullResult = await executeSolanaTransactionEvidence(REQUESTED, { now: NOW, fetchImpl: async () => rpcResponse(null) });
    assert.equal(nullResult.evidence.status, "provider_result_null");
    assert.equal(nullResult.telemetry.requestCount, 1);

    const rpcFailure = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      fetchImpl: async () => rpcResponse(undefined, { error: { code: -32001, message: `raw ${API_KEY}` } }),
    });
    assert.equal(rpcFailure.evidence.status, "provider_error");
    assert.equal(rpcFailure.evidence.error.category, "rpc");
    assert.equal(rpcFailure.evidence.error.rpcCode, -32001);
    assert.doesNotMatch(JSON.stringify(rpcFailure), new RegExp(API_KEY));
  });
});

test("configuration failure performs no request and does not expose credentials", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  let calls = 0;
  try {
    const result = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      fetchImpl: async () => { calls += 1; return rpcResponse(null); },
    });
    assert.equal(result.evidence.status, "provider_error");
    assert.equal(result.evidence.error.category, "configuration");
    assert.equal(result.telemetry.requestCount, 0);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
});

test("timeout is bounded, sanitized, and never retried", async () => {
  await withKey(async () => {
    let calls = 0;
    let signal;
    const result = await executeSolanaTransactionEvidence(REQUESTED, {
      now: NOW,
      timeoutMs: 5,
      fetchImpl: async (_url, init) => {
        calls += 1;
        signal = init.signal;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(API_KEY)), { once: true }));
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.telemetry.requestCount, 1);
    assert.equal(result.evidence.status, "provider_error");
    assert.equal(result.evidence.error.category, "transport");
    assert.equal(result.evidence.error.message, "Helius transaction request timed out.");
    assert.equal(signal.aborted, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(result), /https:\/\//);
  });
});

test("invalid signature is rejected before any provider request", async () => {
  let calls = 0;
  await assert.rejects(executeSolanaTransactionEvidence("bad", {
    fetchImpl: async () => { calls += 1; return rpcResponse(null); },
  }), /64-byte/);
  assert.equal(calls, 0);
});
