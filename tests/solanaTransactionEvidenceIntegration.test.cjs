const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSolanaHistoricalQueryPlan } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { executeSolanaHistoricalQueryPlan } = require("../dist/execution/solanaHistoricalQueryExecution.js");
const { createSolanaHistoricalTransactionSelection } = require("../dist/normalization/solanaHistoricalTransactionSelector.js");
const historicalTransactionSelectorModule = require("../dist/normalization/solanaHistoricalTransactionSelector.js");
const { normalizeSolanaTransactionEvidence } = require("../dist/normalization/solanaTransactionEvidence.js");
const { integrateSolanaTransactionEvidence, SolanaTransactionEvidenceIntegrationInputError } = require("../dist/normalization/solanaTransactionEvidenceIntegration.js");
const balanceFlowModule = require("../dist/normalization/solanaTokenBalanceFlowEvidence.js");
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
const signature = (n) => base58(Buffer.alloc(64, n));
const MINT = key(90);
const FETCHED_AT = "2026-10-06T12:00:00.000Z";

function makePlan(signatureCount = 1) {
  const authorityCount = 1;
  const holder = {
    chain: "solana", mintAddress: MINT, tokenProgram: "spl-token", decimals: 6,
    currentMintSupplyRaw: "100000", observedPositiveBalanceRaw: "1", supplyDifferenceRaw: "99999",
    fetchedAt: "2026-10-06T11:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 1, contextSlots: [451369028] },
    tokenAccountCount: 1, nonzeroTokenAccountCount: 1,
    tokenAccountStateSummary: { initialized: { tokenAccountCount: 1, positiveBalanceTokenAccountCount: 1, observedBalanceRaw: "1" }, frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" } },
    rawOwnerCount: 1, rawOwnerAuthorities: [{ ownerAddress: key(1), balanceRaw: "1", tokenAccountCount: 1 }],
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null }, concentration: {},
  };
  const selection = selectSolanaHistoricalAuthorities(holder, authorityCount);
  return buildSolanaHistoricalQueryPlan({ holderStructure: holder, selection,
    requestedWindow: { fromUnixSecondsInclusive: 1_790_000_000, toUnixSecondsExclusive: 1_790_100_000 },
    maxPagesPerAuthority: 2, maxRecordsPerAuthority: Math.max(4, signatureCount) });
}

function transfer(sig) {
  return {
    signature: sig, slot: 451369028, blockTime: 1790611915, type: "transfer",
    fromUserAccount: key(70), toUserAccount: key(71), fromTokenAccount: key(72), toTokenAccount: key(73), mint: MINT,
    amount: { rawAmount: "7", exactRawAvailable: true, exactnessBasis: "provider_integer_string", unavailableReason: null,
      reportedAmount: "7", reportedAmountType: "integer_string" },
  };
}

async function makeSource(signatures = [signature(1)]) {
  const plan = makePlan(signatures.length);
  const authority = plan.candidateAuthorities[0].authorityAddress;
  const fetched = await executeSolanaHistoricalQueryPlan(plan, {
    requestTimeoutMs: 1000,
    now: () => Date.parse(FETCHED_AT),
    fetchPage: async () => ({ observations: signatures.map(transfer), paginationToken: null }),
  });
  const selection = createSolanaHistoricalTransactionSelection(plan, fetched.evidence);
  return { plan, historicalEvidence: fetched.evidence, selection };
}

function rawTransaction(sig, overrides = {}) {
  const account = key(40);
  return {
    slot: 451369028, blockTime: 1790611915,
    transaction: { signatures: [sig], message: { accountKeys: [account],
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] } },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [], postTokenBalances: [], preBalances: [1], postBalances: [1] },
    version: "legacy", ...overrides,
  };
}

function requestProvenance(sig, status = "returned") {
  const provenance = { chain: "solana", provider: "helius", method: "getTransaction", encoding: "json",
    commitment: "finalized", maxSupportedTransactionVersion: 0, requestedSignature: sig, fetchedAt: FETCHED_AT };
  return status === "returned" || status === "provider_result_null" ? { status, provenance }
    : status === "request_timeout" ? { status, provenance, error: { category: "request_timeout", message: "Helius transaction request timed out." } }
      : status === "malformed_response" ? { status, provenance, message: "Helius returned a malformed transaction response." }
        : { status, provenance, error: { category: "rpc", httpStatus: null, rpcCode: -32000, message: "Helius returned a JSON-RPC transaction error." } };
}

