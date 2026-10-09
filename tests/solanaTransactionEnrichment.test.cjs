const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSolanaHistoricalQueryPlan, buildSolanaHistoricalQueryPlanV2 } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities, selectSolanaHistoricalAuthoritiesV2 } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { executeSolanaHistoricalQueryPlan } = require("../dist/execution/solanaHistoricalQueryExecution.js");
const { createSolanaHolderSnapshotRecordV2 } = require("../dist/normalization/solanaHolderSnapshotComparison.js");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { createSolanaHistoricalTransactionSelection, validateSolanaHistoricalTransactionSelection } = require("../dist/normalization/solanaHistoricalTransactionSelector.js");
const { executeSolanaTransactionEnrichment } = require("../dist/execution/solanaTransactionEnrichment.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (n) => encodeSolanaPublicKey(Buffer.alloc(32, n));
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let output = "";
  while (value > 0n) { output = ALPHABET[Number(value % 58n)] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = `1${output}`; }
  return output || "1";
}
const sig = (n) => base58(Buffer.alloc(64, n));
const MINT = key(90);
const SECRET = "phase-2a-test-secret";
const fixedClock = () => new Date("2026-10-06T12:00:00.000Z");

function makePlan(authorityCount = 1, selectionCap = authorityCount) {
  const rawOwnerAuthorities = Array.from({ length: authorityCount }, (_, i) => ({
    ownerAddress: key(i + 1), balanceRaw: String(1000 - i), tokenAccountCount: 1,
  }));
  const holder = {
    chain: "solana", mintAddress: MINT, tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: "100000", observedPositiveBalanceRaw: String(authorityCount),
    supplyDifferenceRaw: String(100000 - authorityCount), fetchedAt: "2026-10-06T11:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [451369028] },
    tokenAccountCount: authorityCount, nonzeroTokenAccountCount: authorityCount,
    tokenAccountStateSummary: { initialized: { tokenAccountCount: authorityCount, positiveBalanceTokenAccountCount: authorityCount, observedBalanceRaw: String(authorityCount) }, frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" } },
    rawOwnerCount: authorityCount, rawOwnerAuthorities,
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null }, concentration: {},
  };
  const selection = selectSolanaHistoricalAuthorities(holder, Math.max(1, selectionCap));
  return buildSolanaHistoricalQueryPlan({ holderStructure: holder, selection,
    requestedWindow: { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_790_100_000 },
    maxPagesPerAuthority: 2, maxRecordsPerAuthority: 4 });
}

function makePlanV2() {
  const data = Buffer.alloc(165);
  data.set(Buffer.alloc(32, 90), 0);
  data.set(Buffer.alloc(32, 1), 32);
  data.writeBigUInt64LE(100n, 64);
  data[108] = 1;
  const holder = normalizeSolanaHolderStructure({
    mintAddress: MINT, tokenProgram: "spl-token", decimals: 6, currentMintSupplyRaw: "1000",
    mintExtensionTypes: [], fetchedAt: "2026-10-06T11:00:00.000Z",
    pages: [{ accounts: [{ address: key(50), programOwner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
      dataBase64: data.toString("base64"), reportedSpace: data.length }], paginationKey: null, contextSlot: 451369028 }],
  });
  const snapshot = createSolanaHolderSnapshotRecordV2(holder, { completeness: "complete", stopReason: "provider_terminated", configuredMaxPages: 20, requestedPageSize: 5000 });
  const selected = selectSolanaHistoricalAuthoritiesV2(snapshot, 1);
  return buildSolanaHistoricalQueryPlanV2({ snapshotRecord: snapshot, selection: selected,
    requestedWindow: { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_790_100_000 },
    maxPagesPerAuthority: 2, maxRecordsPerAuthority: 4 });
}

function transfer(sigValue, authorityIndex, extra = {}) {
  return {
    signature: sigValue, slot: 451369028, blockTime: 1790611915, type: "transfer",
    fromUserAccount: key(70), toUserAccount: key(71), fromTokenAccount: key(72), toTokenAccount: key(73),
    mint: MINT,
    amount: { rawAmount: "7", exactRawAvailable: true, exactnessBasis: "provider_integer_string", unavailableReason: null,
      reportedAmount: "7", reportedAmountType: "integer_string" },
    ...extra,
  };
}

