const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, readdir, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const reportService = require("../dist/application/solanaTokenEvidenceReport.js");
const originalGenerateWithTelemetry = reportService.generateSolanaTokenEvidenceReportWithTelemetry;
let fixtureOptions = {};
let fakeProviderCallCount = 0;
let reportInvocationCount = 0;

reportService.generateSolanaTokenEvidenceReportWithTelemetry = async (request, _injected, options, context) => {
  reportInvocationCount += 1;
  assert.equal(context?.dispatchCapability?.mode, "protected", "report generation receives the protected dispatch capability");
  if (fixtureOptions.authorizationDenied) context.dispatchCapability.authorizeFetchInvocation();
  const result = await originalGenerateWithTelemetry(request, {
    getAccount: async (address) => {
      fakeProviderCallCount += 1;
      return fixtureOptions.mintUnavailable ? null : mintAccount(address);
    },
    getMarkets: async () => {
      fakeProviderCallCount += 1;
      if (fixtureOptions.marketUnavailable) throw new DexScreenerProviderError("http_error", 503);
      return [];
    },
    getTokenAccountPages: async () => {
      fakeProviderCallCount += 1;
      if (fixtureOptions.holdersUnavailable) throw new Error("offline fixture only");
      return {
        status: "available",
        completeness: fixtureOptions.holdersPartial ? "partial" : "complete",
        stopReason: fixtureOptions.holdersPartial ? "request_timeout" : "provider_terminated",
        configuredMaxPages: 20,
        requestedPageSize: 5000,
        pages: [{ accounts: [], paginationKey: fixtureOptions.holdersPartial ? "next" : null, contextSlot: 321 }],
      };
    },
    now: () => new Date("2026-10-15T12:00:00.000Z"),
  }, options, context);
  if (fixtureOptions.mutateReport) fixtureOptions.mutateReport(result.report);
  return result;
};

const {
  captureSolanaReferenceCase,
  captureSolanaReferenceCaseBatch,
  canonicalizeSolanaReferenceCaseValue,
  deriveMetricsFromSolanaReferenceCase,
  deriveMetricsFromSolanaReferenceCaseFile,
  loadSolanaReferenceCaseArtifact,
  verifySolanaReferenceCaseArtifact,
  writeSolanaReferenceCaseArtifact,
  SolanaReferenceCaseError,
} = require("../dist/application/solanaReferenceCase.js");
const { createSolanaTokenEvidenceAdmissionController } = require("../dist/application/solanaTokenEvidenceAdmissionController.js");
const { createSolanaProviderRequestBudgetController } = require("../dist/application/solanaProviderRequestBudgetController.js");
const { deriveSolanaQualificationMetricEvidence } = require("../dist/analysis/solanaQualificationMetricEvidence.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");
const { DexScreenerProviderError } = require("../dist/providers/market/dexScreener.js");

function unavailableMarketMetric(reason = "not_reported") {
  return { status: "unavailable", value: null, reason };
}

function marketPoolWithDexId(dexId) {
  const fetchedAt = "2026-10-15T12:00:00.000Z";
  return {
    poolAddress: key(70),
    dexId,
    counterTokenAddress: key(71),
    poolCreatedAt: unavailableMarketMetric(),
    priceUsd: unavailableMarketMetric(),
    marketCapUsd: unavailableMarketMetric(),
    fdvUsd: unavailableMarketMetric(),
    liquidityUsd: unavailableMarketMetric(),
    volumeUsd: { m5: unavailableMarketMetric(), h1: unavailableMarketMetric(), h6: unavailableMarketMetric(), h24: unavailableMarketMetric() },
    provenance: { provider: "dexscreener", fetchedAt, sourceUpdatedAt: null },
  };
}

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(90);

function mintAccount(address) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(100n, 36);
  data[44] = 6;
  data[45] = 1;
  return {
    requestedAddress: address,
    owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"],
    dataBase64: data.toString("base64"),
  };
}

