const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runHeliusTransferHistoryProbe } = require("../dist/dev/heliusTransferHistoryProbe.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "11111111111111111111111111111111";
const OWNER_A = MINT;
const OWNER_B = encodeSolanaPublicKey(Buffer.alloc(32, 1));
const API_KEY = "history-probe-test-secret";

function transfer(overrides = {}) {
  return {
    signature: "sig-1",
    slot: 123,
    blockTime: 1_700_000_000,
    type: "transfer",
    fromUserAccount: OWNER_B,
    toUserAccount: OWNER_A,
    fromTokenAccount: "source-token-account",
    toTokenAccount: "destination-token-account",
    mint: MINT,
    amount: "2500000",
    decimals: 6,
    uiAmount: 2.5,
    ...overrides,
  };
}

function response(data, paginationToken = null, extra = {}) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "tqe-transfer-history-probe",
    result: { data, paginationToken, ...extra },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function input(overrides = {}) {
  return {
    mintAddress: MINT,
    ownerAuthorities: [OWNER_A],
    fromUnixSeconds: 1_700_000_000,
    toUnixSecondsExclusive: 1_700_100_000,
    maxPagesPerOwner: 3,
    maxRecordsPerOwner: 250,
    ...overrides,
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

function queuedFetch(responses, requests = []) {
  return async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const next = responses.shift();
    if (typeof next === "function") return next();
    return next;
  };
}

test("queries one explicit owner and returns provider-shaped transfer evidence", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([response([transfer()])], requests));
    assert.equal(result.provider, "helius");
    assert.equal(result.method, "getTransfersByAddress");
    assert.equal(result.queriedMint, MINT);
    assert.equal(result.runTelemetry.requestedOwnerCount, 1);
    assert.equal(result.owners[0].queriedOwnerAuthority, OWNER_A);
    assert.equal(result.owners[0].terminalStatus, "success_with_records");
    assert.equal(result.owners[0].paginationStatus, "complete");
    assert.equal(result.owners[0].transfers[0].amount.rawAmount, "2500000");
    assert.equal(result.owners[0].transfers[0].amount.exactRawAvailable, true);
    assert.equal(result.owners[0].transfers[0].amount.reportedAmountType, "integer_string");
    assert.equal(requests[0].body.method, "getTransfersByAddress");
    assert.equal(requests[0].body.params[0], OWNER_A);
    assert.equal(requests[0].body.params[1].mint, MINT);
    assert.equal(requests[0].body.params[1].direction, "any");
    assert.deepEqual(requests[0].body.params[1].filters.blockTime, {
      gte: 1_700_000_000,
      lt: 1_700_100_000,
    });
  });
});

test("queries an explicit multiple-owner list sequentially and reconciles run totals", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await runHeliusTransferHistoryProbe(input({ ownerAuthorities: [OWNER_A, OWNER_B] }), queuedFetch([
      response([transfer()]),
      response([transfer({ signature: "sig-2" }), transfer({ signature: "sig-3" })]),
    ], requests));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.body.params[0]), [OWNER_A, OWNER_B]);
    assert.equal(result.runTelemetry.completedOwnerCount, 2);
    assert.equal(result.runTelemetry.failedOwnerCount, 0);
    assert.equal(result.runTelemetry.totalRequestCount, 2);
    assert.equal(result.runTelemetry.totalPagesRequested, 2);
    assert.equal(result.runTelemetry.totalPagesReceived, 2);
    assert.equal(result.runTelemetry.totalRecordsReturned, 3);
    assert.equal(result.runTelemetry.totalRequestCount, result.owners.reduce((sum, owner) => sum + owner.requestCount, 0));
    assert.equal(result.runTelemetry.totalPagesReceived, result.owners.reduce((sum, owner) => sum + owner.pageCount, 0));
    assert.equal(result.runTelemetry.totalRecordsReturned, result.owners.reduce((sum, owner) => sum + owner.recordsReturned, 0));
  });
});

test("successful empty history is distinct from provider failure", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([response([])]));
    assert.equal(result.owners[0].terminalStatus, "success_empty");
    assert.equal(result.owners[0].paginationStatus, "complete");
    assert.equal(result.owners[0].recordsReturned, 0);
    assert.equal(result.runTelemetry.failedOwnerCount, 0);
  });
});

test("one owner provider failure is retained while later explicit owners are queried", async () => {
  await withKey(async () => {
    const requests = [];
    const rpcFailure = new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "tqe-transfer-history-probe",
      error: { code: -32000, message: `failure ${API_KEY} https://mainnet.helius-rpc.com/?api-key=${API_KEY}` },
    }), { status: 200 });
    const result = await runHeliusTransferHistoryProbe(input({ ownerAuthorities: [OWNER_A, OWNER_B] }), queuedFetch([
      rpcFailure,
      response([transfer({ signature: "sig-2" })]),
    ], requests));
    assert.equal(requests.length, 2);
    assert.equal(result.owners[0].terminalStatus, "provider_error");
    assert.equal(result.owners[0].providerError.category, "rpc");
    assert.equal(result.owners[0].paginationStatus, "not_applicable");
    assert.equal(result.owners[1].terminalStatus, "success_with_records");
    assert.equal(result.runTelemetry.failedOwnerCount, 1);
    assert.equal(result.runTelemetry.completedOwnerCount, 1);
  });
});

