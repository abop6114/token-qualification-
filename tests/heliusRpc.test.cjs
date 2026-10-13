const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const {
  getSolanaAccount,
  SolanaAccountProviderError,
} = require("../dist/providers/solana/heliusRpc.js");

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