async function sourceFor(plan, transfers, createSelection = true, fetchPage = null) {
  const evidenceResult = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: () => 1_800_000_000_000,
    fetchPage: fetchPage ?? (async ({ ownerAuthority }) => ({ observations: transfers.get(ownerAuthority) ?? [], paginationToken: null })),
  });
  return { evidence: evidenceResult.evidence, selection: createSelection
    ? createSolanaHistoricalTransactionSelection(plan, evidenceResult.evidence) : null };
}

function transactionFor(signatureValue, overrides = {}) {
  const account = key(40);
  return {
    slot: 451369028, blockTime: 1790611915,
    transaction: { signatures: [signatureValue], message: { accountKeys: [account],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] } },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [], postTokenBalances: [], preBalances: [1], postBalances: [1] },
    version: "legacy", ...overrides,
  };
}

function rpc(result, id = "tqe-transaction-probe") {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
}

async function withKey(fn) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = SECRET;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = previous; }
}

test("selection deduplicates signatures, retains every occurrence, and fingerprints deterministically", async () => {
  const plan = makePlan(2);
  const [a, b] = plan.candidateAuthorities;
  const shared = sig(8);
  const { evidence, selection } = await sourceFor(plan, new Map([
    [a.authorityAddress, [transfer(shared, 0), transfer(sig(9), 0)]],
    [b.authorityAddress, [transfer(shared, 1)]],
  ]));
  assert.equal(selection.uniqueSignatureCount, 2);
  assert.deepEqual(selection.candidates.map((c) => c.signature), [sig(9), shared].sort());
  assert.equal(selection.candidates.find((c) => c.signature === shared).sourceObservations.length, 2);
  assert.equal(selection.candidates.filter((c) => c.disposition.status === "selected").length, 2);
  const second = createSolanaHistoricalTransactionSelection(plan, evidence);
  assert.equal(second.sourceFingerprint, selection.sourceFingerprint);
  assert.doesNotThrow(() => validateSolanaHistoricalTransactionSelection(selection, plan, evidence));
  const altered = structuredClone(evidence);
  altered.authorities[0].observations[0].providerRecord.slot += 1;
  assert.notEqual(createSolanaHistoricalTransactionSelection(plan, altered).sourceFingerprint, selection.sourceFingerprint);
});

test("fingerprint binds signature, time window, source authority, dispositions, page/observation order, and optional missing/null states", async () => {
  const basePlan = makePlan(2);
  const [first, second] = basePlan.candidateAuthorities;
  const sigA = sig(31), sigB = sig(32);
  const base = await sourceFor(basePlan, new Map([[first.authorityAddress, [transfer(sigA, 0)]], [second.authorityAddress, [transfer(sigB, 1)]]]));
  const baseFingerprint = base.selection.sourceFingerprint;

  const changedSignature = await sourceFor(basePlan, new Map([[first.authorityAddress, [transfer(sig(33), 0)]], [second.authorityAddress, [transfer(sigB, 1)]]]));
  assert.notEqual(changedSignature.selection.sourceFingerprint, baseFingerprint);

  const changedWindowPlan = makePlan(2);
  changedWindowPlan.requestedWindow.fromUnixSecondsInclusive += 1;
  changedWindowPlan.requestedWindow.toUnixSecondsExclusive += 1;
  const changedWindow = await sourceFor(changedWindowPlan, new Map([[first.authorityAddress, [transfer(sigA, 0)]], [second.authorityAddress, [transfer(sigB, 1)]]]));
  assert.notEqual(changedWindow.selection.sourceFingerprint, baseFingerprint);

  const swappedAuthorities = await sourceFor(basePlan, new Map([[first.authorityAddress, [transfer(sigB, 0)]], [second.authorityAddress, [transfer(sigA, 1)]]]));
  assert.notEqual(swappedAuthorities.selection.sourceFingerprint, baseFingerprint);

  const cappedPlan = makePlan(2, 1);
  const capped = await sourceFor(cappedPlan, new Map([[first.authorityAddress, [transfer(sigA, 0)]]]));
  assert.notEqual(capped.selection.sourceFingerprint, baseFingerprint);

  const omittedRecord = transfer(sigA, 0);
  delete omittedRecord.type;
  const optionalOmitted = await sourceFor(makePlan(), new Map([[key(1), [omittedRecord]]]));
  const optionalNull = await sourceFor(makePlan(), new Map([[key(1), [{ ...transfer(sigA, 0), type: null }]]]));
  assert.notEqual(optionalOmitted.selection.sourceFingerprint, optionalNull.selection.sourceFingerprint);

  const telemetryOnly = structuredClone(base.evidence);
  telemetryOnly.telemetry = { elapsedMs: 10 };
  const telemetrySelection = createSolanaHistoricalTransactionSelection(basePlan, telemetryOnly);
  assert.equal(telemetrySelection.sourceFingerprint, baseFingerprint);
});

