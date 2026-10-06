const assert = require("node:assert/strict");
const { test } = require("node:test");
const { executeEvmTokenEvidence } = require("../dist/execution/evmTokenEvidence.js");
const { EvmRpcProviderError, requestAlchemyRpc } = require("../dist/providers/evm/alchemyRpc.js");
const {
  normalizeEvmAbiString,
  normalizeEvmBlockNumber,
  normalizeEvmContractCode,
  normalizeEvmDecimals,
  normalizeEvmUint256,
} = require("../dist/normalization/evmToken.js");
const { normalizeEvmAddress } = require("../dist/validation/evmAddress.js");

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const API_KEY = "evm-evidence-test-secret";
const FETCHED_AT = "2026-10-06T12:00:00.000Z";
const BLOCK = "0x123456789abcdef123456789abcdef";

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function abiString(value) {
  const data = Buffer.from(value, "utf8");
  const paddedBytes = Math.ceil(data.length / 32) * 32;
  return `0x${word(32)}${word(data.length)}${data.toString("hex").padEnd(paddedBytes * 2, "0")}`;
}

function responseFor(method, params) {
  if (method === "eth_blockNumber") return BLOCK;
  if (method === "eth_getCode") return "0x60016000";
  if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
  if (params[0].data === "0x18160ddd") return `0x${word("123456789012345678901234567890")}`;
  if (params[0].data === "0x313ce567") return `0x${word(18)}`;
  if (params[0].data === "0x06fdde03") return abiString("Token Ω");
  if (params[0].data === "0x95d89b41") return abiString("TQE");
  throw new Error("unexpected selector");
}

function makeRpc(overrides = {}) {
  const requests = [];
  const requestRpc = async (chain, method, params) => {
    requests.push({ chain, method, params });
    if (overrides[method]) return overrides[method](chain, params, requests.length);
    return responseFor(method, params);
  };
  return { requests, requestRpc };
}

async function withApiKey(callback) {
  const previous = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = API_KEY;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = previous;
  }
}

function execute(chain = "base", address = ADDRESS, requestRpc, options = {}) {
  return executeEvmTokenEvidence(chain, address, {
    now: () => new Date(FETCHED_AT),
    ...(requestRpc ? { requestRpc } : {}),
    ...options,
  });
}

test("normalizes lowercase, uppercase, and mixed-case EVM addresses to lowercase", () => {
  assert.equal(normalizeEvmAddress(ADDRESS), ADDRESS);
  assert.equal(normalizeEvmAddress(ADDRESS.toUpperCase().replace("0X", "0x")), ADDRESS);
  assert.equal(normalizeEvmAddress("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"), "0xabcdef1234567890abcdef1234567890abcdef12");
});

test("rejects terminal line terminators and trailing characters in full-string inputs", () => {
  for (const ending of [String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(13, 10)]) {
    assert.equal(normalizeEvmAddress(`${ADDRESS}${ending}`), null);
    assert.equal(normalizeEvmBlockNumber(`0x1${ending}`).status, "malformed");
    assert.equal(normalizeEvmContractCode(`0x6000${ending}`).status, "malformed");
    assert.equal(normalizeEvmAbiString(`${abiString("Token")}${ending}`).status, "malformed");
  }
  assert.equal(normalizeEvmAddress(`${ADDRESS}x`), null);
  assert.equal(normalizeEvmContractCode("0x6000x").status, "malformed");
  const validCode = normalizeEvmContractCode("0x6000");
  assert.equal(Number.isInteger(validCode.byteLength), true);
  assert.equal(validCode.byteLength, 2);
});

test("rejects missing prefix, incorrect length, and non-hex address before RPC acquisition", async () => {
  const { requests, requestRpc } = makeRpc();
  for (const address of [ADDRESS.slice(2), `0x${"1".repeat(39)}`, `0x${"g".repeat(40)}`]) {
    await assert.rejects(execute("base", address, requestRpc), /20-byte EVM contract address/);
  }
  assert.equal(requests.length, 0);
});

test("rejects unsupported chain before acquisition and never infers chain", async () => {
  const { requests, requestRpc } = makeRpc();
  await assert.rejects(execute("solana", ADDRESS, requestRpc), /explicit supported EVM chain/);
  assert.equal(requests.length, 0);
});

