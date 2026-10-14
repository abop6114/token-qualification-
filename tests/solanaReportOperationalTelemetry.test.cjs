const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  aggregateSolanaReportOperationalTelemetry,
  SolanaReportOperationalTelemetryInputError,
} = require("../dist/application/solanaReportOperationalTelemetry.js");
const { SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION } = require("../dist/types/solanaReportOperationalTelemetry.js");

const stageIds = [
  "mint_acquisition", "mint_normalization", "market_acquisition", "market_normalization",
  "holder_acquisition", "holder_normalization", "historical_selection_and_planning",
  "historical_page_acquisition", "historical_metrics_and_transaction_selection",
  "transaction_enrichment", "phase2e_integration",
];
const requestStage = {
  mint: "mint_acquisition", market: "market_acquisition", holders: "holder_acquisition",
  historical_acquisition: "historical_page_acquisition", transaction_enrichment: "transaction_enrichment",
};
const stageSection = {
  mint_acquisition: "mint", mint_normalization: "mint",
  market_acquisition: "market", market_normalization: "market",
  holder_acquisition: "holders", holder_normalization: "holders",
  historical_selection_and_planning: "historical_acquisition", historical_page_acquisition: "historical_acquisition",
  historical_metrics_and_transaction_selection: "historical_acquisition", transaction_enrichment: "transaction_enrichment",
  phase2e_integration: "historical_acquisition",
};
const opDetails = {
  getAccountInfo: ["helius", "mint"], tokenPairs: ["dexscreener", "market"],
  getProgramAccountsV2: ["helius", "holders"], getTransfersByAddress: ["helius", "historical_acquisition"],
  getTransaction: ["helius", "transaction_enrichment"],
};

function request(sequence, operation, outcome = "accepted", responseReceived = outcome !== "transport_error" && outcome !== "request_cancelled") {
  const [provider, section] = opDetails[operation];
  return {
    requestSequence: sequence, section, provider, operation, requestAttempted: true,
    responseReceived, outcome, elapsedMs: sequence / 10,
    measurementBasis: "instrumented_fetch_invocation",
    providerUsage: { status: "unknown", reason: "provider_usage_not_observed" },
  };
}

function stage(id, overrides = {}) {
  const acquisition = Object.values(requestStage).includes(id);
  const defaultSkipped = acquisition;
  const historyNotRequested = id === "historical_page_acquisition" || id === "transaction_enrichment";
  const outcome = defaultSkipped ? (historyNotRequested ? "not_requested" : "skipped") : "completed";
  const reasonCode = defaultSkipped ? (historyNotRequested ? "history_not_requested" : "prerequisite_not_met") : null;
  return {
    stage: id,
    section: stageSection[id],
    outcome,
    reasonCode,
    elapsedMs: null,
    acquisitionDisposition: acquisition ? (historyNotRequested ? "not_requested" : "not_applicable") : null,
    requestObservationCoverage: defaultSkipped
      ? { status: "not_attempted", reason: "prerequisite_not_met" }
      : { status: "complete" },
    ...overrides,
  };
}

function stagesFor(requests, overrides = {}) {
  const usedSections = new Set(requests.map((entry) => entry.section));
  return stageIds.map((id) => {
    const section = stageSection[id];
    if (requestStage[section] === id && usedSections.has(section)) {
      return stage(id, {
        outcome: "completed", reasonCode: null, acquisitionDisposition: "complete",
        requestObservationCoverage: { status: "complete" },
        ...(overrides[id] || {}),
      });
    }
    return stage(id, overrides[id] || {});
  });
}

function run(requests = [], stages = stagesFor(requests), elapsed = 123) {
  return aggregateSolanaReportOperationalTelemetry({ requestObservations: requests, stageObservations: stages, reportElapsedMs: elapsed });
}

function expectReason(reason, callback) {
  assert.throws(callback, (error) => error instanceof SolanaReportOperationalTelemetryInputError && error.reason === reason);
}

