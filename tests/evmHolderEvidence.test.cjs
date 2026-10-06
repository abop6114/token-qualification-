const assert = require("node:assert/strict");
const { test } = require("node:test");
const { executeEvmHolderEvidence } = require("../dist/execution/evmHolderEvidence.js");
const { getGoldRushHolderPage } = require("../dist/providers/evm/goldRushHolders.js");
const { normalizeEvmAddress } = require("../dist/validation/evmAddress.js");

const CONTRACT = "0x1234567890abcdef1234567890abcdef12345678";
const HOLDER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const KEY = "goldrush-test-key-sentinel";
const BLOCK = "123456789012345678901234567890";
const FETCHED_AT = "2026-10-06T12:00:00.000Z";

function item(address = HOLDER_A, balance = "1", extras = {}) {
  return { address, balance, contract_address: CONTRACT, ...extras };
}

function indexedAddress(index) {
  return `0x${BigInt(index).toString(16).padStart(40, "0")}`;
}

function page(items, { pageNumber = 0, pageSize = 100, hasMore = false, totalCount = items.length, omitTotalCount = false, ...extras } = {}) {
  return {
    data: {
      chain_name: "base-mainnet",
      items,
      pagination: {
        page_number: pageNumber,
        page_size: pageSize,
        has_more: hasMore,
        ...(omitTotalCount ? {} : { total_count: totalCount }),
      },
      ...extras,
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function queuedFetch(responses, requests = []) {
  return async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    if (responses.length === 0) throw new Error("unexpected extra request");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

async function withKey(callback) {
  const previous = process.env.GOLDRUSH_API_KEY;
  process.env.GOLDRUSH_API_KEY = KEY;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.GOLDRUSH_API_KEY;
    else process.env.GOLDRUSH_API_KEY = previous;
  }
}

function execute(chain, responses, opts = {}) {
  const requests = [];
  const fetchImpl = queuedFetch(responses, requests);
  return {
    requests,
    run: executeEvmHolderEvidence(chain, CONTRACT, opts.block ?? BLOCK, {
      maxPages: opts.maxPages ?? 3,
      maxRecords: opts.maxRecords ?? 500,
      timeoutMs: opts.timeoutMs ?? 1000,
      fetchImpl,
      now: () => new Date(FETCHED_AT),
    }),
  };
}

test("normalizes EVM holder addresses and rejects malformed or line-terminated addresses", () => {
  assert.equal(normalizeEvmAddress("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"), "0xabcdef1234567890abcdef1234567890abcdef12");
  for (const value of ["0x1", `${CONTRACT}\n`, `${CONTRACT}\r\n`, `${CONTRACT}x`, `0x${"g".repeat(40)}`]) {
    assert.equal(normalizeEvmAddress(value), null);
  }
});

test("maps Base and Ethereum chain identities to GoldRush slugs inside the provider adapter", async () => {
  await withKey(async () => {
    for (const [chain, slug] of [["base", "base-mainnet"], ["ethereum", "eth-mainnet"]]) {
      const requests = [];
      const data = await getGoldRushHolderPage({ chain, tokenAddress: CONTRACT, blockHeight: BLOCK, pageNumber: 0, pageSize: 100, timeoutMs: 1000 }, {
        fetchImpl: queuedFetch([jsonResponse(page([]))], requests),
      });
      assert.equal(data.items.length, 0);
      assert.equal(requests[0].url.pathname, `/v1/${slug}/tokens/${CONTRACT}/token_holders_v2/`);
    }
  });
});

test("rejects unsupported chains, malformed token addresses, and noncanonical requested blocks before fetch", async () => {
  const requests = [];
  const fetchImpl = queuedFetch([], requests);
  const common = { maxPages: 1, maxRecords: 10, timeoutMs: 1000, fetchImpl };
  await assert.rejects(executeEvmHolderEvidence("solana", CONTRACT, BLOCK, common), /explicit supported EVM chain/);
  await assert.rejects(executeEvmHolderEvidence("base", `${CONTRACT}\n`, BLOCK, common), /20-byte EVM contract address/);
  for (const block of ["", "01", "-1", "1.5", "1e4", `${BLOCK}\n`, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(executeEvmHolderEvidence("base", CONTRACT, block, common), /canonical nonnegative decimal string/);
  }
  assert.equal(requests.length, 0);
});

test("preflight configuration and bounds failures perform no network request", async () => {
  const previous = process.env.GOLDRUSH_API_KEY;
  delete process.env.GOLDRUSH_API_KEY;
  let fetchCalls = 0;
  try {
    const missing = await executeEvmHolderEvidence("base", CONTRACT, BLOCK, {
      maxPages: 1, maxRecords: 10, timeoutMs: 1000, fetchImpl: async () => { fetchCalls += 1; throw new Error(KEY); },
      now: () => new Date(FETCHED_AT),
    });
    assert.equal(missing.evidence.coverage.status, "unavailable");
    assert.equal(missing.evidence.failure.category, "configuration");
    assert.equal(missing.telemetry.providerRequestCount, 0);
    assert.equal(fetchCalls, 0);

    process.env.GOLDRUSH_API_KEY = KEY;
    const invalidTimeout = await executeEvmHolderEvidence("base", CONTRACT, BLOCK, {
      maxPages: 1, maxRecords: 10, timeoutMs: 0, fetchImpl: async () => { fetchCalls += 1; throw new Error(KEY); },
      now: () => new Date(FETCHED_AT),
    });
    assert.equal(invalidTimeout.evidence.failure.category, "configuration");
    assert.equal(invalidTimeout.telemetry.providerRequestCount, 0);
    assert.equal(fetchCalls, 0);

    for (const badBounds of [{ maxPages: 0, maxRecords: 10 }, { maxPages: 1, maxRecords: -1 }]) {
      await assert.rejects(executeEvmHolderEvidence("base", CONTRACT, BLOCK, {
        ...badBounds, timeoutMs: 1000, fetchImpl: async () => { fetchCalls += 1; throw new Error(KEY); },
      }));
    }
    assert.equal(fetchCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.GOLDRUSH_API_KEY;
    else process.env.GOLDRUSH_API_KEY = previous;
  }
});

test("uses Bearer authentication, never puts the key in the URL, and requests the exact block and bounds", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [jsonResponse(page([item()]))]);
    const { evidence } = await run;
    const request = requests[0];
    assert.equal(request.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(request.url.searchParams.has("key"), false);
    assert.equal(request.url.href.includes(KEY), false);
    assert.equal(request.url.searchParams.get("block-height"), BLOCK);
    assert.equal(request.url.searchParams.get("page-number"), "0");
    assert.equal(request.url.searchParams.get("page-size"), "100");
    assert.equal(evidence.provenance.requestedObservationBlock, BLOCK);
  });
});

test("normalizes a terminal page with zero and positive exact balances and separate counts", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [jsonResponse(page([
      item(HOLDER_A, "0", { block_height: BLOCK }),
      item(HOLDER_B, "999999999999999999999999999999999999999999999999", { block_height: BLOCK }),
    ], { totalCount: 2 }))]);
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.equal(evidence.observedHolderRecordCount, 2);
    assert.equal(evidence.observedPositiveBalanceAddressCount, 1);
    assert.deepEqual(evidence.holders, [
      { address: HOLDER_A, rawBalance: "0" },
      { address: HOLDER_B, rawBalance: "999999999999999999999999999999999999999999999999" },
    ]);
    assert.equal(evidence.providerReportedHolderCount, "2");
    assert.equal(evidence.pagination.terminalReason, "natural_termination");
    assert.equal(evidence.provenance.providerReportedObservationBlock, BLOCK);
    assert.equal(evidence.provenance.providerBlockRelation, "match");
    assert.equal(telemetry.providerRequestCount, 1);
    assert.equal(telemetry.pagesReturned, 1);
    assert.equal(telemetry.providerRecordsReturned, 2);
    assert.equal(telemetry.recordsRetained, 2);
    assert.equal(requests.length, 1);
  });
});

