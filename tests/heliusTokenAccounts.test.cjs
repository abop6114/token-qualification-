const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getSolanaTokenAccountPages } = require("../dist/providers/solana/heliusTokenAccounts.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");

const MINT = "11111111111111111111111111111111";
const PUBKEY = "11111111111111111111111111111111";
const BASE58_CURSOR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "complete");
    assert.equal(result.stopReason, "provider_terminated");
    assert.equal(result.pages.length, 2);
    assert.deepEqual(result.pages.map((page) => page.contextSlot), [100, 101]);
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
    const result = await getSolanaTokenAccountPages(MINT, "token-2022", async (_url, init) => {
      request = JSON.parse(init.body);
      return response(100, [], null);
    });
    assert.equal(result.completeness, "complete");
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
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => pages.shift());
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "malformed_response");
    assert.equal(result.pages.length, 1);
  });
});

test("rejects repeated cursors rather than looping", async () => {
  await withKey(async () => {
    let call = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      call += 1;
      return response(100 + call, [], "2");
    });
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "malformed_response");
    assert.equal(result.pages.length, 1);
    assert.equal(call, 2);
  });
});

test("treats HTTP and JSON-RPC provider errors as failures", async () => {
  await withKey(async () => {
    const http = await getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response("", { status: 503 }));
    assert.equal(http.status, "unavailable");
    assert.equal(http.reason, "provider_error");
    const rpc = await getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: "token-accounts", error: { code: -32000, message: "provider unavailable" },
    }), { status: 200 }));
    assert.equal(rpc.status, "unavailable");
    assert.equal(rpc.reason, "provider_error");
  });
});

test("rejects malformed JSON, malformed page envelopes, and malformed cursors", async () => {
  await withKey(async () => {
    const malformedJson = await getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response("{", { status: 200 }));
    assert.equal(malformedJson.status, "unavailable");
    assert.equal(malformedJson.reason, "malformed_response");
    const malformedEnvelope = await getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
        jsonrpc: "2.0", id: "token-accounts", result: { context: { slot: 100 } },
      }), { status: 200 }));
    assert.equal(malformedEnvelope.status, "unavailable");
    assert.equal(malformedEnvelope.reason, "malformed_response");
    const malformedCursor = await getSolanaTokenAccountPages(MINT, "spl-token", async () => new Response(JSON.stringify({
        jsonrpc: "2.0", id: "token-accounts",
        result: { context: { slot: 100 }, value: { accounts: [], paginationKey: 123 } },
      }), { status: 200 }));
    assert.equal(malformedCursor.status, "unavailable");
    assert.equal(malformedCursor.reason, "malformed_response");
  });
});

test("rejects pagination cursors that are empty or contain non-Base58 characters", async () => {
  await withKey(async () => {
    for (const cursor of ["bad-cursor", "0bad", "", "has whitespace"]) {
      const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => response(100, [], cursor));
      assert.equal(result.status, "unavailable", `expected cursor ${JSON.stringify(cursor)} to be rejected`);
      assert.equal(result.reason, "malformed_response");
    }
  });
});

test("converts thrown fetch/network failures into explicit provider errors", async () => {
  await withKey(async () => {
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => { throw new Error("private transport detail"); });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "provider_error");
    assert.equal(JSON.stringify(result).includes("private transport detail"), false);
  });
});

test("fails clearly if the Helius key is not configured", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  try {
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => { throw new Error("must not fetch"); });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "configuration_error");
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
});

test("accepts explicit termination on page 20 and never requests page 21", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      calls += 1;
      return response(100 + calls, [], calls === 20 ? null : BASE58_CURSOR_ALPHABET[calls - 1]);
    });
    assert.equal(calls, 20);
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "complete");
    assert.equal(result.stopReason, "provider_terminated");
    assert.equal(result.pages.length, 20);
  });
});

test("page 20 continuation produces page_cap partial evidence without request 21", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      calls += 1;
      return response(100 + calls, [], BASE58_CURSOR_ALPHABET[calls - 1]);
    });
    assert.equal(calls, 20);
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "page_cap");
    assert.equal(result.pages.length, 20);
    assert.equal(result.pages[19].paginationKey, BASE58_CURSOR_ALPHABET[19]);
  });
});

test("empty nonterminal pages continue and an empty terminal page is complete", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      calls += 1;
      return response(200 + calls, [], calls === 1 ? "2" : null);
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "complete");
    assert.deepEqual(result.pages.map((page) => page.accounts.length), [0, 0]);
  });
});

test("provider failure after accepted pages preserves only the accepted prefix", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async () => {
      calls += 1;
      return calls === 1
        ? response(100, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], "2")
        : new Response("", { status: 503 });
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "provider_error");
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].accounts.length, 1);
  });
});

test("timeout before a page is accepted is unavailable and sanitized", async () => {
  await withKey(async () => {
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("secret transport text")), { once: true });
    }), 10);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "request_timeout");
    assert.equal(result.pages.length, 0);
    assert.equal(JSON.stringify(result).includes("secret transport text"), false);
  });
});

test("timeout after accepted pages preserves the prefix and is sanitized", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await getSolanaTokenAccountPages(MINT, "spl-token", async (_url, init) => {
      calls += 1;
      if (calls === 1) return response(100, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], "2");
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("secret transport text")), { once: true }));
    }, 10);
    assert.equal(calls, 2);
    assert.equal(result.status, "available");
    assert.equal(result.completeness, "partial");
    assert.equal(result.stopReason, "request_timeout");
    assert.equal(result.pages.length, 1);
    assert.equal(JSON.stringify(result).includes("secret transport text"), false);
  });
});

test("rejects an oversized provider page and duplicate addresses within a page transactionally", async () => {
  await withKey(async () => {
    const oversized = await getSolanaTokenAccountPages(MINT, "spl-token", async () =>
      response(100, Array.from({ length: 5001 }, () => providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])), null));
    assert.equal(oversized.status, "unavailable");
    assert.equal(oversized.reason, "malformed_response");

    const duplicate = await getSolanaTokenAccountPages(MINT, "spl-token", async () =>
      response(100, [providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"]), providerAccount(SOLANA_TOKEN_PROGRAM_IDS["spl-token"])], null));
    assert.equal(duplicate.status, "unavailable");
    assert.equal(duplicate.reason, "malformed_response");
    assert.equal(duplicate.pages.length, 0);
  });
});
