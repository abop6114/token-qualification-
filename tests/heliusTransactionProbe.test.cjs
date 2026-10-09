const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseHeliusTransactionProbeArguments,
  runHeliusTransactionProbe,
} = require("../dist/dev/heliusTransactionProbe.js");
const { isSolanaTransactionSignatureSyntax } = require("../dist/validation/solanaAddress.js");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let output = "";
  while (value > 0n) {
    output = ALPHABET[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}
const TX_SIGNATURE = base58(Buffer.alloc(64, 7));
const API_KEY = "transaction-probe-secret";

function rpcResponse(result, extra = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-transaction-probe", result, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function legacyTransaction(overrides = {}) {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [TX_SIGNATURE],
      message: {
        accountKeys: ["static-key-a", "static-key-b"],
        instructions: [{ programIdIndex: 1, accounts: [0] }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      preBalances: [10, 20],
      postBalances: [9, 21],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    version: "legacy",
    ...overrides,
  };
}

function mockFetch(response, requests = []) {
  return async (url, init) => {
    requests.push({ url: String(url), request: JSON.parse(init.body) });
    return response;
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

test("accepts one locally validated 64-byte Base58 transaction signature", () => {
  assert.equal(isSolanaTransactionSignatureSyntax(TX_SIGNATURE), true);
  assert.deepEqual(parseHeliusTransactionProbeArguments(["--signature", TX_SIGNATURE]), { signature: TX_SIGNATURE });
  assert.equal(isSolanaTransactionSignatureSyntax("0".repeat(64)), false);
  assert.equal(isSolanaTransactionSignatureSyntax("1".repeat(32)), false);
});

test("rejects missing, duplicate, extra, and malformed signature arguments", () => {
  assert.throws(() => parseHeliusTransactionProbeArguments([]), /exactly one --signature/);
  assert.throws(() => parseHeliusTransactionProbeArguments(["--signature", TX_SIGNATURE, "--signature", TX_SIGNATURE]), /exactly one --signature/);
  assert.throws(() => parseHeliusTransactionProbeArguments(["--signature", TX_SIGNATURE, "extra"]), /exactly one --signature/);
  assert.throws(() => parseHeliusTransactionProbeArguments(["--signature", "not-a-signature"]), /64-byte/);
});

test("requests one legacy transaction with the explicit JSON configuration", async () => {
  await withKey(async () => {
    const requests = [];
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(legacyTransaction()), requests));
    assert.equal(result.status, "returned");
    assert.equal(result.request.requestCount, 1);
    assert.equal(result.transaction.signatures.count, 1);
    assert.equal(result.transaction.signatures.requestedSignatureMatchesFirstPosition, true);
    assert.equal(result.transaction.version.value, "legacy");
    assert.equal(result.transaction.meta.state, "present");
    assert.equal(result.transaction.meta.errorState, "null");
    assert.equal(result.transaction.accounts.staticAccountKeyCount, 2);
    assert.equal(result.transaction.accounts.totalResolvableAccountCount, 2);
    assert.equal(result.transaction.instructions.indexResolution, "resolved");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.method, "getTransaction");
    assert.deepEqual(requests[0].request.params, [TX_SIGNATURE, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    assert.equal(result.request.commitment, "finalized");
    assert.equal(result.request.maxSupportedTransactionVersion, 0);
    assert.match(requests[0].url, /^https:\/\/mainnet\.helius-rpc\.com\//);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
    assert.equal(JSON.stringify(result).includes("api-key="), false);
  });
});

test("resolves versioned instruction indices using static and loaded addresses", async () => {
  await withKey(async () => {
    const versioned = legacyTransaction({
      version: 0,
      transaction: {
        signatures: [TX_SIGNATURE],
        message: {
          accountKeys: ["static-a", "static-b"],
          addressTableLookups: [{ accountKey: "lookup" }],
          instructions: [{ programIdIndex: 2, accounts: [0, 3] }],
        },
      },
      meta: {
        err: null,
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [2] }] }],
        loadedAddresses: { writable: ["loaded-writable"], readonly: ["loaded-readonly"] },
      },
    });
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(versioned)));
    assert.equal(result.transaction.accounts.loadedAddressesState, "present");
    assert.equal(result.transaction.accounts.loadedWritableAddressCount, 1);
    assert.equal(result.transaction.accounts.loadedReadonlyAddressCount, 1);
    assert.equal(result.transaction.accounts.totalResolvableAccountCount, 4);
    assert.deepEqual(result.transaction.instructions.observedProgramIdIndexValues, [2, 3]);
    assert.deepEqual(result.transaction.instructions.observedAccountIndexValues, [0, 3, 2]);
    assert.equal(result.transaction.instructions.outerInstructionCount, 1);
    assert.equal(result.transaction.instructions.innerInstructionGroupCount, 1);
    assert.equal(result.transaction.instructions.innerInstructionCount, 1);
    assert.equal(result.transaction.instructions.indexResolution, "resolved");
  });
});