test("paginates through short pages until natural provider termination", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([
      response([transfer()], "cursor-one"),
      response([], null),
    ], requests));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.params[1].paginationToken, "cursor-one");
    assert.equal(result.owners[0].requestCount, 2);
    assert.equal(result.owners[0].pageCount, 2);
    assert.equal(result.owners[0].recordsReturned, 1);
    assert.equal(result.owners[0].paginationStatus, "complete");
    assert.equal(result.owners[0].continuationCursorPresent, false);
  });
});

test("rejects an omitted paginationToken instead of reporting complete history", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([
      response([transfer()], null, { paginationToken: undefined }),
    ]));
    assert.equal(result.owners[0].terminalStatus, "provider_error");
    assert.equal(result.owners[0].paginationStatus, "not_applicable");
    assert.equal(result.owners[0].providerError.category, "malformed_response");
    assert.equal(result.owners[0].requestCount, 1);
    assert.equal(result.owners[0].pageCount, 0);
  });
});

test("rejects empty and non-string non-null paginationToken values", async () => {
  await withKey(async () => {
    for (const token of ["", 0, false, {}]) {
      const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([
        response([], token),
      ]));
      assert.equal(result.owners[0].terminalStatus, "provider_error");
      assert.equal(result.owners[0].paginationStatus, "not_applicable");
      assert.equal(result.owners[0].providerError.category, "malformed_response");
    }
  });
});

test("explicit page cap returns successful but truncated history", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input({ maxPagesPerOwner: 1 }), queuedFetch([
      response([transfer()], "next-page"),
    ]));
    assert.equal(result.owners[0].terminalStatus, "success_with_records");
    assert.equal(result.owners[0].paginationStatus, "truncated");
    assert.equal(result.owners[0].continuationCursorPresent, true);
    assert.equal(result.runTelemetry.anyQueryTruncated, true);
  });
});

test("record cap is sent as the page limit and truncation is not reported complete", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await runHeliusTransferHistoryProbe(input({ maxRecordsPerOwner: 2 }), queuedFetch([
      response([transfer(), transfer({ signature: "sig-2" })], "more-records"),
    ], requests));
    assert.equal(requests[0].body.params[1].limit, 2);
    assert.equal(result.owners[0].recordsReturned, 2);
    assert.equal(result.owners[0].paginationStatus, "truncated");
    assert.equal(result.runTelemetry.totalRecordsReturned, 2);
  });
});

test("natural termination at the exact record cap remains complete", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input({ maxRecordsPerOwner: 1 }), queuedFetch([
      response([transfer()], null),
    ]));
    assert.equal(result.owners[0].paginationStatus, "complete");
    assert.equal(result.owners[0].terminalStatus, "success_with_records");
  });
});

test("rejects malformed provider envelopes as per-owner errors", async () => {
  await withKey(async () => {
    const malformed = new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: { data: [] } }), { status: 200 });
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([malformed]));
    assert.equal(result.owners[0].terminalStatus, "provider_error");
    assert.equal(result.owners[0].providerError.category, "malformed_response");
    assert.equal(result.runTelemetry.failedOwnerCount, 1);
  });
});

test("only integer strings are exact raw amounts; numeric and UI-only evidence stays non-raw", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input({ maxRecordsPerOwner: 5 }), queuedFetch([
      response([
        transfer({ amount: "18446744073709551615" }),
        transfer({ signature: "sig-2", amount: 42 }),
        transfer({ signature: "sig-3", amount: 9007199254740992 }),
        transfer({ signature: "sig-4", amount: 2.5 }),
        transfer({ signature: "sig-5", amount: undefined, uiAmount: 2.5 }),
      ]),
    ]));
    const [exact, safeNumber, unsafeNumber, fractionalNumber, uiOnly] = result.owners[0].transfers;
    assert.equal(exact.amount.rawAmount, "18446744073709551615");
    assert.equal(exact.amount.exactRawAvailable, true);
    assert.equal(exact.amount.reportedAmountType, "integer_string");
    assert.equal(safeNumber.amount.rawAmount, null);
    assert.equal(safeNumber.amount.exactRawAvailable, false);
    assert.equal(safeNumber.amount.reportedAmount, "42");
    assert.equal(safeNumber.amount.reportedAmountType, "safe_integer_number");
    assert.equal(unsafeNumber.amount.rawAmount, null);
    assert.equal(unsafeNumber.amount.exactRawAvailable, false);
    assert.equal(unsafeNumber.amount.reportedAmountType, "unsafe_integer_number");
    assert.equal(unsafeNumber.amount.reportedAmount, null);
    assert.equal(fractionalNumber.amount.rawAmount, null);
    assert.equal(fractionalNumber.amount.exactRawAvailable, false);
    assert.equal(fractionalNumber.amount.reportedAmount, "2.5");
    assert.equal(fractionalNumber.amount.reportedAmountType, "non_integer_number");
    assert.equal(uiOnly.amount.rawAmount, null);
    assert.equal(uiOnly.amount.exactRawAvailable, false);
    assert.equal(uiOnly.amount.reportedAmountType, "missing");
    assert.equal(uiOnly.amount.reportedUiAmountType, "number");
    assert.equal(uiOnly.amount.reportedUiAmount, undefined);
  });
});

