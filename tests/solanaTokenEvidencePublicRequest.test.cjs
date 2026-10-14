const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const {
  parseSolanaTokenEvidencePublicRequest,
  SolanaTokenEvidencePublicRequestError,
} = require("../dist/application/solanaTokenEvidencePublicRequest.js");

const ADDRESS = "11111111111111111111111111111111";

test("valid omitted history maps to the internal not_requested request shape", () => {
  const result = parseSolanaTokenEvidencePublicRequest({ chain: "solana", assetAddress: ADDRESS });
  assert.deepEqual(result, {
    chain: "solana",
    assetAddress: ADDRESS,
    historicalTransactions: { status: "not_requested" },
  });
});

test("valid explicit not_requested history maps to the same internal state", () => {
  assert.deepEqual(parseSolanaTokenEvidencePublicRequest({
    chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "not_requested" },
  }), {
    chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "not_requested" },
  });
});

test("requested public bounds map to the exact inclusive/exclusive internal names", () => {
  assert.deepEqual(parseSolanaTokenEvidencePublicRequest({
    chain: "solana",
    assetAddress: ADDRESS,
    historicalTransactions: {
      status: "requested",
      startTimeUnixSeconds: 100,
      endTimeUnixSecondsExclusive: 200,
    },
  }), {
    chain: "solana",
    assetAddress: ADDRESS,
    historicalTransactions: {
      status: "requested",
      requestedWindow: { fromUnixSecondsInclusive: 100, toUnixSecondsExclusive: 200 },
    },
  });
});

test("parsing is deterministic, returns only allowlisted internal fields, and does not mutate input", () => {
  const input = {
    chain: "solana",
    assetAddress: ADDRESS,
    historicalTransactions: { status: "requested", startTimeUnixSeconds: 1, endTimeUnixSecondsExclusive: 2 },
  };
  const before = structuredClone(input);
  const first = parseSolanaTokenEvidencePublicRequest(input);
  const second = parseSolanaTokenEvidencePublicRequest(input);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ["chain", "assetAddress", "historicalTransactions"]);
  assert.deepEqual(Object.keys(first.historicalTransactions), ["status", "requestedWindow"]);
  assert.deepEqual(input, before);
});

test("accepts syntactically valid Solana addresses without resolving an account or mint", () => {
  const result = parseSolanaTokenEvidencePublicRequest({ chain: "solana", assetAddress: ADDRESS });
  assert.equal(result.assetAddress, ADDRESS);
  assert.equal(result.historicalTransactions.status, "not_requested");
});

test("rejects non-plain, primitive, array, null, and structurally incomplete requests", async (t) => {
  const cases = [
    [null, "invalid_request_shape"],
    [[], "invalid_request_shape"],
    ["request", "invalid_request_shape"],
    [1, "invalid_request_shape"],
    [true, "invalid_request_shape"],
    [{}, "invalid_request_shape"],
    [{ assetAddress: ADDRESS }, "invalid_request_shape"],
    [{ chain: "solana" }, "invalid_request_shape"],
    [new Date(), "invalid_request_shape"],
  ];
  for (const [input, category] of cases) {
    await t.test(JSON.stringify(input), () => assertPublicError(input, category));
  }
});

test("rejects unsupported chain values without inferring chain from address", async (t) => {
  for (const chain of ["ethereum", "Solana", "", null, 1]) {
    await t.test(String(chain), () => assertPublicError({ chain, assetAddress: ADDRESS }, "unsupported_chain"));
  }
});

test("rejects malformed and non-string Solana addresses", async (t) => {
  for (const assetAddress of ["", "not-an-address", "0".repeat(32), null, 12]) {
    await t.test(String(assetAddress), () => assertPublicError({ chain: "solana", assetAddress }, "invalid_asset_address"));
  }
});

test("rejects unexpected top-level and nested properties", async (t) => {
  const cases = [
    [{ chain: "solana", assetAddress: ADDRESS, requestTimeoutMs: 1 }, "invalid_request_shape"],
    [{ chain: "solana", assetAddress: ADDRESS, providerUrl: "secret" }, "invalid_request_shape"],
    [{ chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "not_requested", extra: true } }, "invalid_historical_request"],
    [{ chain: "solana", assetAddress: ADDRESS, historicalTransactions: { status: "requested", startTimeUnixSeconds: 1, endTimeUnixSecondsExclusive: 2, maxPages: 99 } }, "invalid_historical_request"],
  ];
  for (const [input, category] of cases) {
    await t.test(category, () => assertPublicError(input, category));
  }
});

test("rejects malformed historical request discriminants and shapes", async (t) => {
  const cases = [
    [null, "invalid_historical_request"],
    [[], "invalid_historical_request"],
    [{}, "invalid_historical_request"],
    [{ status: "requested" }, "invalid_historical_request"],
    [{ status: "not-requested" }, "invalid_historical_request"],
    [{ status: "not_requested", extra: 1 }, "invalid_historical_request"],
  ];
  for (const [historicalTransactions, category] of cases) {
    await t.test(category, () => assertPublicError({ chain: "solana", assetAddress: ADDRESS, historicalTransactions }, category));
  }
});

test("rejects missing, negative, fractional, unsafe, equal, and reversed window bounds", async (t) => {
  const cases = [
    [{ status: "requested", endTimeUnixSecondsExclusive: 2 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: 1 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: -1, endTimeUnixSecondsExclusive: 2 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: 1.5, endTimeUnixSecondsExclusive: 2 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: 1, endTimeUnixSecondsExclusive: Number.MAX_SAFE_INTEGER + 1 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: 2, endTimeUnixSecondsExclusive: 2 }, "invalid_historical_request"],
    [{ status: "requested", startTimeUnixSeconds: 3, endTimeUnixSecondsExclusive: 2 }, "invalid_historical_request"],
  ];
  for (const [historicalTransactions, category] of cases) {
    await t.test(category, () => assertPublicError({ chain: "solana", assetAddress: ADDRESS, historicalTransactions }, category));
  }
});

test("errors are stable, safe, and do not serialize input, provider data, or HTTP status", () => {
  const secretSentinel = "provider-secret-sentinel";
  let error;
  try {
    parseSolanaTokenEvidencePublicRequest({
      chain: "solana", assetAddress: ADDRESS, secret: secretSentinel,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SolanaTokenEvidencePublicRequestError);
  assert.equal(error.category, "invalid_request_shape");
  assert.equal(error.message, "The public evidence request shape is invalid.");
  assert.equal(Object.hasOwn(error, "statusCode"), false);
  assert.equal(JSON.stringify(error).includes(secretSentinel), false);
  assert.equal(error.message.includes(secretSentinel), false);
  assert.equal(error.message.includes("providerUrl"), false);
});

test("source imports only pure validation and request types, with no report, presentation, telemetry, or provider execution", () => {
  const source = readFileSync("src/application/solanaTokenEvidencePublicRequest.ts", "utf8");
  assert.match(source, /from "\.\.\/validation\/solanaAddress"/);
  assert.match(source, /from "\.\.\/types\/solanaTokenEvidenceReport"/);
  assert.doesNotMatch(source, /providers\/|solanaTokenEvidenceReport\."|solanaTokenEvidencePresentation|OperationalTelemetry|fetch\s*\(/i);
});

function assertPublicError(input, category) {
  assert.throws(() => parseSolanaTokenEvidencePublicRequest(input), (error) => {
    assert.ok(error instanceof SolanaTokenEvidencePublicRequestError);
    assert.equal(error.category, category);
    assert.equal(typeof error.message, "string");
    assert.equal(Object.hasOwn(error, "statusCode"), false);
    return true;
  });
}