test("decodes canonical block quantities exactly and rejects malformed quantities", () => {
  assert.deepEqual(normalizeEvmBlockNumber("0x123456789abcdef123456789abcdef"), {
    status: "available", blockNumber: "0x123456789abcdef123456789abcdef", basis: "eth_blockNumber",
  });
  assert.deepEqual(normalizeEvmBlockNumber("0x0001"), { status: "malformed", blockNumber: null, reason: "malformed_response" });
  for (const value of ["0x", "0xgg", `0x1${String.fromCharCode(10)}`, `0x1${String.fromCharCode(13, 10)}`, 123, null]) {
    assert.equal(normalizeEvmBlockNumber(value).status, "malformed");
  }
});

test("block provider failure stops later calls and leaves their evidence explicitly unattempted", async () => {
  const { requests, requestRpc } = makeRpc({ eth_blockNumber: async () => { throw new EvmRpcProviderError("transport", "Alchemy RPC request failed."); } });
  const { evidence, telemetry } = await execute("base", ADDRESS, requestRpc);
  assert.equal(evidence.provenance.observationBlock.status, "provider_error");
  assert.equal(evidence.contractCode.status, "not_attempted");
  assert.equal(evidence.totalSupply.reason, "block_unavailable");
  assert.deepEqual(requests.map((request) => request.method), ["eth_blockNumber"]);
  assert.equal(telemetry.requestCount, 1);
});

test("executes sequentially at one exact selected block and normalizes contract facts", async () => {
  const { requests, requestRpc } = makeRpc();
  const result = await execute("base", ADDRESS.toUpperCase().replace("0X", "0x"), requestRpc);
  const { evidence, telemetry } = result;
  assert.equal(evidence.submittedAddress, ADDRESS.toUpperCase().replace("0X", "0x"));
  assert.equal(evidence.contractAddress, ADDRESS);
  assert.equal(evidence.provenance.observationBlock.blockNumber, BLOCK);
  assert.deepEqual(requests.map(({ method }) => method), ["eth_blockNumber", "eth_getCode", "eth_call", "eth_call", "eth_call", "eth_call"]);
  assert.equal(requests[1].params[1], BLOCK);
  assert.ok(requests.slice(2).every(({ params }) => params[1] === BLOCK));
  assert.ok(requests.every(({ chain }) => chain === "base"));
  assert.deepEqual(evidence.contractCode, { status: "present", byteLength: 4, basis: "eth_getCode" });
  assert.equal(evidence.totalSupply.value, "123456789012345678901234567890");
  assert.equal(evidence.decimals.value, 18);
  assert.equal(evidence.name.value, "Token Ω");
  assert.equal(evidence.symbol.value, "TQE");
  assert.deepEqual(telemetry.requestsAttemptedByMethod, { eth_blockNumber: 1, eth_getCode: 1, eth_call: 4 });
  assert.equal(telemetry.requestCount, 6);
  assert.equal(evidence.provenance.fetchedAt, FETCHED_AT);
});

test("distinguishes no contract code and skips all ERC-20 calls", async () => {
  const { requests, requestRpc } = makeRpc({ eth_getCode: async () => "0x" });
  const { evidence, telemetry } = await execute("ethereum", ADDRESS, requestRpc);
  assert.deepEqual(evidence.contractCode, { status: "no_code", byteLength: 0, basis: "eth_getCode" });
  for (const fact of [evidence.totalSupply, evidence.decimals, evidence.name, evidence.symbol]) {
    assert.deepEqual(fact, { status: "not_attempted", value: null, reason: "no_contract_code" });
  }
  assert.deepEqual(requests.map(({ method }) => method), ["eth_blockNumber", "eth_getCode"]);
  assert.equal(telemetry.requestCount, 2);
});

test("malformed code is not treated as no code and prevents ERC-20 calls", async () => {
  const { requests, requestRpc } = makeRpc({ eth_getCode: async () => "0x123" });
  const { evidence } = await execute("base", ADDRESS, requestRpc);
  assert.deepEqual(evidence.contractCode, { status: "malformed", reason: "malformed_response" });
  assert.equal(evidence.totalSupply.reason, "code_unavailable");
  assert.equal(requests.length, 2);
});

test("normalizes no-code, present-code, and malformed code response shapes", () => {
  assert.deepEqual(normalizeEvmContractCode("0x"), { status: "no_code", byteLength: 0, basis: "eth_getCode" });
  assert.deepEqual(normalizeEvmContractCode("0x6000"), { status: "present", byteLength: 2, basis: "eth_getCode" });
  assert.equal(normalizeEvmContractCode("0x0").status, "malformed");
  assert.equal(normalizeEvmContractCode("0xzz").status, "malformed");
  assert.equal(normalizeEvmContractCode(`0x6000${String.fromCharCode(10)}`).status, "malformed");
  assert.equal(normalizeEvmContractCode(`0x6000${String.fromCharCode(13, 10)}`).status, "malformed");
});