test("page and response order affect the source fingerprint without sorting observations", async () => {
  const plan = makePlan();
  const a = transfer(sig(41), 0), b = transfer(sig(42), 0);
  const run = async (rows) => sourceFor(plan, new Map(), true, async ({ paginationToken }) => paginationToken === null
    ? { observations: [rows[0]], paginationToken: "2" }
    : { observations: [rows[1]], paginationToken: null });
  const forward = await run([a, b]);
  const reverse = await run([b, a]);
  assert.notEqual(forward.selection.sourceFingerprint, reverse.selection.sourceFingerprint);
  assert.deepEqual(forward.evidence.authorities[0].observations.map((o) => o.providerRecord.signature), [a.signature, b.signature]);
  assert.deepEqual(reverse.evidence.authorities[0].observations.map((o) => o.providerRecord.signature), [b.signature, a.signature]);

  const natural = await sourceFor(plan, new Map(), true, async ({ paginationToken }) => paginationToken === null
    ? { observations: [a], paginationToken: "2" } : { observations: [b], paginationToken: null });
  const capped = await sourceFor(plan, new Map(), true, async ({ paginationToken }) => paginationToken === null
    ? { observations: [a], paginationToken: "2" } : { observations: [b], paginationToken: "3" });
  assert.equal(natural.evidence.authorities[0].terminalReason, "natural_termination");
  assert.equal(capped.evidence.authorities[0].terminalReason, "page_cap");
  assert.notEqual(natural.selection.sourceFingerprint, capped.selection.sourceFingerprint);
});

test("V2 source references retain observed candidate-frame rank semantics", async () => {
  const plan = makePlanV2();
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const { selection } = await sourceFor(plan, new Map([[authority, [transfer(sig(45), 0)]]]));
  assert.deepEqual(selection.candidates[0].sourceObservations[0].rank, {
    basis: "observedCandidateFrameRank", value: 0,
  });
  const v1 = makePlan();
  const v1Authority = v1.candidateAuthorities[0].authorityAddress;
  const v1Source = await sourceFor(v1, new Map([[v1Authority, [transfer(sig(45), 0)]]]));
  assert.notEqual(selection.sourceFingerprint, v1Source.selection.sourceFingerprint);
});

test("selection rejects malformed historical signatures before any provider request", async () => {
  const plan = makePlan();
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const { evidence } = await sourceFor(plan, new Map([[authority, [transfer("not-a-signature", 0)]]]), false);
  assert.throws(() => createSolanaHistoricalTransactionSelection(plan, evidence), /malformed Solana transaction signature/);
});

test("zero signatures are not applicable and produce zero provider requests", async () => {
  const plan = makePlan();
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const { evidence, selection } = await sourceFor(plan, new Map([[authority, []]]));
  let calls = 0;
  const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, { fetchImpl: async () => { calls += 1; return rpc(null); } });
  assert.equal(calls, 0);
  assert.equal(result.telemetry.requestCount, 0);
  assert.equal(result.evidence.executionCompleteness, "not_applicable");
});

test("duplicate source observations fetch once and retain source links", async () => {
  await withKey(async () => {
    const plan = makePlan();
    const authority = plan.candidateAuthorities[0].authorityAddress;
    const s = sig(11);
    const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0), transfer(s, 0)]]]));
    let calls = 0;
    const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      now: fixedClock,
      fetchImpl: async () => { calls += 1; return rpc(transactionFor(s)); },
    });
    assert.equal(calls, 1);
    assert.equal(result.telemetry.requestCount, 1);
    assert.equal(result.evidence.candidates[0].sourceObservations.length, 2);
    assert.equal(result.evidence.candidates[0].normalization.status, "available");
    assert.equal(result.evidence.executionCompleteness, "complete");
  });
});