test("accepts the exact uint256 maximum and rejects maximum plus one", async () => {
  await withKey(async () => {
    const max = ((1n << 256n) - 1n).toString();
    const accepted = execute("base", [jsonResponse(page([item(HOLDER_A, max)]))]);
    const acceptedResult = await accepted.run;
    assert.equal(acceptedResult.evidence.coverage.status, "provider_complete");
    assert.equal(acceptedResult.evidence.holders[0].rawBalance, max);

    const rejected = execute("base", [jsonResponse(page([item(HOLDER_A, (BigInt(max) + 1n).toString())]))]);
    const rejectedResult = await rejected.run;
    assert.equal(rejectedResult.evidence.coverage.status, "malformed");
    assert.deepEqual(rejectedResult.evidence.holders, []);
  });
});

test("retains provider-reported block mismatch without claiming same-block compatibility", async () => {
  await withKey(async () => {
    const { run } = execute("base", [jsonResponse(page([item(HOLDER_A, "4", { block_height: "123" })]))]);
    const { evidence } = await run;
    assert.equal(evidence.provenance.requestedObservationBlock, BLOCK);
    assert.equal(evidence.provenance.providerReportedObservationBlock, "123");
    assert.equal(evidence.provenance.providerBlockRelation, "mismatch");
    assert.equal(evidence.chain, "base");
    assert.equal(evidence.provenance.providerChainSlug, "base-mainnet");
  });
});