test("totalSupply decodes zero, ordinary, large, and maximum uint256 values exactly", () => {
  for (const value of [0n, 123n, BigInt(Number.MAX_SAFE_INTEGER) + 99n, (1n << 256n) - 1n]) {
    assert.deepEqual(normalizeEvmUint256(`0x${word(value)}`), { status: "available", value: value.toString(), basis: "eth_call" });
  }
});

test("malformed totalSupply ABI data remains malformed", () => {
  for (const value of ["0x", `0x${"1".repeat(63)}`, `0x${"g".repeat(64)}`, 1]) {
    assert.deepEqual(normalizeEvmUint256(value), { status: "malformed", value: null, reason: "malformed_abi" });
  }
});

test("decimals accepts only a canonical ABI uint8 value", () => {
  for (const value of [0, 18, 255]) {
    assert.deepEqual(normalizeEvmDecimals(`0x${word(value)}`), { status: "available", value, basis: "eth_call" });
  }
  assert.equal(normalizeEvmDecimals(`0x${word(256)}`).status, "malformed");
  assert.equal(normalizeEvmDecimals(`0x${"f".repeat(64)}`).status, "malformed");
  assert.equal(normalizeEvmDecimals("0x12").status, "malformed");
});

test("decodes standard ABI dynamic strings including empty and Unicode values", () => {
  for (const value of ["", "Example Token", "Token Ω 🪙"]) {
    assert.deepEqual(normalizeEvmAbiString(abiString(value)), { status: "available", value, basis: "eth_call" });
  }
});

test("rejects malformed ABI string offsets, lengths, truncation, padding, and UTF-8", () => {
  const valid = abiString("A");
  const invalidUtf8 = `0x${word(32)}${word(1)}ff${"0".repeat(62)}`;
  const badPadding = `0x${word(32)}${word(1)}41${"1".repeat(62)}`;
  const malformed = [
    `0x${word(64)}${valid.slice(2, 66)}${valid.slice(66)}`,
    `0x${word(32)}${word(Number.MAX_SAFE_INTEGER + 1)}${"0".repeat(64)}`,
    valid.slice(0, -2),
    invalidUtf8,
    badPadding,
    "0x1234",
  ];
  for (const value of malformed) {
    assert.deepEqual(normalizeEvmAbiString(value), { status: "malformed", value: null, reason: "malformed_abi" });
  }
  assert.equal(normalizeEvmAbiString(`${abiString("A")}${"0".repeat(64)}`).status, "malformed");
  assert.equal(normalizeEvmAbiString(`${abiString("A")}${String.fromCharCode(10)}`).status, "malformed");
  assert.equal(normalizeEvmAbiString(`${abiString("A")}${String.fromCharCode(13, 10)}`).status, "malformed");
});

test("an independent metadata RPC error does not erase supply or decimals evidence", async () => {
  const { requests, requestRpc } = makeRpc({
    eth_call: async (_chain, params) => {
      if (params[0].data === "0x18160ddd") return `0x${word(500)}`;
      if (params[0].data === "0x313ce567") return `0x${word(6)}`;
      if (params[0].data === "0x06fdde03") throw new EvmRpcProviderError("rpc", "Alchemy returned a JSON-RPC error.", 3);
      return abiString("SYM");
    },
  });
  const { evidence } = await execute("ethereum", ADDRESS, requestRpc);
  assert.equal(evidence.totalSupply.value, "500");
  assert.equal(evidence.decimals.value, 6);
  assert.deepEqual(evidence.name, { status: "rpc_error", value: null, rpcCode: 3 });
  assert.equal(evidence.symbol.value, "SYM");
  assert.equal(requests.length, 6);
});

test("Base and Ethereum select explicit Alchemy network endpoints", async () => {
  await withApiKey(async () => {
    for (const [chain, expectedHost] of [["base", "base-mainnet.g.alchemy.com"], ["ethereum", "eth-mainnet.g.alchemy.com"]]) {
      let requestedUrl;
      const result = await requestAlchemyRpc(chain, "eth_blockNumber", [], {
        fetchImpl: async (url) => {
          requestedUrl = String(url);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-evm-token-evidence", result: "0x1" }), { status: 200 });
        },
      });
      assert.equal(result, "0x1");
      assert.ok(requestedUrl.startsWith(`https://${expectedHost}/v2/`));
      assert.ok(requestedUrl.endsWith(API_KEY));
    }
  });
});