test("empty request observations with explicit legitimate skipped/not-requested stages yield none, not complete", () => {
  const result = run();
  assert.equal(result.requestObservations.length, 0);
  assert.equal(result.requestObservationCoverage, "none");
  assert.equal(result.counts.attemptedRequestCount, 0);
  assert.ok(result.stageObservations.every((entry) => entry.requestObservationCoverage.status === "not_attempted" || entry.requestObservationCoverage.status === "complete"));
});

test("one accepted mint request is counted only from its request event", () => {
  const result = run([request(1, "getAccountInfo")]);
  assert.equal(result.schemaVersion, SOLANA_REPORT_OPERATIONAL_TELEMETRY_SCHEMA_VERSION);
  assert.equal(result.chain, "solana");
  assert.equal(result.counts.attemptedRequestCount, 1);
  assert.equal(result.counts.responseReceivedCount, 1);
  assert.equal(result.counts.acceptedOperationCount, 1);
  assert.equal(result.counts.bySection.mint.attemptedRequestCount, 1);
  assert.equal(result.requestObservationCoverage, "complete");
});

test("all supported provider operations are paired with the correct provider and section", () => {
  const result = run([
    request(1, "getAccountInfo"), request(2, "tokenPairs"), request(3, "getProgramAccountsV2"),
    request(4, "getTransfersByAddress"), request(5, "getTransaction"),
  ]);
  assert.deepEqual(result.requestObservations.map((entry) => entry.operation), [
    "getAccountInfo", "tokenPairs", "getProgramAccountsV2", "getTransfersByAddress", "getTransaction",
  ]);
  assert.equal(result.counts.attemptedRequestCount, 5);
  assert.equal(result.counts.bySection.historical_acquisition.attemptedRequestCount, 1);
  assert.equal(result.counts.bySection.transaction_enrichment.attemptedRequestCount, 1);
});

test("HTTP, RPC, and malformed-response outcomes each count as received failures", () => {
  const result = run([
    request(1, "getAccountInfo", "http_error"), request(2, "tokenPairs", "rpc_error"),
    request(3, "getProgramAccountsV2", "malformed_response"),
  ]);
  assert.equal(result.counts.responseReceivedCount, 3);
  assert.equal(result.counts.failedOperationCount, 3);
  assert.equal(result.counts.acceptedOperationCount, 0);
});

test("transport failure is counted without a response", () => {
  const result = run([request(1, "getAccountInfo", "transport_error", false)]);
  assert.equal(result.counts.attemptedRequestCount, 1);
  assert.equal(result.counts.responseReceivedCount, 0);
  assert.equal(result.counts.failedOperationCount, 1);
});

test("timeouts with and without a response count as failures and timeout subset", () => {
  const result = run([request(1, "getAccountInfo", "request_timeout", true), request(2, "tokenPairs", "request_timeout", false)]);
  assert.equal(result.counts.responseReceivedCount, 1);
  assert.equal(result.counts.failedOperationCount, 2);
  assert.equal(result.counts.timeoutCount, 2);
  assert.equal(result.counts.bySection.market.timeoutCount, 1);
});

test("multiple holder page requests count independently", () => {
  const result = run([request(1, "getAccountInfo"), request(2, "getProgramAccountsV2"), request(3, "getProgramAccountsV2")]);
  assert.equal(result.counts.bySection.holders.attemptedRequestCount, 2);
  assert.equal(result.counts.attemptedRequestCount, 3);
});

test("historical and transaction request events are counted once each", () => {
  const result = run([request(1, "getTransfersByAddress"), request(2, "getTransaction")]);
  assert.equal(result.counts.attemptedRequestCount, 2);
  assert.equal(result.counts.bySection.historical_acquisition.attemptedRequestCount, 1);
  assert.equal(result.counts.bySection.transaction_enrichment.attemptedRequestCount, 1);
});