test("does not accept unsafe numeric provider block heights", async () => {
  await withKey(async () => {
    const { run } = execute("base", [jsonResponse(page([item(HOLDER_A, "4", { block_height: Number.MAX_SAFE_INTEGER + 1 })]))]);
    const { evidence } = await run;
    assert.equal(evidence.coverage.status, "malformed");
    assert.equal(evidence.pagination.terminalReason, "malformed_response");
    assert.deepEqual(evidence.holders, []);
  });
});

test("rejects noninteger, signed, exponent, whitespace, CR/LF, and out-of-range balance representations", async () => {
  await withKey(async () => {
    for (const balance of ["-1", "+1", "1.5", "1e4", " 1", "1 ", `1${String.fromCharCode(10)}`, `1${String.fromCharCode(13)}`, `1${String.fromCharCode(13, 10)}`, "", "1".repeat(79), 1, Number.MAX_SAFE_INTEGER + 1]) {
      const { run } = execute("base", [jsonResponse(page([item(HOLDER_A, balance)]))]);
      const { evidence } = await run;
      assert.equal(evidence.coverage.status, "malformed", `balance case ${String(balance)}`);
      assert.deepEqual(evidence.holders, []);
    }
  });
});

test("rejects malformed holder addresses, contract identity, and mismatched page metadata", async () => {
  await withKey(async () => {
    const malformedPages = [
      page([item(`${HOLDER_A}\n`, "1")]),
      page([item(HOLDER_A, "1", { contract_address: HOLDER_B })]),
      page([item(HOLDER_A)], { pageNumber: 1 }),
      page([item(HOLDER_A)], { pageSize: 1000 }),
      page([item(HOLDER_A)], { hasMore: true, totalCount: 1 }),
    ];
    for (const raw of malformedPages) {
      const { run } = execute("base", [jsonResponse(raw)]);
      const { evidence } = await run;
      assert.equal(evidence.coverage.status, "malformed");
      assert.equal(evidence.pagination.terminalReason, "malformed_response");
      assert.deepEqual(evidence.holders, []);
    }
  });
});

test("requires each row to report the matching token contract address", async () => {
  await withKey(async () => {
    const mixedCaseContract = `0x${CONTRACT.slice(2).toUpperCase()}`;
    const matching = execute("base", [jsonResponse(page([item(HOLDER_A, "1", { contract_address: mixedCaseContract })]))]);
    const matchingResult = await matching.run;
    assert.equal(matchingResult.evidence.coverage.status, "provider_complete");
    assert.deepEqual(matchingResult.evidence.holders, [{ address: HOLDER_A, rawBalance: "1" }]);

    const missingContract = item();
    delete missingContract.contract_address;
    for (const row of [
      missingContract,
      item(HOLDER_A, "1", { contract_address: "not-an-address" }),
      item(HOLDER_A, "1", { contract_address: HOLDER_B }),
    ]) {
      const { run } = execute("base", [jsonResponse(page([row]))]);
      const { evidence } = await run;
      assert.equal(evidence.coverage.status, "malformed");
      assert.equal(evidence.pagination.terminalReason, "malformed_response");
      assert.deepEqual(evidence.holders, []);
    }
  });
});