function controllerDependencies({ capacity = 22, acquire, release } = {}) {
  const admissionController = createSolanaTokenEvidenceAdmissionController({
    maxConcurrentExecutions: 1,
    initiallyEnabled: true,
  });
  const admissionPolicy = acquire
    ? { acquire }
    : {
        acquire: async () => ({
          release: release ?? (() => {}),
        }),
      };
  const providerRequestBudgetController = createSolanaProviderRequestBudgetController({
    capacity,
    initiallyEnabled: true,
  });
  return { admissionController, admissionPolicy, providerRequestBudgetController };
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tqe-reference-case-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function resignCase(value) {
  const payload = structuredClone(value);
  delete payload.contentHash;
  const digestHex = createHash("sha256").update(canonicalizeSolanaReferenceCaseValue(payload), "utf8").digest("hex");
  return {
    ...payload,
    contentHash: {
      algorithm: "sha256",
      canonicalization: "tqe-canonical-json-v1",
      digestHex,
    },
  };
}

async function capture(directory, options = {}) {
  fixtureOptions = options.fixtureOptions ?? {};
  const deps = controllerDependencies(options);
  return captureSolanaReferenceCase(options.mintAddress ?? MINT, {
    ...deps,
    storageDirectory: directory,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

test("canonical JSON sorts object keys recursively, preserves arrays, and rejects unsupported values", () => {
  assert.equal(canonicalizeSolanaReferenceCaseValue({ z: 1, a: { y: 2, b: 3 }, list: [2, 1] }),
    '{"a":{"b":3,"y":2},"list":[2,1],"z":1}');
  for (const bad of [undefined, 1n, NaN, Infinity, () => {}, Symbol("x"), new Date()]) {
    assert.throws(() => canonicalizeSolanaReferenceCaseValue({ bad }), (error) => error instanceof SolanaReferenceCaseError);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeSolanaReferenceCaseValue(cyclic), (error) => error.reason === "invalid_case");
});

test("captures through protected execution with history disabled and telemetry separate from evidence", async (t) => {
  const directory = await tempDirectory(t);
  reportInvocationCount = 0;
  fakeProviderCallCount = 0;
  const originalFetch = global.fetch;
  let networkRequests = 0;
  global.fetch = async () => { networkRequests += 1; throw new Error("network is forbidden in this test"); };
  let result;
  try { result = await capture(directory); }
  finally { global.fetch = originalFetch; }
  assert.equal(networkRequests, 0);
  assert.equal(reportInvocationCount, 1);
  assert.equal(fakeProviderCallCount, 3, "all acquisition functions are offline fakes");
  assert.equal(result.referenceCase.capture.request.assetAddress, MINT);
  assert.deepEqual(result.referenceCase.capture.request.historicalTransactions, { status: "not_requested" });
  assert.equal(result.referenceCase.capture.executionBoundary, "protected_public_execution");
  assert.equal(result.referenceCase.capture.requestBudgetEnvelope, 22);
  assert.equal(result.referenceCase.capture.operationalTelemetry.schemaVersion, "solana-report-operational-telemetry-v1");
  assert.equal(result.referenceCase.capture.operationalTelemetry.providerUsage.status, "unknown");
  assert.equal(result.referenceCase.capture.operationalTelemetry.monetaryCost.status, "unknown");
  assert.equal(result.referenceCase.evidenceReport.schemaVersion, "solana-token-evidence-report-v1");
  assert.equal(result.referenceCase.evidenceReport.historicalTransactions.status, "not_requested");
  assert.equal(result.referenceCase.evidenceReport.mint.evidence.resolution.mintAddress, MINT);
  assert.ok(Date.parse(result.referenceCase.capture.completedAt) >= Date.parse(result.referenceCase.capture.startedAt));
  assert.notEqual(result.referenceCase.capture.startedAt, result.referenceCase.evidenceReport.generatedAt);
  assert.deepEqual(result.referenceCase.limitations, ["history_not_requested", "report_not_atomic"]);
  assert.equal(result.referenceCase.capture.operationalTelemetry.counts.attemptedRequestCount, 0,
    "injected test dependencies produce dependency-only observation, not an assertion of zero network activity");
  assert.equal(result.referenceCase.capture.operationalTelemetry.requestObservationCoverage, "partial",
    "dependency-only evidence does not claim zero actual network requests");
  assert.equal(path.dirname(result.filePath), await require("node:fs/promises").realpath(directory));
  assert.equal((await readdir(directory)).length, 1);
  if (process.platform !== "win32") assert.equal((await stat(result.filePath)).mode & 0o777, 0o600);
  assert.ok((await stat(result.filePath)).size > 0);
  const serialized = await readFile(result.filePath, "utf8");
  assert.equal(serialized, canonicalizeSolanaReferenceCaseValue(result.referenceCase));
  const verified = verifySolanaReferenceCaseArtifact(serialized);
  assert.equal(verified.integrity, "valid");
  assert.equal(verified.provenance, "capture_path_claim_unverified");
});

test("real report service uses built-in protected adapters with offline transport mocks", async (t) => {
  const directory = await tempDirectory(t);
  const originalReportService = reportService.generateSolanaTokenEvidenceReportWithTelemetry;
  const originalFetch = global.fetch;
  const originalHeliusKey = process.env.HELIUS_API_KEY;
  const calls = [];
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1_000_000n, 36);
  mintData[44] = 6;
  mintData[45] = 1;
  const mockResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
  reportService.generateSolanaTokenEvidenceReportWithTelemetry = originalGenerateWithTelemetry;
  process.env.HELIUS_API_KEY = "phase4dc-offline-test-only";
  global.fetch = async (url, init = {}) => {
    const endpoint = String(url);
    if (endpoint.startsWith("https://api.dexscreener.com/")) {
      calls.push("market");
      assert.ok(init.signal instanceof AbortSignal);
      return mockResponse([]);
    }
    assert.ok(endpoint.startsWith("https://mainnet.helius-rpc.com/"));
    const body = JSON.parse(init.body);
    calls.push(body.method);
    assert.ok(init.signal instanceof AbortSignal);
    if (body.method === "getAccountInfo") {
      return mockResponse({ jsonrpc: "2.0", id: 1, result: { context: { slot: 101 }, value: {
        owner: SOLANA_TOKEN_PROGRAM_IDS["spl-token"], data: [mintData.toString("base64"), "base64"],
      } } });
    }
    if (body.method === "getProgramAccountsV2") {
      return mockResponse({ jsonrpc: "2.0", id: "token-accounts", result: { context: { slot: 102 }, value: {
        accounts: [], paginationKey: null,
      } } });
    }
    throw new Error("unexpected offline transport request");
  };
  const controls = controllerDependencies({ capacity: 22 });
  try {
    const result = await captureSolanaReferenceCase(MINT, {
      ...controls,
      storageDirectory: directory,
    });
    assert.deepEqual(calls, ["getAccountInfo", "market", "getProgramAccountsV2"]);
    assert.equal(controls.providerRequestBudgetController.getStatus().consumed, 3);
    assert.equal(controls.providerRequestBudgetController.getStatus().available, 19);
    assert.equal(result.referenceCase.evidenceReport.mint.status, "present");
    assert.equal(result.referenceCase.evidenceReport.mint.evidence.resolution.mintAddress, MINT);
    assert.equal(result.referenceCase.evidenceReport.market.status, "present");
    assert.equal(result.referenceCase.evidenceReport.holders.status, "present");
    assert.deepEqual(result.referenceCase.evidenceReport.historicalTransactions, { status: "not_requested" });
    const telemetry = result.referenceCase.capture.operationalTelemetry;
    assert.equal(telemetry.counts.bySection.mint.attemptedRequestCount, 1);
    assert.equal(telemetry.counts.bySection.market.attemptedRequestCount, 1);
    assert.equal(telemetry.counts.bySection.holders.attemptedRequestCount, 1);
    assert.ok(telemetry.requestObservations.every((observation) => observation.requestAttempted && observation.outcome === "accepted"));
    assert.equal(telemetry.requestObservations.length, 3);
    assert.equal(telemetry.providerUsage.status, "unknown");
    assert.equal(telemetry.monetaryCost.status, "unknown");
    const loaded = await loadSolanaReferenceCaseArtifact(result.filePath);
    assert.equal(loaded.integrity, "valid");
    assert.equal(loaded.provenance, "capture_path_claim_unverified");
    assert.deepEqual(await deriveMetricsFromSolanaReferenceCaseFile(result.filePath),
      deriveSolanaQualificationMetricEvidence(result.referenceCase.evidenceReport));
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    reportService.generateSolanaTokenEvidenceReportWithTelemetry = originalReportService;
    global.fetch = originalFetch;
    if (originalHeliusKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = originalHeliusKey;
  }
});

test("preserves partial and unavailable sections without upgrading or converting them", async (t) => {
  const directory = await tempDirectory(t);
  const { referenceCase } = await capture(directory, {
    fixtureOptions: { holdersPartial: true, marketUnavailable: true },
  });
  assert.equal(referenceCase.evidenceReport.market.status, "unavailable");
  assert.equal(referenceCase.evidenceReport.holders.status, "present");
  assert.equal(referenceCase.evidenceReport.holders.evidence.holderStructure.enumeration.completeness, "partial");
  const reloaded = await loadSolanaReferenceCaseArtifact(path.join(directory, `${referenceCase.caseId}.json`));
  assert.equal(reloaded.referenceCase.evidenceReport.market.status, "unavailable");
  assert.equal(reloaded.referenceCase.evidenceReport.holders.evidence.holderStructure.enumeration.completeness, "partial");
});

test("rejects unresolved mint identity and identity contradictions", async (t) => {
  const directory = await tempDirectory(t);
  fixtureOptions = { mintUnavailable: true };
  const unresolvedDeps = controllerDependencies();
  await assert.rejects(captureSolanaReferenceCase(MINT, { ...unresolvedDeps, storageDirectory: directory }),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "unresolved_mint");
  assert.equal(await readdir(directory).then((items) => items.length), 0);

  fixtureOptions = {};
  const { referenceCase } = await capture(directory);
  const mismatched = structuredClone(referenceCase);
  mismatched.evidenceReport.assetAddress = key(91);
  const resigned = resignCase(mismatched);
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(resigned)),
    (error) => error instanceof SolanaReferenceCaseError && ["identity_mismatch", "invalid_case"].includes(error.reason));

  const unresolved = structuredClone(referenceCase);
  unresolved.evidenceReport.mint = { status: "unavailable", reason: "mint_provider_unavailable", errorCategory: "network" };
  const unresolvedResigned = resignCase(unresolved);
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(unresolvedResigned)),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "unresolved_mint");
});

