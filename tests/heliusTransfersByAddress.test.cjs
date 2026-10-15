const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { getHeliusHistoricalTransferPage } = require("../dist/providers/solana/heliusHistoricalTransferAdapter.js");
const { getHeliusTransferPage } = require("../dist/providers/solana/heliusTransfersByAddress.js");
const { SolanaProviderRequestBudgetError } = require("../dist/types/solanaProviderRequestBudget.js");

const MINT = "5CuomWu7HfqcR9z2NZ1QN7HJmRGwyp4JrFQ6SWmntaJP";
const OWNER = "11111111111111111111111111111111";
const INPUT = {
  mintAddress: MINT,
  ownerAuthority: OWNER,
  fromUnixSeconds: 1_700_000_000,
  toUnixSecondsExclusive: 1_700_086_400,
  limit: 10,
  paginationToken: null,
};

async function withKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "synthetic-b1-test-key";
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
}

test("historical transfer dispatch denial is preserved, observed zero times, and disposes its timeout", async () => {
  await withKey(async () => {
    const denial = new SolanaProviderRequestBudgetError("insufficient_allowance");
    const events = [];
    let calls = 0;
    let authorizations = 0;
    let clearedTimers = 0;
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = (timer) => { clearedTimers += 1; return originalClearTimeout(timer); };
    try {
      const context = { allocateRequestSequence: () => 1, observeRequest: (event) => { events.push(event); }, onObservationLimitation() {} };
      await assert.rejects(getHeliusHistoricalTransferPage(INPUT, 50, async () => {
        calls += 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: null } }));
      }, context, undefined, { mode: "protected", authorizeFetchInvocation() { authorizations += 1; throw denial; } }), (error) => error === denial);
    } finally {
      global.clearTimeout = originalClearTimeout;
    }
    await delay(60);
    assert.equal(authorizations, 1);
    assert.equal(calls, 0);
    assert.deepEqual(events, []);
    assert.equal(clearedTimers, 1);
  });
});

test("low-level getTransfersByAddress adapter denies before its fetch thunk", async () => {
  await withKey(async () => {
    const denial = new SolanaProviderRequestBudgetError("lease_exhausted");
    let calls = 0;
    let authorizations = 0;
    const events = [];
    const context = { allocateRequestSequence: () => 1, observeRequest: (event) => { events.push(event); }, onObservationLimitation() {} };
    await assert.rejects(getHeliusTransferPage(INPUT, async () => {
      calls += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: null } }));
    }, context, undefined, undefined, () => false, {
      mode: "protected",
      authorizeFetchInvocation() { authorizations += 1; throw denial; },
    }), (error) => error === denial);
    assert.equal(authorizations, 1);
    assert.equal(calls, 0);
    assert.deepEqual(events, []);
  });
});

test("authorized historical transfer page invokes the provider once and preserves the successful empty result", async () => {
  await withKey(async () => {
    let calls = 0;
    let authorizations = 0;
    const result = await getHeliusHistoricalTransferPage(INPUT, 500, async (_url, init) => {
      calls += 1;
      assert.equal(init.signal.aborted, false);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: null } }));
    }, undefined, undefined, { mode: "protected", authorizeFetchInvocation() { authorizations += 1; } });
    assert.deepEqual(result, { observations: [], paginationToken: null });
    assert.equal(calls, 1);
    assert.equal(authorizations, 1);
  });
});

test("historical adapter authorizes each continuation page exactly once", async () => {
  await withKey(async () => {
    const providerPages = ["2", null];
    let calls = 0;
    let authorizations = 0;
    const capability = { mode: "protected", authorizeFetchInvocation() { authorizations += 1; } };
    const expectedCursors = [undefined, "2"];
    const fetchPage = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.params[1].paginationToken, expectedCursors[calls - 1]);
      const token = providerPages.shift();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transfer-history-probe", result: { data: [], paginationToken: token } }));
    };
    const first = await getHeliusHistoricalTransferPage(INPUT, 500, fetchPage, undefined, undefined, capability);
    const second = await getHeliusHistoricalTransferPage({ ...INPUT, paginationToken: first.paginationToken }, 500, fetchPage, undefined, undefined, capability);
    assert.equal(first.paginationToken, "2");
    assert.equal(second.paginationToken, null);
    assert.equal(calls, 2);
    assert.equal(authorizations, 2);
  });
});

test("pre-aborted historical adapter does not authorize or fetch", async () => {
  await withKey(async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    let authorizations = 0;
    await assert.rejects(getHeliusHistoricalTransferPage(INPUT, 500, async () => { calls += 1; }, undefined,
      controller.signal, { mode: "protected", authorizeFetchInvocation() { authorizations += 1; } }), /cancel/i);
    assert.equal(calls, 0);
    assert.equal(authorizations, 0);
  });
});