test("collapses semantically identical normalized duplicate addresses", async () => {
  await withKey(async () => {
    const { run } = execute("base", [jsonResponse(page([item(HOLDER_A.toUpperCase().replace("0X", "0x"), "0007"), item(HOLDER_A, "7")], { totalCount: 2 }))]);
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.deepEqual(evidence.holders, [{ address: HOLDER_A, rawBalance: "7" }]);
    assert.equal(evidence.observedHolderRecordCount, 1);
    assert.equal(evidence.observedPositiveBalanceAddressCount, 1);
    assert.equal(telemetry.providerRecordsReturned, 2);
    assert.equal(telemetry.recordsRetained, 1);
  });
});

test("collapses identical duplicates across pages while keeping provider and retained counts distinct", async () => {
  await withKey(async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const { run } = execute("base", [
      jsonResponse(page(firstItems, { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(indexedAddress(0), "1")], { pageNumber: 1, totalCount: 101 })),
    ], { maxRecords: 200 });
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.equal(evidence.pagination.providerReportedHolderCount, "101");
    assert.equal(evidence.observedHolderRecordCount, 100);
    assert.equal(evidence.observedPositiveBalanceAddressCount, 100);
    assert.equal(evidence.pagination.providerRecordsReturned, 101);
    assert.equal(evidence.pagination.recordsRetained, 100);
    assert.deepEqual(evidence.pagination.pages.map((entry) => entry.recordsRetained), [100, 0]);
    assert.equal(telemetry.providerRecordsReturned, 101);
    assert.equal(telemetry.recordsRetained, 100);
  });
});

test("raw record cap is consumed by duplicates and does not expand within an oversized page", async () => {
  await withKey(async () => {
    const oversizedRows = [
      item(HOLDER_A, "1"),
      item(HOLDER_A, "1"),
      item(HOLDER_B, "2"),
      item(HOLDER_C, "3", { contract_address: "malformed-beyond-budget" }),
    ];
    const { requests, run } = execute("base", [jsonResponse(page(oversizedRows, { hasMore: true, totalCount: 5 }))], {
      maxRecords: 2,
    });
    const { evidence, telemetry } = await run;
    assert.equal(requests.length, 1);
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "record_cap");
    assert.equal(evidence.pagination.providerRecordsReturned, 4);
    assert.equal(evidence.pagination.pages[0].providerRecordsReturned, 4);
    assert.equal(evidence.pagination.recordsRetained, 1);
    assert.deepEqual(evidence.holders, [{ address: HOLDER_A, rawBalance: "1" }]);
    assert.equal(telemetry.providerRecordsReturned, 4);
    assert.equal(telemetry.recordsRetained, 1);
  });
});

test("cross-page duplicates consume the raw record cap and prevent another request", async () => {
  await withKey(async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const { requests, run } = execute("base", [
      jsonResponse(page(firstItems, { hasMore: true, totalCount: 103 })),
      jsonResponse(page([item(indexedAddress(0), "1"), item(HOLDER_A, "5")], { pageNumber: 1, hasMore: true, totalCount: 103 })),
      jsonResponse(page([item(HOLDER_B)], { pageNumber: 2, totalCount: 103 })),
    ], { maxRecords: 101, maxPages: 5 });
    const { evidence, telemetry } = await run;
    assert.equal(requests.length, 2);
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "record_cap");
    assert.equal(evidence.pagination.providerRecordsReturned, 102);
    assert.equal(evidence.pagination.recordsRetained, 100);
    assert.equal(evidence.observedHolderRecordCount, 100);
    assert.equal(evidence.observedPositiveBalanceAddressCount, 100);
    assert.equal(telemetry.providerRequestCount, 2);
    assert.equal(telemetry.pagesRequested, 2);
    assert.equal(telemetry.pagesReturned, 2);
    assert.equal(telemetry.providerRecordsReturned, 102);
    assert.equal(telemetry.recordsRetained, 100);
  });
});