test("Alchemy adapter rejects mismatched response IDs and omitted results", async () => {
  await withApiKey(async () => {
    const envelopes = [
      { jsonrpc: "2.0", id: "wrong-id", result: "0x1" },
      { jsonrpc: "2.0", id: "tqe-evm-token-evidence" },
    ];
    for (const envelope of envelopes) {
      await assert.rejects(requestAlchemyRpc("base", "eth_blockNumber", [], {
        fetchImpl: async () => new Response(JSON.stringify(envelope), { status: 200 }),
      }), (error) => error.category === "malformed_response");
    }
  });
});

test("execution preflight failures report zero network requests", async () => {
  const previous = process.env.ALCHEMY_API_KEY;
  try {
    delete process.env.ALCHEMY_API_KEY;
    const missingKey = await execute("base", ADDRESS);
    assert.equal(missingKey.evidence.provenance.observationBlock.status, "provider_error");
    assert.equal(missingKey.evidence.provenance.observationBlock.error.category, "configuration");
    assert.equal(missingKey.telemetry.requestCount, 0);
    assert.deepEqual(missingKey.telemetry.requestsAttemptedByMethod, { eth_blockNumber: 0, eth_getCode: 0, eth_call: 0 });

    process.env.ALCHEMY_API_KEY = API_KEY;
    const invalidTimeout = await execute("base", ADDRESS, undefined, { timeoutMs: 0 });
    assert.equal(invalidTimeout.evidence.provenance.observationBlock.status, "provider_error");
    assert.equal(invalidTimeout.evidence.provenance.observationBlock.error.category, "configuration");
    assert.equal(invalidTimeout.telemetry.requestCount, 0);
    assert.deepEqual(invalidTimeout.telemetry.requestsAttemptedByMethod, { eth_blockNumber: 0, eth_getCode: 0, eth_call: 0 });
  } finally {
    if (previous === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = previous;
  }
});

test("execution sanitizes injected provider error text before serializing evidence", async () => {
  const secretSentinel = "SENTINEL-FAKE-API-KEY-DO-NOT-LEAK";
  const requestRpc = async () => { throw new EvmRpcProviderError("transport", `failed at https://example.invalid/${secretSentinel}`); };
  const result = await execute("base", ADDRESS, requestRpc);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(result.evidence.provenance.observationBlock.error.category, "transport");
  assert.equal(result.evidence.provenance.observationBlock.error.message, "Alchemy RPC request failed.");
  assert.equal(result.telemetry.requestCount, 1);
});

test("Alchemy adapter reports missing credentials without exposing a URL or key", async () => {
  const previous = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_API_KEY;
  let calls = 0;
  try {
    await assert.rejects(requestAlchemyRpc("base", "eth_blockNumber", [], {
      fetchImpl: async () => { calls += 1; throw new Error(API_KEY); },
    }), (error) => error.category === "configuration" && !error.message.includes(API_KEY));
    assert.equal(calls, 0);
  } finally {
    if (previous !== undefined) process.env.ALCHEMY_API_KEY = previous;
  }
});

test("provider HTTP and JSON-RPC errors are sanitized and distinct", async () => {
  await withApiKey(async () => {
    await assert.rejects(requestAlchemyRpc("base", "eth_blockNumber", [], {
      fetchImpl: async () => new Response(`private ${API_KEY}`, { status: 503 }),
    }), (error) => error.category === "http" && error.httpStatus === 503 && !error.message.includes(API_KEY));
    await assert.rejects(requestAlchemyRpc("base", "eth_blockNumber", [], {
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "tqe-evm-token-evidence", error: { code: -32000, message: API_KEY } }), { status: 200 }),
    }), (error) => error.category === "rpc" && error.rpcCode === -32000 && !error.message.includes(API_KEY));
  });
});

test("finite timeout aborts the request and reports a bounded transport error", async () => {
  await withApiKey(async () => {
    let capturedSignal;
    await assert.rejects(requestAlchemyRpc("base", "eth_blockNumber", [], {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => {
        capturedSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(`stalled ${API_KEY}`)), { once: true }));
      },
    }), (error) => error.category === "transport" && error.message === "Alchemy RPC request timed out." && !error.message.includes(API_KEY));
    assert.equal(capturedSignal.aborted, true);
  });
});

test("request failures remain errors and cannot become zero-valued contract facts", async () => {
  const { requestRpc } = makeRpc({ eth_getCode: async () => { throw new EvmRpcProviderError("http", "Alchemy HTTP request failed (status 502).", null, 502); } });
  const { evidence } = await execute("base", ADDRESS, requestRpc);
  assert.equal(evidence.contractCode.status, "provider_error");
  assert.equal(evidence.totalSupply.status, "not_attempted");
  assert.notEqual(evidence.totalSupply.value, "0");
});