test("out-of-order completion input is emitted in invocation-sequence order", () => {
  const result = run([request(3, "getProgramAccountsV2"), request(1, "getAccountInfo"), request(2, "tokenPairs")]);
  assert.deepEqual(result.requestObservations.map((entry) => entry.requestSequence), [1, 2, 3]);
});

test("duplicate and invalid request sequence values are rejected", () => {
  expectReason("duplicate_request_sequence", () => run([request(1, "getAccountInfo"), request(1, "tokenPairs")]));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const item = request(1, "getAccountInfo"); item.requestSequence = value;
    expectReason("invalid_request_sequence", () => run([item]));
  }
});

test("invalid request durations and response/outcome combinations are rejected", () => {
  for (const elapsedMs of [-1, Infinity, NaN, "1"]) {
    const item = request(1, "getAccountInfo"); item.elapsedMs = elapsedMs;
    expectReason("invalid_request_observation", () => run([item]));
  }
  const acceptedWithoutResponse = request(1, "getAccountInfo"); acceptedWithoutResponse.responseReceived = false;
  expectReason("invalid_request_observation", () => run([acceptedWithoutResponse]));
  const transportWithResponse = request(1, "getAccountInfo", "transport_error", true);
  expectReason("invalid_request_observation", () => run([transportWithResponse]));
});

test("invalid provider-operation and operation-section pairings are rejected", () => {
  const wrongProvider = request(1, "getAccountInfo"); wrongProvider.provider = "dexscreener";
  expectReason("invalid_request_observation", () => run([wrongProvider]));
  const wrongSection = request(1, "tokenPairs"); wrongSection.section = "mint";
  expectReason("invalid_request_observation", () => run([wrongSection]));
});

test("stage identifiers must use their contract section and may occur only once", () => {
  const wrong = stagesFor([]); wrong[0].section = "market";
  expectReason("invalid_stage_observation", () => run([], wrong));
  const duplicate = [...stagesFor([]), stagesFor([])[0]];
  expectReason("duplicate_stage_observation", () => run([], duplicate));
});

test("dependency-only coverage with zero request events is partial", () => {
  const stages = stagesFor([]);
  stages[0] = stage("mint_acquisition", {
    outcome: "completed", reasonCode: null, acquisitionDisposition: "complete",
    requestObservationCoverage: { status: "dependency_only", reason: "dependency_not_instrumented" },
  });
  assert.equal(run([], stages).requestObservationCoverage, "partial");
});

test("partial and observation-failed stages reduce report coverage", () => {
  for (const coverage of [
    { status: "partial", reason: "instrumentation_incomplete" },
    { status: "observation_failed", reason: "observer_failure" },
  ]) {
    const stages = stagesFor([request(1, "getAccountInfo")]);
    stages[0] = stage("mint_acquisition", {
      outcome: "completed", reasonCode: null, acquisitionDisposition: "complete", requestObservationCoverage: coverage,
    });
    assert.equal(run([request(1, "getAccountInfo")], stages).requestObservationCoverage, "partial");
  }
});

test("skipped and not-requested paths do not reduce coverage for observed requests", () => {
  const result = run([request(1, "getAccountInfo")]);
  assert.equal(result.requestObservationCoverage, "complete");
  assert.equal(result.stageObservations.find((entry) => entry.stage === "transaction_enrichment").outcome, "not_requested");
});

test("request coverage cannot be complete solely because the request list is empty", () => {
  assert.notEqual(run([], stagesFor([])).requestObservationCoverage, "complete");
  assert.equal(run([], stagesFor([])).requestObservationCoverage, "none");
});

test("provider usage and monetary cost remain explicitly unknown", () => {
  const result = run([request(1, "getAccountInfo")]);
  assert.deepEqual(result.providerUsage, { status: "unknown", reason: "provider_usage_not_observed" });
  assert.deepEqual(result.monetaryCost, { status: "unknown", reason: "monetary_cost_not_verified" });
});

