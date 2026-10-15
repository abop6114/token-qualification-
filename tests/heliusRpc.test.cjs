const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const {
  getSolanaAccount,
  SolanaAccountProviderError,
} = require("../dist/providers/solana/heliusRpc.js");
const { SolanaProviderRequestBudgetError } = require("../dist/types/solanaProviderRequestBudget.js");
const { createSolanaProviderRequestBudgetController } = require("../dist/application/solanaProviderRequestBudgetController.js");

const ADDRESS = "11111111111111111111111111111111";
const OWNER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SECRET = "sentinel-api-key-do-not-leak";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function rpcResult(value) {
  return { jsonrpc: "2.0", id: 1, result: { context: { slot: 123 }, value } };
}

function withApiKey(fn) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = SECRET;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  });
}

function assertSanitized(error, category) {
  assert.ok(error instanceof SolanaAccountProviderError);
  assert.equal(error.category, category);
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("api-key="), false);
  assert.equal(serialized.includes("provider-secret-body"), false);
  assert.equal("cause" in error, false);
}

test("Helius account adapter preserves successful and confirmed-missing results", async () => {
  await withApiKey(async () => {
    let calls = 0;
    const account = {
      owner: OWNER,
      data: [Buffer.from("account-bytes").toString("base64"), "base64"],
    };
    const found = await getSolanaAccount(ADDRESS, async (_url, init) => {
      calls += 1;
      assert.equal(init.method, "POST");
      assert.equal(init.signal.aborted, false);
      return response(rpcResult(account));
    }, 500);
    assert.deepEqual(found, {
      requestedAddress: ADDRESS,
      owner: OWNER,
      dataBase64: Buffer.from("account-bytes").toString("base64"),
    });

    const missing = await getSolanaAccount(ADDRESS, async () => {
      calls += 1;
      return response(rpcResult(null));
    }, 500);
    assert.equal(missing, null);
    assert.equal(calls, 2);
  });
});

test("protected mint dispatch denies before fetch and emits no attempted request observation", async () => {
  await withApiKey(async () => {
    let calls = 0;
    let authorizations = 0;
    const events = [];
    const denial = new SolanaProviderRequestBudgetError("insufficient_allowance");
    const capability = { mode: "protected", authorizeFetchInvocation() { authorizations += 1; throw denial; } };
    const context = { allocateRequestSequence: () => 1, observeRequest: (event) => { events.push(event); }, onObservationLimitation() {} };
    await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; return response(rpcResult(null)); }, 500, context, undefined, capability), (error) => error === denial);
    assert.equal(authorizations, 1);
    assert.equal(calls, 0);
    assert.deepEqual(events, []);
  });
});

test("protected mint authorization runs once for a successful fetch and malformed protected capability fails closed", async () => {
  await withApiKey(async () => {
    let authorizations = 0;
    let calls = 0;
    const result = await getSolanaAccount(ADDRESS, async () => { calls += 1; return response(rpcResult(null)); }, 500,
      undefined, undefined, { mode: "protected", authorizeFetchInvocation() { authorizations += 1; } });
    assert.equal(result, null);
    assert.equal(authorizations, 1);
    assert.equal(calls, 1);

    await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; }, 500,
      undefined, undefined, { mode: "protected" }), (error) => {
      assert.ok(error instanceof SolanaProviderRequestBudgetError);
      assert.equal(error.reason, "internal_operational_failure");
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("caller cancellation observable before authorization consumes no unit", async () => {
  const controller = new AbortController();
  controller.abort();
  let authorizations = 0;
  let calls = 0;
  await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; }, 500, undefined, controller.signal,
    { mode: "protected", authorizeFetchInvocation() { authorizations += 1; } }), /cancel/i);
  assert.equal(authorizations, 0);
  assert.equal(calls, 0);
});

test("successful authorization remains consumed when fetch throws synchronously", async () => {
  await withApiKey(async () => {
    const controller = createSolanaProviderRequestBudgetController({ capacity: 1, initiallyEnabled: true });
    const lease = controller.reserve(1);
    await assert.rejects(getSolanaAccount(ADDRESS, async () => { throw new Error("simulated local fetch failure"); }, 500,
      undefined, undefined, { mode: "protected", authorizeFetchInvocation: () => lease.consume() }), (error) => {
      assertSanitized(error, "transport_error");
      return true;
    });
    assert.equal(lease.getStatus().consumed, 1);
    assert.equal(controller.getStatus().available, 0);
  });
});

test("missing configuration and invalid timeout fail before any request", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  let calls = 0;
  try {
    await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; }, 500), (error) => {
      assertSanitized(error, "configuration_error");
      return true;
    });
    process.env.HELIUS_API_KEY = SECRET;
    await assert.rejects(getSolanaAccount(ADDRESS, async () => { calls += 1; }, 0), (error) => {
      assertSanitized(error, "configuration_error");
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
});

test("unexpected internal response-object exceptions are not relabeled as provider failures", async () => {
  await withApiKey(async () => {
    const internalError = new Error("internal response adapter bug");
    const faultyResponse = Object.defineProperty({}, "ok", {
      get() { throw internalError; },
    });
    await assert.rejects(getSolanaAccount(ADDRESS, async () => faultyResponse, 500), (error) => error === internalError);
  });
});

test("Helius HTTP, RPC, transport, and malformed failures are typed and sanitized without retries", async () => {
  await withApiKey(async () => {
    const failures = [
      ["http_error", async () => response({ body: "provider-secret-body" }, 503)],
      ["rpc_error", async () => response({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: SECRET } })],
      ["transport_error", async () => { throw new Error(`transport ${SECRET} https://host/?api-key=${SECRET}`); }],
      ["malformed_response", async () => ({ ok: true, status: 200, json: async () => { throw new Error(`provider-secret-body ${SECRET}`); } })],
      ["malformed_response", async () => response({ jsonrpc: "2.0", id: 2, result: {} })],
    ];
    for (const [category, fetchImpl] of failures) {
      let calls = 0;
      await assert.rejects(getSolanaAccount(ADDRESS, async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      }, 500), (error) => {
        assertSanitized(error, category);
        return true;
      });
      assert.equal(calls, 1);
    }
  });
});

test("Helius timeout aborts the in-flight request, is sanitized, and is not retried", async () => {
  await withApiKey(async () => {
    let calls = 0;
    let signal;
    await assert.rejects(getSolanaAccount(ADDRESS, (_url, init) => {
      calls += 1;
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`aborted ${SECRET}`)), { once: true });
      });
    }, 10), (error) => {
      assertSanitized(error, "request_timeout");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  });
});

test("Helius clears its timeout after successful request completion", async () => {
  await withApiKey(async () => {
    let signal;
    await getSolanaAccount(ADDRESS, (_url, init) => {
      signal = init.signal;
      return Promise.resolve(response(rpcResult(null)));
    }, 20);
    await delay(35);
    assert.equal(signal.aborted, false);
  });
});