test("reports out-of-range instruction indices instead of silently dropping them", async () => {
  await withKey(async () => {
    const transaction = legacyTransaction({
      transaction: { signatures: [TX_SIGNATURE], message: { accountKeys: ["only-key"], instructions: [{ programIdIndex: 2, accounts: [0] }] } },
    });
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(transaction)));
    assert.deepEqual(result.transaction.instructions.observedProgramIdIndexValues, [2]);
    assert.equal(result.transaction.instructions.indexResolution, "unresolved");
  });
});

test("does not treat static keys as complete when a versioned transaction uses lookup tables without loaded addresses", async () => {
  await withKey(async () => {
    const transaction = legacyTransaction({
      version: 0,
      transaction: {
        signatures: [TX_SIGNATURE],
        message: {
          accountKeys: ["static-only"],
          addressTableLookups: [{ accountKey: "lookup" }],
          instructions: [{ programIdIndex: 1, accounts: [0] }],
        },
      },
      meta: { err: null, innerInstructions: [] },
    });
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(transaction)));
    assert.equal(result.transaction.accounts.loadedAddressesState, "omitted");
    assert.equal(result.transaction.accounts.totalResolvableAccountCount, null);
    assert.equal(result.transaction.instructions.indexResolution, "not_checkable");
  });
});

test("distinguishes a successful null result from errors", async () => {
  await withKey(async () => {
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(null)));
    assert.equal(result.status, "provider_result_null");
    assert.equal(result.transaction, null);
    assert.equal(result.error, null);
  });
});

test("sanitizes JSON-RPC errors without retaining provider error text", async () => {
  await withKey(async () => {
    const response = rpcResponse(undefined, { error: { code: -32000, message: `bad https://host/?api-key=${API_KEY}` } });
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(response));
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "rpc");
    assert.equal(result.error.rpcCode, -32000);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
    assert.equal(JSON.stringify(result).includes("https://"), false);
    assert.equal(JSON.stringify(result).includes("bad "), false);
  });
});

test("reports a requested-signature mismatch as an error", async () => {
  await withKey(async () => {
    const otherSignature = base58(Buffer.alloc(64, 8));
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(legacyTransaction({
      transaction: { signatures: [otherSignature], message: { accountKeys: [], instructions: [] } },
    }))));
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "signature_mismatch");
    assert.equal(result.transaction.signatures.requestedSignatureMatchesFirstPosition, false);
  });
});

test("rejects a returned transaction without a usable signatures array", async () => {
  await withKey(async () => {
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(legacyTransaction({
      transaction: { message: { accountKeys: [], instructions: [] } },
    }))));
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "malformed_response");
    assert.equal(result.transaction.signatures.count, null);
    assert.equal(result.transaction.signatures.requestedSignatureMatchesFirstPosition, null);
  });
});

test("preserves null metadata and block-time availability distinctly", async () => {
  await withKey(async () => {
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(legacyTransaction({
      blockTime: null,
      meta: null,
    }))));
    assert.deepEqual(result.transaction.blockTime, { status: "unavailable", reason: "null" });
    assert.equal(result.transaction.meta.state, "null");
    assert.equal(result.transaction.meta.errorState, "not_applicable");
    assert.equal(result.transaction.tokenBalances.pre.state, "not_observable");
  });
});