test("selected signatures are fetched once in canonical order and cap-excluded signatures are not requested", async () => {
  await withKey(async () => {
    const plan = makePlan(6);
    const transfers = new Map(plan.candidateAuthorities.map((candidate, i) => [candidate.authorityAddress, [transfer(sig(i + 20), i)]]));
    const { evidence, selection } = await sourceFor(plan, transfers);
    assert.equal(selection.selectedUniqueSignatureCount, 5);
    assert.equal(selection.candidates[5].disposition.status, "not_selected");
    const requested = [];
    const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      now: fixedClock,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        requested.push(body.params[0]);
        assert.deepEqual(body.params[1], { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 });
        return rpc(transactionFor(body.params[0]));
      },
    });
    assert.deepEqual(requested, selection.candidates.slice(0, 5).map((c) => c.signature));
    assert.equal(result.telemetry.requestCount, 5);
    assert.equal(result.telemetry.attemptedSignatureCount, 5);
    assert.equal(result.evidence.candidates[5].acquisition.status, "not_attempted");
  });
});

test("exactly five unique signatures are all selected with contiguous positions", async () => {
  const plan = makePlan(5);
  const transfers = new Map(plan.candidateAuthorities.map((candidate, i) => [candidate.authorityAddress, [transfer(sig(i + 55), i)]]));
  const { selection } = await sourceFor(plan, transfers);
  const selected = selection.candidates.filter((candidate) => candidate.disposition.status === "selected");
  assert.equal(selection.uniqueSignatureCount, 5);
  assert.deepEqual(selected.map((candidate) => candidate.disposition.selectionPosition), [0, 1, 2, 3, 4]);
});

test("configuration preflight failure records zero provider requests", async () => {
  const plan = makePlan();
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const s = sig(14);
  const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  let calls = 0;
  try {
    const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => { calls += 1; return rpc(transactionFor(s)); },
    });
    assert.equal(calls, 0);
    assert.equal(result.telemetry.requestCount, 0);
    assert.equal(result.telemetry.providerErrorCount, 1);
    assert.equal(result.evidence.candidates[0].acquisition.status, "provider_error");
    assert.equal(result.evidence.candidates[0].acquisition.error.category, "configuration");
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
});

test("provider null, RPC error, malformed response, and timeout remain distinct with no retries", async () => {
  const plan = makePlan();
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const s = sig(15);
  const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));

  await withKey(async () => {
    const nullResult = await executeSolanaTransactionEnrichment(selection, plan, evidence, { fetchImpl: async () => rpc(null) });
    assert.equal(nullResult.evidence.candidates[0].acquisition.status, "provider_result_null");
    assert.equal(nullResult.evidence.candidates[0].normalization.status, "not_applicable");

    const rpcError = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transaction-probe", error: { code: -32000, message: SECRET } }), { status: 200 }),
    });
    assert.equal(rpcError.evidence.candidates[0].acquisition.status, "provider_error");
    assert.doesNotMatch(JSON.stringify(rpcError), new RegExp(SECRET));

    const malformed = await executeSolanaTransactionEnrichment(selection, plan, evidence, { fetchImpl: async () => new Response("not-json", { status: 200 }) });
    assert.equal(malformed.evidence.candidates[0].acquisition.status, "malformed_response");

    let calls = 0;
    const timeout = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => { calls += 1; return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true })); },
    });
    assert.equal(calls, 1);
    assert.equal(timeout.telemetry.requestCount, 1);
    assert.equal(timeout.evidence.candidates[0].acquisition.status, "request_timeout");
    assert.doesNotMatch(JSON.stringify(timeout), new RegExp(SECRET));
  });
});