test("preserves a decimal string amount without fabricating raw units", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([
      response([transfer({ amount: "2.5", uiAmount: "2.5" })]),
    ]));
    assert.deepEqual(result.owners[0].transfers[0].amount, {
      rawAmount: null,
      exactRawAvailable: false,
      reportedAmount: "2.5",
      reportedAmountType: "non_integer_string",
      reportedUiAmount: "2.5",
      reportedUiAmountType: "string",
    });
    assert.equal(result.owners[0].transfers[0].amount.rawAmount, null);
    assert.equal(result.owners[0].transfers[0].amount.exactRawAvailable, false);
  });
});

test("validates duration structure without relying on elapsed-time thresholds", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([response([])]));
    assert.ok(Number.isFinite(result.runTelemetry.totalElapsedMs));
    assert.ok(result.runTelemetry.totalElapsedMs >= 0);
    assert.ok(Number.isFinite(result.owners[0].durationMs));
    assert.ok(result.owners[0].durationMs >= 0);
  });
});

test("unknown credit usage remains explicit and no dollar cost is asserted", async () => {
  await withKey(async () => {
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([response([])]));
    assert.deepEqual(result.runTelemetry.creditUsage, {
      status: "unknown",
      credits: null,
      reason: "provider_usage_not_observed_and_no_verified_rate_card_supplied",
    });
    assert.equal("dollarCost" in result.runTelemetry, false);
  });
});

test("serialized output and errors never expose the API key or authenticated URL", async () => {
  await withKey(async () => {
    const responseWithSecretError = new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "tqe-transfer-history-probe",
      error: { code: -1, message: `${API_KEY} https://mainnet.helius-rpc.com/?api-key=${API_KEY}` },
    }), { status: 200 });
    const result = await runHeliusTransferHistoryProbe(input(), queuedFetch([responseWithSecretError]));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes("api-key="), false);
    assert.equal(serialized.includes("https://mainnet.helius-rpc.com"), false);
  });
});

test("requires explicit owners, time window, and positive caps", async () => {
  await assert.rejects(runHeliusTransferHistoryProbe(input({ ownerAuthorities: [] }), async () => {
    throw new Error("fetch should not run");
  }), /explicit owner authority/);
  await assert.rejects(runHeliusTransferHistoryProbe(input({ maxPagesPerOwner: 0 }), async () => {
    throw new Error("fetch should not run");
  }), /positive safe integer/);
  await assert.rejects(runHeliusTransferHistoryProbe(input({ toUnixSecondsExclusive: 1_700_000_000 }), async () => {
    throw new Error("fetch should not run");
  }), /bounded Unix time window/);
});

test("normal CLI and start script remain isolated from history calls", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const packageJson = require("../package.json");
  assert.equal(packageJson.scripts.start, "node --env-file=.env dist/cli.js");
  assert.equal(packageJson.scripts["probe:helius-transfers"], "node --env-file=.env dist/dev/heliusTransferHistoryProbe.js");
  assert.equal(cli.includes("heliusTransfersByAddress"), false);
  assert.equal(cli.includes("runHeliusTransferHistoryProbe"), false);

  const code = [
    `const mint = ${JSON.stringify(MINT)};`,
    "global.fetch = async (url, init = {}) => {",
    "  if (init.method === 'POST') {",
    "    const request = JSON.parse(init.body);",
    "    if (request.method === 'getAccountInfo') {",
    "      const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;",
    "      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 10 }, value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [data.toString('base64'), 'base64'] } } }), { status: 200 });",
    "    }",
    "    if (request.method === 'getProgramAccountsV2') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'token-accounts', result: { context: { slot: 10 }, value: { accounts: [], paginationKey: null } } }), { status: 200 });",
    "    throw new Error('Unexpected provider method: ' + request.method);",
    "  }",
    "  return new Response('[]', { status: 200 });",
    "};",
    "process.argv = [process.execPath, 'dist/cli.js', mint];",
    "require('./dist/cli.js');",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, HELIUS_API_KEY: API_KEY },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const normalResult = JSON.parse(child.stdout.trim());
  assert.equal(normalResult.status, "mint_found");
  assert.equal(normalResult.holderStructure.tokenAccountCount, 0);
});