test("summarizes token balance shapes and only marks integer strings as raw candidates", async () => {
  await withKey(async () => {
    const balance = (amount, extra = {}) => ({ accountIndex: 1, mint: "mint-id", owner: "owner-id", uiTokenAmount: {
      amount, decimals: 6, uiAmount: 1.25, uiAmountString: "1.25", ...extra,
    } });
    const transaction = legacyTransaction({ meta: {
      err: null,
      preBalances: [10, 20],
      postBalances: [9, 21],
      preTokenBalances: [balance("1250000"), balance(1250000), balance("1.25", { uiAmount: 1.25 }), balance(undefined)],
      postTokenBalances: [balance("0")],
    } });
    delete transaction.meta.preTokenBalances[3].uiTokenAmount.amount;
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(transaction)));
    const pre = result.transaction.tokenBalances.pre;
    assert.equal(pre.entryCount, 4);
    assert.equal(pre.exactRawAmountCandidateCount, 1);
    assert.deepEqual(pre.amountJsonTypes, [
      { type: "number", count: 1 }, { type: "omitted", count: 1 },
      { type: "string", count: 2 },
    ]);
    assert.equal(result.transaction.tokenBalances.post.exactRawAmountCandidateCount, 1);
    assert.deepEqual(pre.accountIndexValues, [1, 1, 1, 1]);
    assert.deepEqual(pre.mintJsonTypes, [{ type: "string", count: 4 }]);
    assert.deepEqual(pre.ownerJsonTypes, [{ type: "string", count: 4 }]);
    assert.deepEqual(pre.uiAmountJsonTypes, [{ type: "number", count: 4 }]);
    assert.deepEqual(result.transaction.solBalances.pre.elementJsonTypes, [{ type: "number", count: 2 }]);
  });
});

test("distinguishes omitted and null token balance fields", async () => {
  await withKey(async () => {
    const omitted = legacyTransaction({ meta: { err: null } });
    const omittedResult = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(omitted)));
    assert.equal(omittedResult.transaction.tokenBalances.pre.state, "omitted");
    assert.equal(omittedResult.transaction.tokenBalances.pre.entryCount, null);
    assert.equal(omittedResult.transaction.solBalances.post.state, "omitted");

    const nullFields = legacyTransaction({ meta: { err: null, preTokenBalances: null, postTokenBalances: null, preBalances: null, postBalances: null } });
    const nullResult = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, mockFetch(rpcResponse(nullFields)));
    assert.equal(nullResult.transaction.tokenBalances.pre.state, "null");
    assert.equal(nullResult.transaction.tokenBalances.post.state, "null");
    assert.equal(nullResult.transaction.solBalances.pre.state, "null");
  });
});

test("keeps provider errors bounded and does not retry", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, async () => {
      calls += 1;
      return new Response("not-json", { status: 200 });
    });
    assert.equal(calls, 1);
    assert.equal(result.request.requestCount, 1);
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "malformed_response");
  });
});

test("aborts a stalled request, reports a sanitized timeout, and does not retry", async () => {
  await withKey(async () => {
    let calls = 0;
    let signal;
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, async (_url, init) => {
      calls += 1;
      signal = init.signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`stalled with ${API_KEY} at https://host/?api-key=${API_KEY}`)), { once: true });
      });
    }, 5);
    assert.equal(calls, 1);
    assert.equal(result.request.requestCount, 1);
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "request_timeout");
    assert.equal(result.error.message, "Helius transaction request timed out.");
    assert.equal(signal.aborted, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(result), /https:\/\//);
    assert.doesNotMatch(JSON.stringify(result), /api-key=/);
  });
});

test("clears the timeout after a successful response", async () => {
  await withKey(async () => {
    let signal;
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, async (_url, init) => {
      signal = init.signal;
      return rpcResponse(null);
    }, 10);
    assert.equal(result.status, "provider_result_null");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(signal.aborted, false);
  });
});

test("sanitizes arbitrary transport exception text", async () => {
  await withKey(async () => {
    let calls = 0;
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, async () => {
      calls += 1;
      throw new Error(`network detail ${API_KEY} https://host/?api-key=${API_KEY}`);
    }, 100);
    assert.equal(calls, 1);
    assert.equal(result.request.requestCount, 1);
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "transport");
    assert.equal(result.error.message, "Helius transaction request failed.");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
    assert.doesNotMatch(JSON.stringify(result), /https:\/\//);
  });
});

test("does not call the provider for invalid typed input", async () => {
  let calls = 0;
  await assert.rejects(runHeliusTransactionProbe({ signature: "bad" }, async () => {
    calls += 1;
    return rpcResponse(null);
  }), /64-byte/);
  assert.equal(calls, 0);
});

test("reports missing Helius configuration without counting a provider request", async () => {
  const previous = process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_KEY;
  let calls = 0;
  try {
    const result = await runHeliusTransactionProbe({ signature: TX_SIGNATURE }, async () => {
      calls += 1;
      return rpcResponse(null);
    });
    assert.equal(result.status, "provider_error");
    assert.equal(result.error.category, "configuration");
    assert.equal(result.request.requestCount, 0);
    assert.equal(calls, 0);
  } finally {
    if (previous !== undefined) process.env.HELIUS_API_KEY = previous;
  }
});