test("rejects conflicting duplicate balances transactionally and retains only prior pages", async () => {
  await withKey(async () => {
    const { run } = execute("base", [
      jsonResponse(page(Array.from({ length: 100 }, (_, i) => item(i === 0 ? HOLDER_A : indexedAddress(i), String(i + 1))), { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(HOLDER_A, "2")], { pageNumber: 1, hasMore: false, totalCount: 101 })),
    ]);
    const { evidence, telemetry } = await run;
    assert.equal(evidence.holders.length, 100);
    assert.deepEqual(evidence.holders[0], { address: HOLDER_A, rawBalance: "1" });
    assert.equal(evidence.pagination.terminalReason, "malformed_response");
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(telemetry.providerRequestCount, 2);
    assert.equal(telemetry.pagesReturned, 2);
    assert.equal(telemetry.providerRecordsReturned, 101);
    assert.equal(telemetry.recordsRetained, 100);
  });
});

test("walks multiple pages sequentially to explicit provider termination and reconciles counts", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [
      jsonResponse(page(Array.from({ length: 100 }, (_, i) => item(indexedAddress(i), String(i + 1))), { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(HOLDER_B, "2")], { pageNumber: 1, totalCount: 101 })),
    ]);
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.equal(evidence.holders.length, 101);
    assert.deepEqual(evidence.holders.slice(-1).map((holder) => holder.address), [HOLDER_B]);
    assert.equal(evidence.pagination.pagesRequested, 2);
    assert.equal(evidence.pagination.pagesReturned, 2);
    assert.equal(evidence.pagination.providerRecordsReturned, 101);
    assert.equal(evidence.pagination.recordsRetained, 101);
    assert.deepEqual(evidence.pagination.pages.map((p) => p.requestedPageNumber), [0, 1]);
    assert.deepEqual(requests.map((r) => r.url.searchParams.get("page-number")), ["0", "1"]);
    assert.equal(telemetry.providerRequestCount, 2);
    assert.equal(telemetry.pagesReturned, 2);
    assert.equal(telemetry.providerRecordsReturned, 101);
    assert.equal(telemetry.recordsRetained, 101);
  });
});

test("an exact raw record boundary can terminate naturally without another request", async () => {
  await withKey(async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const { requests, run } = execute("base", [
      jsonResponse(page(firstItems, { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(HOLDER_B, "2")], { pageNumber: 1, totalCount: 101 })),
      jsonResponse(page([item(HOLDER_C)], { pageNumber: 2, totalCount: 101 })),
    ], { maxRecords: 101 });
    const { evidence, telemetry } = await run;
    assert.equal(requests.length, 2);
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.equal(evidence.pagination.terminalReason, "natural_termination");
    assert.equal(evidence.pagination.providerRecordsReturned, 101);
    assert.equal(evidence.pagination.recordsRetained, 101);
    assert.equal(telemetry.providerRequestCount, 2);
  });
});

test("a raw record cap reached at a page boundary stops before another request", async () => {
  await withKey(async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const { requests, run } = execute("base", [
      jsonResponse(page(firstItems, { hasMore: true, totalCount: 102 })),
      jsonResponse(page([item(HOLDER_B)], { pageNumber: 1, hasMore: true, totalCount: 102 })),
      jsonResponse(page([item(HOLDER_C)], { pageNumber: 2, totalCount: 102 })),
    ], { maxRecords: 101 });
    const { evidence, telemetry } = await run;
    assert.equal(requests.length, 2);
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "record_cap");
    assert.equal(evidence.pagination.providerRecordsReturned, 101);
    assert.equal(evidence.pagination.recordsRetained, 101);
    assert.equal(telemetry.pagesRequested, 2);
    assert.equal(telemetry.pagesReturned, 2);
  });
});

test("supports provider responses without total_count while preserving explicit unavailable count", async () => {
  await withKey(async () => {
    const { run } = execute("base", [jsonResponse(page([item()], { omitTotalCount: true }))]);
    const { evidence } = await run;
    assert.equal(evidence.coverage.status, "provider_complete");
    assert.equal(evidence.providerReportedHolderCount, null);
    assert.equal(evidence.pagination.providerReportedHolderCount, null);
  });
});