function makePhase2A(source, options = {}) {
  const outcomes = options.outcomes ?? {};
  const candidates = source.selection.candidates.map((selected, index) => {
    if (selected.disposition.status === "not_selected") return {
      signature: selected.signature, sourceObservations: structuredClone(selected.sourceObservations),
      disposition: structuredClone(selected.disposition), acquisition: { status: "not_attempted" }, normalization: { status: "not_attempted" },
    };
    const outcome = outcomes[selected.signature] ?? "available";
    const provenance = requestProvenance(selected.signature,
      ["available", "partial_transaction", "failed_transaction", "conflicting_balance", "unsupported", "malformed_normalization", "source_link_mismatch"].includes(outcome)
        ? "returned" : outcome);
    let normalization;
    if (outcome === "available" || outcome === "partial_transaction" || outcome === "failed_transaction" || outcome === "conflicting_balance") {
      let raw = rawTransaction(selected.signature);
      if (outcome === "partial_transaction") {
        raw = rawTransaction(selected.signature, { meta: { ...raw.meta, innerInstructions: undefined } });
      } else if (outcome === "failed_transaction") {
        raw = rawTransaction(selected.signature, { meta: { ...raw.meta, err: { InstructionError: [0, "Custom"] } } });
      } else if (outcome === "conflicting_balance") {
        const entry = { accountIndex: 0, mint: MINT, owner: key(41), uiTokenAmount: { amount: "5", decimals: 6 } };
        raw = rawTransaction(selected.signature, { meta: { ...raw.meta,
          preTokenBalances: [entry, { ...entry, uiTokenAmount: { amount: "6", decimals: 6 } }],
          postTokenBalances: [entry],
        } });
      }
      const transaction = normalizeSolanaTransactionEvidence(raw, selected.signature);
      if (outcome === "conflicting_balance") transaction.accountSpace.canonicalOrder = "contradictory";
      normalization = { status: "available", transaction };
    } else if (outcome === "unsupported") normalization = { status: "unsupported_transaction_version" };
    else if (outcome === "malformed_normalization") normalization = { status: "malformed_structure" };
    else if (outcome === "source_link_mismatch") normalization = { status: "source_link_mismatch" };
    else if (outcome === "provider_result_null") normalization = { status: "not_applicable" };
    else normalization = { status: "not_attempted" };
    return { signature: selected.signature, sourceObservations: structuredClone(selected.sourceObservations),
      disposition: structuredClone(selected.disposition), acquisition: provenance, normalization };
  });

  const selected = candidates.filter((c) => c.disposition.status === "selected");
  const count = (status) => selected.filter((c) => c.acquisition.status === status).length;
  const returned = count("returned");
  const providerErrorCount = count("provider_error");
  const timeoutCount = count("request_timeout");
  const malformedCount = count("malformed_response");
  const normalizedCount = selected.filter((c) => c.normalization.status === "available").length;
  const partialStructuralCount = selected.filter((c) => c.normalization.status === "available" && c.normalization.transaction.structuralCompleteness === "partial").length;
  const failedReturnedNormalization = selected.some((c) => c.acquisition.status === "returned" && c.normalization.status !== "available");
  const executionCompleteness = selected.length === 0 ? "not_applicable"
    : providerErrorCount + timeoutCount + malformedCount > 0 || failedReturnedNormalization ? "partial" : "complete";
  const configurationCount = selected.filter((c) => c.acquisition.status === "provider_error" && c.acquisition.error.category === "configuration").length;
  return {
    selection: source.selection,
    evidence: { schemaVersion: "solana-bounded-transaction-enrichment-v1", chain: "solana", mintAddress: MINT,
      sourceFingerprint: source.selection.sourceFingerprint, selectionCompleteness: "complete", executionCompleteness, candidates },
    telemetry: { selectedUniqueSignatureCount: selected.length, attemptedSignatureCount: selected.length,
      returnedTransactionCount: returned, providerNullCount: count("provider_result_null"), providerErrorCount,
      requestTimeoutCount: timeoutCount, malformedResponseCount: malformedCount, normalizedTransactionCount: normalizedCount,
      partialStructuralTransactionCount: partialStructuralCount, requestCount: selected.length - configurationCount, elapsedMs: 1 },
  };
}