test("hash verification detects content changes and rejects synthetic provenance even with a recomputed hash", async (t) => {
  const directory = await tempDirectory(t);
  const { referenceCase } = await capture(directory);
  const tampered = structuredClone(referenceCase);
  tampered.evidenceReport.assetAddress = key(92);
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(tampered)),
    (error) => error.reason === "identity_mismatch" || error.reason === "integrity_mismatch");

  const harmlessTamper = structuredClone(referenceCase);
  harmlessTamper.evidenceReport.generatedAt = "2026-10-14T12:00:00.000Z";
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(harmlessTamper)),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "integrity_mismatch");

  const synthetic = structuredClone(referenceCase);
  synthetic.capture.captureOrigin = "synthetic_test_fixture";
  const syntheticWithHash = resignCase(synthetic);
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(syntheticWithHash)),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "synthetic_capture_not_accepted");
});

test("does not persist after cancellation, admission denial, budget denial, or permit cleanup failure", async (t) => {
  const directory = await tempDirectory(t);
  reportInvocationCount = 0;
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = controllerDependencies();
  await assert.rejects(captureSolanaReferenceCase(MINT, {
    ...cancelled, storageDirectory: directory, signal: aborted.signal,
  }));
  assert.equal(reportInvocationCount, 0);

  const denied = controllerDependencies({ acquire: async () => { throw new Error("deny"); } });
  await assert.rejects(captureSolanaReferenceCase(MINT, { ...denied, storageDirectory: directory }));
  assert.equal(reportInvocationCount, 0);

  const exhausted = controllerDependencies({ capacity: 21 });
  await assert.rejects(captureSolanaReferenceCase(MINT, { ...exhausted, storageDirectory: directory }));
  assert.equal(reportInvocationCount, 0);

  const releaseFailure = controllerDependencies({ release: () => { throw new Error("cleanup failure"); } });
  await assert.rejects(captureSolanaReferenceCase(MINT, { ...releaseFailure, storageDirectory: directory }));
  assert.equal(reportInvocationCount, 1, "the protected report ran, but permit cleanup failed");
  assert.equal(await readdir(directory).then((items) => items.length), 0);
});