test("maxPages cap truncates without issuing an extra request", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [
      jsonResponse(page([item()], { hasMore: true, totalCount: 2 })),
      jsonResponse(page([item(HOLDER_B)], { pageNumber: 1, totalCount: 2 })),
    ], { maxPages: 1 });
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "page_cap");
    assert.equal(telemetry.providerRequestCount, 1);
    assert.equal(requests.length, 1);
  });
});

test("maxRecords cap within a returned page retains only the bounded prefix and reports provider count separately", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [jsonResponse(page([
      item(HOLDER_A, "1"), item(HOLDER_B, "2"), item(HOLDER_C, "3"),
    ], { totalCount: 3 }))], { maxRecords: 2 });
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "record_cap");
    assert.deepEqual(evidence.holders.map((holder) => holder.address), [HOLDER_A, HOLDER_B]);
    assert.equal(evidence.pagination.providerRecordsReturned, 3);
    assert.equal(evidence.pagination.recordsRetained, 2);
    assert.equal(telemetry.providerRequestCount, 1);
    assert.equal(requests.length, 1);
  });
});

test("reports record cap at exact page end when provider indicates more pages", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [jsonResponse(page([item()], { hasMore: true, totalCount: 2 }))], { maxRecords: 1 });
    const { evidence } = await run;
    assert.equal(evidence.pagination.terminalReason, "record_cap");
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(requests.length, 1);
  });
});

test("reports simultaneous page and record caps without fetching another page", async () => {
  await withKey(async () => {
    const { requests, run } = execute("base", [jsonResponse(page([item(HOLDER_A), item(HOLDER_B)], { hasMore: true, totalCount: 3 }))], {
      maxPages: 1, maxRecords: 1,
    });
    const { evidence } = await run;
    assert.equal(evidence.pagination.terminalReason, "page_and_record_caps");
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.holders.length, 1);
    assert.equal(requests.length, 1);
  });
});

test("provider failure on first page is unavailable and provider failure after a page is partial", async () => {
  await withKey(async () => {
    const first = execute("base", [jsonResponse({ error: true, error_message: "private detail", error_code: "x" })]);
    const firstResult = await first.run;
    assert.equal(firstResult.evidence.coverage.status, "unavailable");
    assert.equal(firstResult.evidence.failure.category, "provider");
    assert.equal(firstResult.telemetry.providerRequestCount, 1);

    const later = execute("base", [
      jsonResponse(page([item()], { hasMore: true, totalCount: 2 })),
      jsonResponse(page([], { pageNumber: 1, totalCount: 2 }), 503),
    ]);
    const laterResult = await later.run;
    assert.equal(laterResult.evidence.coverage.status, "partial");
    assert.equal(laterResult.evidence.pagination.terminalReason, "provider_error");
    assert.equal(laterResult.evidence.holders.length, 1);
    assert.equal(laterResult.telemetry.providerRequestCount, 2);
    assert.equal(laterResult.telemetry.pagesReturned, 1);
  });
});

test("malformed later page preserves earlier accepted page and does not accept any row from bad page", async () => {
  await withKey(async () => {
    const { run } = execute("base", [
      jsonResponse(page([item(HOLDER_A, "1")], { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(`${HOLDER_B}\r\n`, "2")], { pageNumber: 1, totalCount: 101 })),
    ]);
    const { evidence } = await run;
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "malformed_response");
    assert.deepEqual(evidence.holders, [{ address: HOLDER_A, rawBalance: "1" }]);
  });
});

test("rejects provider block-height disagreement across pages transactionally", async () => {
  await withKey(async () => {
    const { run } = execute("base", [
      jsonResponse(page([item(HOLDER_A, "1", { block_height: "123" })], { hasMore: true, totalCount: 101 })),
      jsonResponse(page([item(HOLDER_B, "2", { block_height: "124" })], { pageNumber: 1, totalCount: 101 })),
    ]);
    const { evidence, telemetry } = await run;
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "malformed_response");
    assert.deepEqual(evidence.holders, [{ address: HOLDER_A, rawBalance: "1" }]);
    assert.equal(evidence.pagination.pages.length, 1);
    assert.equal(evidence.pagination.pagesReturned, 2);
    assert.equal(evidence.pagination.providerRecordsReturned, 2);
    assert.equal(telemetry.recordsRetained, 1);
  });
});