function integrate(source, phase2A = makePhase2A(source)) {
  return integrateSolanaTransactionEvidence({ phase2A, plan: source.plan, historicalEvidence: source.historicalEvidence });
}

test("integrates a successful candidate through Phase 2B, 2C, and 2D with Phase 2A provenance", async () => {
  const source = await makeSource();
  const phase2A = makePhase2A(source);
  const result = integrate(source, phase2A);
  assert.equal(result.schemaVersion, "solana-transaction-evidence-integration-v1");
  assert.equal(result.candidates[0].status, "integrated");
  const candidate = result.candidates[0];
  assert.equal(candidate.balanceFlow.phase2A.sourceFingerprint, source.selection.sourceFingerprint);
  assert.equal(candidate.balanceFlow.phase2A.transactionRequest.requestedSignature, source.selection.candidates[0].signature);
  assert.equal(candidate.instructionEvidence.transactionSignature, candidate.signature);
  assert.equal(candidate.reconciliation.transactionIdentity.status, "matched");
  assert.equal(result.coverage.candidateSet.status, "all_eligible");
  assert.equal(result.coverage.downstream.status, "complete_for_integrated_candidates");
});

test("preserves deterministic order across multiple eligible candidates", async () => {
  const source = await makeSource([signature(4), signature(2), signature(3)]);
  const result = integrate(source);
  assert.deepEqual(result.candidates.map((candidate) => candidate.signature), source.selection.candidates.map((candidate) => candidate.signature));
  assert.ok(result.candidates.every((candidate) => candidate.status === "integrated"));
  assert.deepEqual(integrate(source), result);
});

test("allows more than five total candidates while integrating only the five selected signatures", async () => {
  const source = await makeSource(Array.from({ length: 7 }, (_, i) => signature(i + 10)));
  const result = integrate(source);
  assert.equal(source.selection.candidates.length, 7);
  assert.equal(source.selection.selectedUniqueSignatureCount, 5);
  assert.equal(result.candidates.filter((candidate) => candidate.status === "integrated").length, 5);
  assert.equal(result.candidates.filter((candidate) => candidate.status === "not_eligible").length, 2);
  assert.equal(result.coverage.candidateSet.status, "some_eligible");
  for (const candidate of result.candidates.filter((item) => item.status === "not_eligible")) {
    const sourceCandidate = result.phase2A.evidence.candidates[candidate.candidateIndex];
    assert.equal(sourceCandidate.disposition.status, "not_selected");
    assert.deepEqual(sourceCandidate.acquisition, { status: "not_attempted" });
  }
});

test("requires selected candidate positions to be sequential among selected signatures", async () => {
  const invalidPositions = [
    { label: "duplicate", positions: [0, 0, 2] },
    { label: "skipped", positions: [0, 2, 3] },
    { label: "incorrect", positions: [1, 2, 3] },
  ];

  for (const { label, positions } of invalidPositions) {
    const source = await makeSource([signature(60), signature(61), signature(62)]);
    const phase2A = makePhase2A(source);
    for (let index = 0; index < positions.length; index += 1) {
      phase2A.selection.candidates[index].disposition.selectionPosition = positions[index];
      phase2A.evidence.candidates[index].disposition.selectionPosition = positions[index];
    }

    // The source selection is independently revalidated first. Bypass that
    // validation only in this focused test to exercise the integration boundary.
    const originalValidator = historicalTransactionSelectorModule.validateSolanaHistoricalTransactionSelection;
    historicalTransactionSelectorModule.validateSolanaHistoricalTransactionSelection = () => {};
    try {
      assert.throws(() => integrate(source, phase2A), /selection position/i, label);
    } finally {
      historicalTransactionSelectorModule.validateSolanaHistoricalTransactionSelection = originalValidator;
    }
  }
});

