const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getSolanaTokenAccountPages } = require("../dist/providers/solana/heliusTokenAccounts.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const MINT = "11111111111111111111111111111111";
const PUBKEY = "11111111111111111111111111111111";

function providerAccount(programId, address = PUBKEY) {
  const data = Buffer.alloc(165);
  data[108] = 1;
  return { pubkey: address, account: { owner: programId, data: [data.toString("base64"), "base64"], space: 165 } };
}

function response(slot, accounts, paginationKey) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: "token-accounts",
    result: { context: { slot }, value: { accounts, paginationKey } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function withKey(callback) {
  const previous = process.env.HELIUS_API_KEY;
  process.env.HELIUS_API_KEY = "test-key-never-printed";
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = previous;
  }
}

test("paginates through short pages until explicit null cursor and preserves context slots", async () => {
  await withKey(async () => {
    const requests = [];
    const pages = [
      response(100, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], "2"),
      response(101, [], null),
    ];
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return pages.shift();
    });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((page) => page.contextSlot), [100, 101]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "getProgramAccountsV2");
    assert.deepEqual(requests[0].params[1].filters, [
      { dataSize: 165 }, { memcmp: { offset: 0, bytes: MINT, encoding: "base58" } },
    ]);
    assert.equal(requests[1].params[1].paginationKey, "2");
  });
});

test("Token-2022 enumeration filters by mint without assuming fixed account size", async () => {
  await withKey(async () => {
    let request;
    await getSolanaTokenAccountPages(MINT, "token-2022", async (_url, init) => {
      request = JSON.parse(init.body);
      return response(100, [], null);
    });
    assert.equal(request.params[0], SOLANA_TOKEN_PROGRAM_IDS["token-2022"]);
    assert.deepEqual(request.params[1].filters, [{ memcmp: { offset: 0, bytes: MINT, encoding: "base58" } }]);
    assert.equal(request.params[1].withContext, true);
    assert.equal(request.params[1].commitment, "finalized");
  });
});

test("rejects duplicate account addresses across provider pages", async () => {
  await withKey(async () => {
    const pages = [
      response(100, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], "2"),
      response(101, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], null),
    ];
    await assert.rejects(
      getSolanaTokenAccountPages(MINT, "spl-token", async () => pages.shift()),
      /repeated token-account address/,
    );
  });
});

test("rejects repeated cursors rather than looping", async () => {
  await withKey(async () => {
    let call = 0;
    await assert.rejects(getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      call += 1;
      return response(100 + call, [], "2");
    }), /repeated a pagination cursor/);
  });
});

test("treats HTTP and JSON-RPC provider errors as failures", async () => {
  await withKey(async () => {
    await assert.rejects(getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response("", { status: 503 })), /HTTP request failed/);
    await assert.rejects(getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: "token-accounts", error: { code: -32000, message: "provider unavailable" },
    }), { status: 200 })), /JSON-RPC error/);
  });
});

test("rejects malformed JSON, malformed page envelopes, and malformed cursors", async () => {
  await withKey(async () => {
    await assert.rejects(
      getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response("{", { status: 200 })),
      /malformed JSON/,
    );
    await assert.rejects(
      getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
        jsonrpc: "2.0", id: "token-accounts", result: { context: { slot: 100 } },
      }), { status: 200 })),
      /malformed page envelope/,
    );
    await assert.rejects(
      getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
        jsonrpc: "2.0", id: "token-accounts",
        result: { context: { slot: 100 }, value: { accounts: [], paginationKey: 123 } },
      }), { status: 200 })),
      /malformed pagination cursor/,
    );
  });
});

test("rejects pagination cursors that are empty or contain non-Base58 characters", async () => {
  await withKey(async () => {
    for (const cursor of ["bad-cursor", "0bad", "", "has whitespace"]) {
      await assert.rejects(
        getSolanaTokenAccountPages(MINT, "spl-token", async () => response(100, [], cursor)),
        /malformed pagination cursor/,
        `expected cursor ${JSON.stringify(cursor)} to be rejected`,
      );
    }
  });
});

test("converts thrown fetch/network failures into explicit provider errors", async () => {
  await withKey(async () => {
    await assert.rejects(
      getSolanaTokenAccountPages(MINT, "spl-token", async () => { throw new Error("private transport detail"); }),
      /token-account request failed/,
    );
  });
});

test("fails clearly if the Helius key is not configured", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try {
    await assert.rejects(getSolanaTokenAccountPages(MINT, "spl-token", async () => { throw new Error("must not fetch"); }), /HELIUS_API_KEY is not configured/);
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
});