test("request and stage outputs are defensive copies and aggregation is repeatable", () => {
  const requests = [request(1, "getAccountInfo")];
  const stages = stagesFor(requests);
  const input = { requestObservations: requests, stageObservations: stages, reportElapsedMs: 123 };
  const first = aggregateSolanaReportOperationalTelemetry(input);
  const second = aggregateSolanaReportOperationalTelemetry(input);
  assert.deepEqual(first, second);
  first.requestObservations[0].providerUsage.reason = "provider_usage_not_observed";
  first.stageObservations[0].requestObservationCoverage.status = "partial";
  assert.equal(requests[0].providerUsage.reason, "provider_usage_not_observed");
  assert.equal(stages[0].requestObservationCoverage.status, "complete");
});

test("invalid report elapsed duration is rejected without reading clock state", () => {
  for (const value of [-0.1, Infinity, NaN, "5"]) {
    expectReason("invalid_report_duration", () => run([], stagesFor([]), value));
  }
});

test("serialized sidecar contains only bounded operational fields, no arbitrary data", () => {
  const result = run([request(1, "getAccountInfo")]);
  const json = JSON.stringify(result);
  for (const forbidden of ["address", "signature", "secret", "https://", "requestBody", "errorMessage"]) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.equal(json.includes("instrumented_fetch_invocation"), true);
});

test("invalid coverage variants are rejected with sanitized deterministic errors", () => {
  const stages = stagesFor([]);
  stages[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "provider_preflight_failure", acquisitionDisposition: "unavailable",
    requestObservationCoverage: { status: "partial", reason: "provider_preflight_failure" },
  });
  assert.throws(() => run([], stages), (error) => {
    assert.equal(error.reason, "invalid_coverage_combination");
    assert.equal(error.message.includes("provider_preflight_failure"), false);
    return true;
  });
});

test("request events reject unexpected fields instead of copying arbitrary text", () => {
  const item = { ...request(1, "getAccountInfo"), arbitraryErrorText: "SENTINEL_SECRET" };
  assert.throws(() => run([item]), (error) => {
    assert.equal(error.reason, "invalid_request_observation");
    assert.equal(error.message.includes("SENTINEL_SECRET"), false);
    return true;
  });
});

test("request events contradict skipped, not-requested, not-attempted, and preflight-failed acquisition stages", () => {
  const mintRequest = request(1, "getAccountInfo");

  const skipped = stagesFor([]);
  assert.throws(() => run([mintRequest], skipped), (error) => error.reason === "invalid_coverage_combination");

  const notRequested = stagesFor([request(1, "getTransfersByAddress")]);
  notRequested[7] = stage("historical_page_acquisition", {
    outcome: "not_requested", reasonCode: "history_not_requested", acquisitionDisposition: "not_requested",
    requestObservationCoverage: { status: "not_attempted", reason: "prerequisite_not_met" },
  });
  assert.throws(() => run([request(1, "getTransfersByAddress")], notRequested), (error) => error.reason === "invalid_coverage_combination");

  const notAttempted = stagesFor([]);
  notAttempted[0] = stage("mint_acquisition", {
    outcome: "skipped", reasonCode: "prerequisite_not_met", acquisitionDisposition: "not_applicable",
    requestObservationCoverage: { status: "not_attempted", reason: "prerequisite_not_met" },
  });
  assert.throws(() => run([mintRequest], notAttempted), (error) => error.reason === "invalid_coverage_combination");

  const preflightFailed = stagesFor([]);
  preflightFailed[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "provider_preflight_failure", acquisitionDisposition: "unavailable",
    requestObservationCoverage: { status: "preflight_failed", reason: "provider_preflight_failure" },
  });
  assert.throws(() => run([mintRequest], preflightFailed), (error) => error.reason === "invalid_coverage_combination");
});

test("request events require their corresponding acquisition stage", () => {
  const stages = stagesFor([request(1, "getAccountInfo")]).filter((entry) => entry.stage !== "mint_acquisition");
  assert.throws(() => run([request(1, "getAccountInfo")], stages), (error) => error.reason === "invalid_coverage_combination");
});