test("does not persist if dispatch authorization or canonical serialization fails", async (t) => {
  const directory = await tempDirectory(t);
  reportInvocationCount = 0;
  fixtureOptions = { authorizationDenied: true };
  const denyingBudget = {
    reserve: () => ({
      consume: () => { const { SolanaProviderRequestBudgetError } = require("../dist/types/solanaProviderRequestBudget.js"); throw new SolanaProviderRequestBudgetError("lease_exhausted"); },
      settle: () => {},
    }),
  };
  const deniedDeps = controllerDependencies();
  await assert.rejects(captureSolanaReferenceCase(MINT, {
    ...deniedDeps,
    providerRequestBudgetController: denyingBudget,
    storageDirectory: directory,
  }));
  assert.equal(await readdir(directory).then((items) => items.length), 0);

  const unsafeMutations = [
    (report) => { report.market.apiKey = "sentinel"; },
    (report) => { report.market.authenticatedEndpoint = "https://provider.invalid/?key=sentinel"; },
    (report) => { report.market.evidence.rawProviderErrorBody = "provider body"; },
    (report) => { report.market.evidence.paginationCursor = "opaque-cursor"; },
    (report) => { report.market.evidence.pools = [marketPoolWithDexId("https://provider.invalid/?api-key=sentinel")]; },
  ];
  for (const mutateReport of unsafeMutations) {
    fixtureOptions = { mutateReport };
    await assert.rejects(capture(directory, { fixtureOptions }),
      (error) => error instanceof SolanaReferenceCaseError && error.reason === "invalid_case");
    assert.equal(await readdir(directory).then((items) => items.length), 0, "rejected unsafe evidence leaves no artifact");
  }
});