test("continues sequentially after one selected signature returns a provider error", async () => {
  await withKey(async () => {
    const plan = makePlan(2);
    const transfers = new Map(plan.candidateAuthorities.map((candidate, i) => [candidate.authorityAddress, [transfer(sig(i + 75), i)]]));
    const { evidence, selection } = await sourceFor(plan, transfers);
    const requested = [];
    const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async (_url, init) => {
        const requestedSignature = JSON.parse(init.body).params[0];
        requested.push(requestedSignature);
        if (requestedSignature === selection.candidates[0].signature) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transaction-probe", error: { code: -32000, message: "provider error" } }), { status: 200 });
        }
        return rpc(transactionFor(requestedSignature));
      },
    });
    assert.deepEqual(requested, selection.candidates.map((candidate) => candidate.signature));
    assert.equal(result.telemetry.requestCount, 2);
    assert.equal(result.evidence.candidates[0].acquisition.status, "provider_error");
    assert.equal(result.evidence.candidates[1].normalization.status, "available");
    assert.equal(result.evidence.executionCompleteness, "partial");
  });
});

test("source slot/time contradictions suppress normalized evidence", async () => {
  await withKey(async () => {
    const plan = makePlan();
    const authority = plan.candidateAuthorities[0].authorityAddress;
    const s = sig(16);
    const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));
    const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => rpc(transactionFor(s, { slot: 451369029 })),
    });
    assert.equal(result.evidence.candidates[0].normalization.status, "source_link_mismatch");
    assert.equal(result.evidence.candidates[0].normalization.transaction, undefined);
    assert.equal(result.evidence.executionCompleteness, "partial");
  });
});

test("known block-time contradiction and cross-wired source references fail before success", async () => {
  await withKey(async () => {
    const plan = makePlan();
    const authority = plan.candidateAuthorities[0].authorityAddress;
    const s = sig(46);
    const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));
    const timeMismatch = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => rpc(transactionFor(s, { blockTime: 1790611916 })),
    });
    assert.equal(timeMismatch.evidence.candidates[0].normalization.status, "source_link_mismatch");

    const crossed = structuredClone(selection);
    crossed.candidates[0].sourceObservations[0].sourceFingerprint = "sha256:crosswired";
    let calls = 0;
    await assert.rejects(executeSolanaTransactionEnrichment(crossed, plan, evidence, {
      fetchImpl: async () => { calls += 1; return rpc(transactionFor(s)); },
    }), /does not match its validated historical source artifact/);
    assert.equal(calls, 0);
  });
});

test("missing or null historical block time does not fabricate a source-time mismatch", async () => {
  await withKey(async () => {
    for (const state of ["missing", "null"]) {
      const plan = makePlan();
      const authority = plan.candidateAuthorities[0].authorityAddress;
      const record = transfer(sig(state === "missing" ? 47 : 48), 0);
      if (state === "missing") delete record.blockTime;
      else record.blockTime = null;
      const { evidence, selection } = await sourceFor(plan, new Map([[authority, [record]]]));
      const result = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
        fetchImpl: async () => rpc(transactionFor(record.signature, { blockTime: 1_790_000_001 })),
      });
      assert.equal(result.evidence.candidates[0].normalization.status, "available", state);
    }
  });
});

test("unsupported versions and malformed transaction structure are separate from acquisition", async () => {
  await withKey(async () => {
    const plan = makePlan();
    const authority = plan.candidateAuthorities[0].authorityAddress;
    const s = sig(17);
    const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));
    const unsupported = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => rpc(transactionFor(s, { version: 1 })),
    });
    assert.equal(unsupported.evidence.candidates[0].acquisition.status, "returned");
    assert.equal(unsupported.evidence.candidates[0].normalization.status, "unsupported_transaction_version");
    const malformed = await executeSolanaTransactionEnrichment(selection, plan, evidence, {
      fetchImpl: async () => rpc({ transaction: { signatures: [s], message: { header: { numRequiredSignatures: 2 } } } }),
    });
    assert.equal(malformed.evidence.candidates[0].acquisition.status, "returned");
    assert.equal(malformed.evidence.candidates[0].normalization.status, "malformed_structure");
  });
});

test("input selection, plan, and historical evidence are not mutated", async () => {
  await withKey(async () => {
    const plan = makePlan();
    const authority = plan.candidateAuthorities[0].authorityAddress;
    const s = sig(18);
    const { evidence, selection } = await sourceFor(plan, new Map([[authority, [transfer(s, 0)]]]));
    const before = JSON.stringify([plan, evidence, selection]);
    await executeSolanaTransactionEnrichment(selection, plan, evidence, { fetchImpl: async () => rpc(transactionFor(s)) });
    assert.equal(JSON.stringify([plan, evidence, selection]), before);
  });
});