test("preserves selected provider-null, error, timeout, malformed, and unnormalized outcomes without downstream evidence", async () => {
  for (const outcome of ["provider_result_null", "provider_error", "request_timeout", "malformed_response", "unsupported", "malformed_normalization", "source_link_mismatch"]) {
    const source = await makeSource([signature(20)]);
    const result = integrate(source, makePhase2A(source, { outcomes: { [signature(20)]: outcome } }));
    assert.equal(result.candidates[0].status, "not_eligible", outcome);
    assert.equal("balanceFlow" in result.candidates[0], false, outcome);
    assert.equal(result.phase2A.evidence.candidates[0].normalization.status,
      outcome === "provider_result_null" ? "not_applicable"
        : outcome === "unsupported" ? "unsupported_transaction_version"
          : outcome === "malformed_normalization" ? "malformed_structure"
            : outcome === "source_link_mismatch" ? "source_link_mismatch" : "not_attempted", outcome);
  }
  const source = await makeSource([signature(21)]);
  const noEligible = integrate(source, makePhase2A(source, { outcomes: { [signature(21)]: "provider_error" } }));
  assert.equal(noEligible.coverage.candidateSet.status, "none_eligible");
  assert.equal(noEligible.coverage.downstream.status, "not_applicable");
});

test("failed transaction execution remains eligible and is preserved through downstream evidence", async () => {
  const source = await makeSource();
  const result = integrate(source, makePhase2A(source, { outcomes: { [signature(1)]: "failed_transaction" } }));
  const candidate = result.candidates[0];
  assert.equal(candidate.status, "integrated");
  assert.equal(candidate.balanceFlow.status, "not_applicable");
  assert.ok(candidate.balanceFlow.reasonCodes.includes("transaction_failed"));
  assert.equal(candidate.instructionEvidence.transactionExecution.evidence.status, "failed");
  assert.equal(candidate.reconciliation.executionComparison.status, "confirmed_compatible_failure");
});

test("preserves partial transaction structure and conflicting account-space evidence", async () => {
  const partialSource = await makeSource();
  const partial = integrate(partialSource, makePhase2A(partialSource, { outcomes: { [signature(1)]: "partial_transaction" } }));
  assert.equal(partial.candidates[0].status, "integrated");
  assert.equal(partial.candidates[0].instructionEvidence.coverage.inner.status, "unavailable");
  assert.equal(partial.coverage.downstream.status, "partial");

  const conflictSource = await makeSource();
  const conflict = integrate(conflictSource, makePhase2A(conflictSource, { outcomes: { [signature(1)]: "conflicting_balance" } }));
  assert.equal(conflict.candidates[0].status, "integrated");
  assert.equal(conflict.candidates[0].balanceFlow.status, "conflicting");
  assert.equal(conflict.candidates[0].reconciliation.coverage.status, "conflicting");
  assert.equal(conflict.coverage.downstream.status, "conflicting");
});

test("empty candidate source remains not-applicable rather than successful empty enrichment", async () => {
  const source = await makeSource([]);
  const result = integrate(source, makePhase2A(source));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.phase2A.evidence.executionCompleteness, "not_applicable");
  assert.deepEqual(result.coverage.candidateSet, { status: "no_candidates", candidateCount: 0, eligibleCount: 0, ineligibleCount: 0 });
  assert.equal(result.coverage.downstream.status, "not_applicable");
});