test("uses create-only storage and rejects repository paths and credential-bearing values", async (t) => {
  const directory = await tempDirectory(t);
  const { referenceCase, filePath } = await capture(directory);
  const original = await readFile(filePath, "utf8");
  await assert.rejects(writeSolanaReferenceCaseArtifact(referenceCase, directory),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "case_exists");
  assert.equal(await readFile(filePath, "utf8"), original);
  await assert.rejects(writeSolanaReferenceCaseArtifact(referenceCase, process.cwd()),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "invalid_storage_path");
  assert.throws(() => canonicalizeSolanaReferenceCaseValue({ apiKey: "sentinel" }),
    (error) => error.reason === "invalid_case");
  assert.throws(() => canonicalizeSolanaReferenceCaseValue({ provenance: "https://host.invalid/?api-key=secret" }),
    (error) => error.reason === "invalid_case");
  assert.throws(() => canonicalizeSolanaReferenceCaseValue({ paginationCursor: "opaque" }),
    (error) => error.reason === "invalid_case");
  assert.throws(() => canonicalizeSolanaReferenceCaseValue({ rawProviderErrorBody: "body" }),
    (error) => error.reason === "invalid_case");
  assert.equal(canonicalizeSolanaReferenceCaseValue({ dexId: "https://dex.example/adapter" }),
    '{"dexId":"https://dex.example/adapter"}');
});