test("completed acquisition claiming complete observation coverage requires a request event", () => {
  const stages = stagesFor([]);
  stages[0] = stage("mint_acquisition", {
    outcome: "completed", reasonCode: null, acquisitionDisposition: "complete",
    requestObservationCoverage: { status: "complete" },
  });
  assert.throws(() => run([], stages), (error) => error.reason === "invalid_coverage_combination");
});

test("failed acquisition with fully observed request remains valid", () => {
  const requests = [request(1, "getAccountInfo", "http_error")];
  const stages = stagesFor(requests);
  stages[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "provider_failure", acquisitionDisposition: "unavailable",
    requestObservationCoverage: { status: "complete" },
  });
  const result = run(requests, stages);
  assert.equal(result.requestObservationCoverage, "complete");
  assert.equal(result.counts.failedOperationCount, 1);
});

test("partial acquisition disposition is compatible with complete request instrumentation", () => {
  const requests = [request(1, "getProgramAccountsV2")];
  const stages = stagesFor(requests);
  stages[4] = stage("holder_acquisition", {
    outcome: "completed", reasonCode: null, acquisitionDisposition: "partial",
    requestObservationCoverage: { status: "complete" },
  });
  const result = run(requests, stages);
  assert.equal(result.requestObservationCoverage, "complete");
  assert.equal(result.stageObservations.find((entry) => entry.stage === "holder_acquisition").acquisitionDisposition, "partial");
});

test("preflight failure with zero requests remains valid and skipped acquisition remains explicit", () => {
  const stages = stagesFor([]);
  stages[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "provider_preflight_failure", acquisitionDisposition: "unavailable",
    requestObservationCoverage: { status: "preflight_failed", reason: "provider_preflight_failure" },
  });
  const result = run([], stages);
  assert.equal(result.requestObservationCoverage, "none");
  assert.equal(result.counts.attemptedRequestCount, 0);
});

test("dependency-only and incomplete instrumentation do not fabricate requests or claim no network activity", () => {
  const dependencyStages = stagesFor([]);
  dependencyStages[0] = stage("mint_acquisition", {
    outcome: "completed", reasonCode: null, acquisitionDisposition: "complete",
    requestObservationCoverage: { status: "dependency_only", reason: "dependency_not_instrumented" },
  });
  const dependencyResult = run([], dependencyStages);
  assert.equal(dependencyResult.counts.attemptedRequestCount, 0);
  assert.equal(dependencyResult.requestObservationCoverage, "partial");

  const partialStages = stagesFor([]);
  partialStages[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "observer_failure", acquisitionDisposition: "unavailable",
    requestObservationCoverage: { status: "observation_failed", reason: "observer_failure" },
  });
  const partialResult = run([], partialStages);
  assert.equal(partialResult.counts.attemptedRequestCount, 0);
  assert.equal(partialResult.requestObservationCoverage, "partial");
});

test("cancellation observations are counted separately from failures and timeouts", () => {
  const requests = [request(1, "getAccountInfo", "request_cancelled", false)];
  const stages = stagesFor(requests);
  stages[0] = stage("mint_acquisition", {
    outcome: "failed", reasonCode: "caller_cancelled", acquisitionDisposition: "partial",
    requestObservationCoverage: { status: "complete" },
  });
  const result = run(requests, stages);
  assert.deepEqual({
    attempted: result.counts.attemptedRequestCount,
    responses: result.counts.responseReceivedCount,
    accepted: result.counts.acceptedOperationCount,
    failed: result.counts.failedOperationCount,
    timeouts: result.counts.timeoutCount,
    cancelled: result.counts.cancelledOperationCount,
    sectionCancelled: result.counts.bySection.mint.cancelledOperationCount,
  }, { attempted: 1, responses: 0, accepted: 0, failed: 0, timeouts: 0, cancelled: 1, sectionCancelled: 1 });
});