test("rejects total_count changes across pages while retaining prior evidence", async () => {
  await withKey(async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const { run } = execute("base", [
      jsonResponse(page(firstItems, { hasMore: true, totalCount: 102 })),
      jsonResponse(page([item(HOLDER_B)], { pageNumber: 1, hasMore: false, totalCount: 101 })),
    ]);
    const { evidence } = await run;
    assert.equal(evidence.coverage.status, "partial");
    assert.equal(evidence.pagination.terminalReason, "malformed_response");
    assert.equal(evidence.providerReportedHolderCount, "102");
    assert.equal(evidence.pagination.pages.length, 1);
    assert.equal(evidence.pagination.providerRecordsReturned, 101);
    assert.equal(evidence.holders.length, 100);
  });
});

test("configuration removed between pages does not count a nonexistent request", async () => {
  await withKey(async () => {
    let fetchCalls = 0;
    const firstItems = Array.from({ length: 100 }, (_, index) => item(indexedAddress(index), String(index + 1)));
    const result = await executeEvmHolderEvidence("base", CONTRACT, BLOCK, {
      maxPages: 3,
      maxRecords: 500,
      timeoutMs: 1000,
      now: () => new Date(FETCHED_AT),
      fetchImpl: async () => {
        fetchCalls += 1;
        delete process.env.GOLDRUSH_API_KEY;
        return jsonResponse(page(firstItems, { hasMore: true, totalCount: 101 }));
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(result.telemetry.providerRequestCount, 1);
    assert.equal(result.telemetry.pagesRequested, 1);
    assert.equal(result.telemetry.pagesReturned, 1);
    assert.equal(result.telemetry.providerRecordsReturned, 100);
    assert.equal(result.telemetry.recordsRetained, 100);
    assert.equal(result.evidence.coverage.status, "partial");
    assert.equal(result.evidence.failure.category, "configuration");
    assert.equal(result.evidence.pagination.terminalReason, "provider_error");
    assert.equal(result.evidence.holders.length, 100);
  });
});

test("provider envelope, HTTP, and transport errors are sanitized and never serialized", async () => {
  await withKey(async () => {
    const sentinel = "FAKE-GOLDRUSH-SECRET-SENTINEL";
    const results = [
      jsonResponse({ error: true, error_message: `leak ${sentinel}`, error_code: "bad" }),
      new Response("private response", { status: 502 }),
      new Error(`network ${sentinel} https://example.invalid/${sentinel}`),
    ];
    for (const next of results) {
      const { run } = execute("base", [next]);
      const result = await run;
      assert.equal(JSON.stringify(result).includes(sentinel), false);
      assert.equal(JSON.stringify(result).includes("private response"), false);
    }
  });
});

test("timeout aborts the request once and reports a bounded sanitized failure", async () => {
  await withKey(async () => {
    let calls = 0;
    let signal;
    const result = await executeEvmHolderEvidence("base", CONTRACT, BLOCK, {
      maxPages: 3, maxRecords: 10, timeoutMs: 5, now: () => new Date(FETCHED_AT),
      fetchImpl: async (_url, init) => {
        calls += 1;
        signal = init.signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(KEY)), { once: true }));
      },
    });
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(result.evidence.failure.category, "transport");
    assert.equal(result.evidence.failure.message, "GoldRush request failed.");
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(result.telemetry.providerRequestCount, 1);
  });
});

test("retains exact provider data while never naming addresses as owners or wallets", async () => {
  await withKey(async () => {
    const { run } = execute("base", [jsonResponse(page([item(HOLDER_C, "42")]))]);
    const { evidence } = await run;
    assert.deepEqual(Object.keys(evidence.holders[0]).sort(), ["address", "rawBalance"]);
    assert.equal(evidence.holders[0].address, HOLDER_C);
    assert.equal(evidence.holders[0].rawBalance, "42");
    assert.equal(Object.hasOwn(evidence, "owners"), false);
  });
});