test("preserves a URL-like DEX identifier as authoritative evidence", async (t) => {
  const directory = await tempDirectory(t);
  const dexId = "https://dex.example/adapter-name";
  const { referenceCase, filePath } = await capture(directory, {
    fixtureOptions: { mutateReport: (report) => { report.market.evidence.pools = [marketPoolWithDexId(dexId)]; } },
  });
  assert.equal(referenceCase.evidenceReport.market.evidence.pools[0].dexId, dexId);
  const serialized = await readFile(filePath, "utf8");
  assert.ok(serialized.includes(dexId));
  assert.equal(verifySolanaReferenceCaseArtifact(serialized).integrity, "valid");
});

test("recomputes the existing Phase 4B ledger offline from a loaded saved report", async (t) => {
  const directory = await tempDirectory(t);
  const { referenceCase, filePath } = await capture(directory);
  const expected = deriveSolanaQualificationMetricEvidence(referenceCase.evidenceReport);
  const fromBytes = deriveMetricsFromSolanaReferenceCase(await readFile(filePath, "utf8"));
  const fromFile = await deriveMetricsFromSolanaReferenceCaseFile(filePath);
  assert.deepEqual(fromBytes, expected);
  assert.deepEqual(fromFile, expected);
  assert.equal(Object.hasOwn(referenceCase, "metricEvidence"), false);
});

test("validates batch size and all identities before any capture, then runs sequentially", async (t) => {
  const directory = await tempDirectory(t);
  fixtureOptions = {};
  reportInvocationCount = 0;
  const deps = controllerDependencies({ capacity: 110 });
  const tooMany = Array.from({ length: 6 }, (_, index) => key(100 + index));
  await assert.rejects(captureSolanaReferenceCaseBatch(tooMany, { ...deps, storageDirectory: directory }));
  await assert.rejects(captureSolanaReferenceCaseBatch([key(101), "bad-address"], { ...deps, storageDirectory: directory }));
  await assert.rejects(captureSolanaReferenceCaseBatch([key(101), key(101)], { ...deps, storageDirectory: directory }));
  assert.equal(reportInvocationCount, 0);

  const addresses = Array.from({ length: 5 }, (_, index) => key(110 + index));
  let active = 0;
  let maximumActive = 0;
  const batchDeps = controllerDependencies({
    capacity: 110,
    acquire: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return { release: () => { active -= 1; } };
    },
  });
  const results = await captureSolanaReferenceCaseBatch(addresses, { ...batchDeps, storageDirectory: directory });
  assert.equal(results.length, 5);
  assert.equal(reportInvocationCount, 5);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.ok(results.every((item) => item.referenceCase.capture.requestBudgetEnvelope === 22));
  assert.ok(results.every((item) => item.referenceCase.capture.request.historicalTransactions.status === "not_requested"));
});

test("rejects a conflicting section state instead of normalizing it to empty or unavailable", async (t) => {
  const directory = await tempDirectory(t);
  const { referenceCase } = await capture(directory);
  const conflicting = structuredClone(referenceCase);
  conflicting.evidenceReport.market = { status: "conflicting", reason: "fabricated" };
  const resigned = resignCase(conflicting);
  assert.throws(() => verifySolanaReferenceCaseArtifact(canonicalizeSolanaReferenceCaseValue(resigned)),
    (error) => error instanceof SolanaReferenceCaseError && error.reason === "invalid_case");
});