test("rejects malformed wrappers, cap violations, duplicate/reordered candidates, impossible outcomes, and signature mismatches", async () => {
  const source = await makeSource([signature(30), signature(31)]);
  const base = makePhase2A(source);
  const wrongSchema = structuredClone(base);
  wrongSchema.evidence.schemaVersion = "wrong";
  assert.throws(() => integrate(source, wrongSchema), SolanaTransactionEvidenceIntegrationInputError);

  const mismatchFingerprint = structuredClone(base);
  mismatchFingerprint.evidence.sourceFingerprint = "sha256:" + "0".repeat(64);
  assert.throws(() => integrate(source, mismatchFingerprint), SolanaTransactionEvidenceIntegrationInputError);

  const duplicate = structuredClone(base);
  duplicate.evidence.candidates[1] = structuredClone(duplicate.evidence.candidates[0]);
  assert.throws(() => integrate(source, duplicate), /candidate/i);

  const reordered = structuredClone(base);
  [reordered.evidence.candidates[0], reordered.evidence.candidates[1]] = [reordered.evidence.candidates[1], reordered.evidence.candidates[0]];
  assert.throws(() => integrate(source, reordered), /candidate/i);

  const impossible = structuredClone(base);
  impossible.evidence.candidates[0].acquisition = { status: "provider_result_null", provenance: requestProvenance(signature(30)).provenance };
  impossible.evidence.candidates[0].normalization = { status: "available", transaction: normalizeSolanaTransactionEvidence(rawTransaction(signature(30)), signature(30)) };
  assert.throws(() => integrate(source, impossible), /Null Phase 2A result/);

  const txMismatch = structuredClone(base);
  txMismatch.evidence.candidates[0].normalization.transaction.signatures[0] = signature(99);
  assert.throws(() => integrate(source, txMismatch), /signature/i);

  const provenanceMismatch = structuredClone(base);
  provenanceMismatch.evidence.candidates[0].acquisition.provenance.requestedSignature = signature(99);
  assert.throws(() => integrate(source, provenanceMismatch), /provenance/i);

  const tooManySelectedSource = await makeSource(Array.from({ length: 6 }, (_, i) => signature(i + 40)));
  const tooManySelected = makePhase2A(tooManySelectedSource);
  tooManySelected.selection.selectedUniqueSignatureCount = 6;
  assert.throws(() => integrate(tooManySelectedSource, tooManySelected), SolanaTransactionEvidenceIntegrationInputError);

  const outOfBounds = structuredClone(base);
  outOfBounds.selection.candidates.push(structuredClone(outOfBounds.selection.candidates[0]));
  assert.throws(() => integrate(source, outOfBounds), /selection|source/i);
});

test("propagates unexpected downstream normalizer exceptions instead of converting them into evidence", async () => {
  const source = await makeSource();
  const original = balanceFlowModule.normalizeSolanaTokenBalanceFlowEvidence;
  balanceFlowModule.normalizeSolanaTokenBalanceFlowEvidence = () => { throw new Error("normalizer programming failure"); };
  try {
    assert.throws(() => integrate(source), /normalizer programming failure/);
  } finally {
    balanceFlowModule.normalizeSolanaTokenBalanceFlowEvidence = original;
  }
});

test("rejects inconsistent execution completeness and telemetry", async () => {
  const source = await makeSource();
  const wrongCompleteness = makePhase2A(source);
  wrongCompleteness.evidence.executionCompleteness = "not_applicable";
  assert.throws(() => integrate(source, wrongCompleteness), /execution completeness/i);
  const wrongTelemetry = makePhase2A(source);
  wrongTelemetry.telemetry.requestCount = 0;
  assert.throws(() => integrate(source, wrongTelemetry), /telemetry/i);
});

test("rejects mismatched query plan or historical source linkage", async () => {
  const source = await makeSource();
  const wrongPlan = structuredClone(source.plan);
  wrongPlan.mintAddress = key(99);
  assert.throws(() => integrateSolanaTransactionEvidence({ phase2A: makePhase2A(source), plan: wrongPlan,
    historicalEvidence: source.historicalEvidence }), SolanaTransactionEvidenceIntegrationInputError);
  const alteredHistory = structuredClone(source.historicalEvidence);
  alteredHistory.provenance.fetchedAt = "2026-10-07T00:00:00.000Z";
  assert.throws(() => integrateSolanaTransactionEvidence({ phase2A: makePhase2A(source), plan: source.plan,
    historicalEvidence: alteredHistory }), SolanaTransactionEvidenceIntegrationInputError);
});

test("does not mutate source inputs, call fetch, or produce different output for identical input", async () => {
  const source = await makeSource([signature(50), signature(51)]);
  const phase2A = makePhase2A(source);
  const before = structuredClone({ source, phase2A });
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalls += 1; throw new Error("integration must not fetch"); };
  try {
    const first = integrate(source, phase2A);
    const second = integrate(source, phase2A);
    assert.deepEqual(first, second);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual({ source, phase2A }, before);
});

