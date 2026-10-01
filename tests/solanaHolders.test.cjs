const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeSolanaHolderStructure } = require("../dist/normalization/solanaHolders.js");
const { normalizeOwnerAuthorityBalanceDistribution } = require("../dist/normalization/ownerAuthorityBalanceDistribution.js");
const { SOLANA_TOKEN_PROGRAM_IDS } = require("../dist/types/solana.js");
const { decodeSolanaPublicKey, encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const MINT = "11111111111111111111111111111111";
const FETCHED_AT = "2026-01-02T03:04:05.000Z";

function account(ownerByte, amount, options = {}) {
  const data = Buffer.alloc(options.extension ? 174 : 165);
  data.set(decodeSolanaPublicKey(MINT), 0);
  data.set(Buffer.alloc(32, ownerByte), 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = options.state ?? 1;
  if (options.extension) {
    data[165] = 2;
    data.writeUInt16LE(options.extension.type, 166);
    data.writeUInt16LE(4, 168);
    data.writeUInt32LE(1, 170);
  }
  return {
    address: encodeSolanaPublicKey(Buffer.alloc(32, options.addressByte ?? ownerByte + 32)),
    programOwner: SOLANA_TOKEN_PROGRAM_IDS[options.program ?? "spl-token"],
    dataBase64: data.toString("base64"),
    reportedSpace: data.length,
  };
}

function normalize(accounts, overrides = {}) {
  return normalizeSolanaHolderStructure({
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000",
    mintExtensionTypes: [],
    pages: [{ accounts, paginationKey: null, contextSlot: 123 }],
    fetchedAt: FETCHED_AT,
    ...overrides,
  });
}

test("counts token accounts including zero balances and aggregates positive balances by owner", () => {
  const result = normalize([account(1, "40"), account(1, "0", { addressByte: 90 }), account(2, "60")]);
  assert.equal(result.tokenAccountCount, 3);
  assert.equal(result.nonzeroTokenAccountCount, 2);
  assert.equal(result.rawOwnerCount, 2);
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "60");
  assert.equal(result.rawOwnerAuthorities[1].balanceRaw, "40");
  assert.equal(result.rawOwnerAuthorities[1].tokenAccountCount, 2);
  assert.deepEqual(result.tokenAccountStateSummary, {
    initialized: { tokenAccountCount: 3, positiveBalanceTokenAccountCount: 2, observedBalanceRaw: "100" },
    frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
  });
});

test("summarizes all-frozen accounts including a zero-balance account", () => {
  const result = normalize([
    account(1, "25", { state: 2 }),
    account(2, "0", { state: 2 }),
  ]);
  assert.deepEqual(result.tokenAccountStateSummary, {
    initialized: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    frozen: { tokenAccountCount: 2, positiveBalanceTokenAccountCount: 1, observedBalanceRaw: "25" },
  });
});

test("reconciles initialized and frozen account evidence without classifying owner authorities", () => {
  const result = normalize([
    account(8, "9007199254740993", { state: 1 }),
    account(8, "7", { state: 2, addressByte: 99 }),
    account(9, "0", { state: 1 }),
    account(10, "0", { state: 2 }),
  ], { currentMintSupplyRaw: "9007199254741000" });
  const states = result.tokenAccountStateSummary;

  assert.equal(states.initialized.tokenAccountCount, 2);
  assert.equal(states.frozen.tokenAccountCount, 2);
  assert.equal(states.initialized.positiveBalanceTokenAccountCount, 1);
  assert.equal(states.frozen.positiveBalanceTokenAccountCount, 1);
  assert.equal(states.initialized.observedBalanceRaw, "9007199254740993");
  assert.equal(states.frozen.observedBalanceRaw, "7");

  assert.equal(states.initialized.tokenAccountCount + states.frozen.tokenAccountCount, result.tokenAccountCount);
  assert.equal(states.initialized.positiveBalanceTokenAccountCount + states.frozen.positiveBalanceTokenAccountCount, result.nonzeroTokenAccountCount);
  assert.equal((BigInt(states.initialized.observedBalanceRaw) + BigInt(states.frozen.observedBalanceRaw)).toString(), result.observedPositiveBalanceRaw);

  assert.equal(result.rawOwnerCount, 1);
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "9007199254741000");
  assert.equal(result.rawOwnerAuthorities[0].tokenAccountCount, 2);
  assert.equal(result.concentration.top1.percentage, "100.000000");

  const distribution = normalizeOwnerAuthorityBalanceDistribution({
    chain: result.chain,
    assetAddress: result.mintAddress,
    snapshotAt: result.fetchedAt,
    decimals: result.decimals,
    currentSupplyRaw: result.currentMintSupplyRaw,
    enumeration: result.enumeration,
    amountCoverage: result.amountCoverage,
    rawOwnerCount: result.rawOwnerCount,
    rawOwnerAuthorities: result.rawOwnerAuthorities,
  });
  assert.equal(distribution.observedOwnerAuthorityCount, 1);
  assert.equal(distribution.minimumBalanceRaw, "9007199254741000");
  assert.equal(distribution.cumulativeOwnerBalanceProfile.at(-1).cumulativeObservedBalanceRaw, "9007199254741000");
});

test("retains a maximum u64 balance in its observed account state", () => {
  const result = normalize([account(1, "18446744073709551615", { state: 2 })], {
    currentMintSupplyRaw: "18446744073709551615",
  });
  assert.equal(result.tokenAccountStateSummary.frozen.observedBalanceRaw, "18446744073709551615");
  assert.equal(result.tokenAccountStateSummary.frozen.positiveBalanceTokenAccountCount, 1);
  assert.equal(result.tokenAccountStateSummary.initialized.observedBalanceRaw, "0");
});

test("retains exact state totals above JavaScript safe integer range", () => {
  const result = normalize([
    account(1, "9007199254740993", { state: 1 }),
    account(2, "9007199254740993", { state: 2 }),
  ], { currentMintSupplyRaw: "18014398509481986" });
  assert.equal(result.tokenAccountStateSummary.initialized.observedBalanceRaw, "9007199254740993");
  assert.equal(result.tokenAccountStateSummary.frozen.observedBalanceRaw, "9007199254740993");
  assert.equal(result.observedPositiveBalanceRaw, "18014398509481986");
});

test("calculates top owner concentration with raw supply denominator and fixed precision", () => {
  const result = normalize([account(1, "1")], { currentMintSupplyRaw: "3" });
  assert.deepEqual(result.concentration.top1, {
    status: "available", topN: 1, numeratorRaw: "1", denominatorRaw: "3",
    denominatorBasis: "current_mint_supply", percentage: "33.333333",
  });
  assert.equal(result.observedPositiveBalanceRaw, "1");
  assert.equal(result.supplyDifferenceRaw, "2");
  assert.equal(result.concentration.top20.numeratorRaw, "1");
});

test("calculates top 1, 5, 10, and 20 after owner aggregation with address tie-break", () => {
  const accounts = [];
  for (let owner = 1; owner <= 20; owner += 1) accounts.push(account(owner, String(101 - owner)));
  accounts.push(account(21, "80"), account(21, "100", { addressByte: 100 }), account(22, "80"));
  const result = normalize(accounts, { currentMintSupplyRaw: "100000" });
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "180");
  assert.equal(result.concentration.top1.numeratorRaw, "180");
  assert.equal(result.concentration.top5.numeratorRaw, "574");
  assert.equal(result.concentration.top10.numeratorRaw, "1044");
  assert.equal(result.concentration.top20.numeratorRaw, "1909");
});

test("orders equal-balance owner authorities by lexicographically smaller address", () => {
  const result = normalize([account(9, "50"), account(3, "50")], { currentMintSupplyRaw: "100" });
  const expected = [
    encodeSolanaPublicKey(Buffer.alloc(32, 9)),
    encodeSolanaPublicKey(Buffer.alloc(32, 3)),
  ].sort();
  assert.deepEqual(result.rawOwnerAuthorities.map((owner) => owner.ownerAddress), expected);
});

test("returns an empty complete snapshot when enumeration contains no accounts", () => {
  const result = normalize([]);
  assert.equal(result.tokenAccountCount, 0);
  assert.equal(result.rawOwnerCount, 0);
  assert.equal(result.concentration.top1.numeratorRaw, "0");
  assert.equal(result.concentration.top1.percentage, "0.000000");
});

test("zero-balance-only owner authority does not increase rawOwnerCount", () => {
  const result = normalize([account(1, "0"), account(2, "10")]);
  assert.equal(result.tokenAccountCount, 2);
  assert.equal(result.nonzeroTokenAccountCount, 1);
  assert.equal(result.rawOwnerCount, 1);
  assert.deepEqual(result.rawOwnerAuthorities.map((owner) => owner.balanceRaw), ["10"]);
});

test("retains positive balances for frozen state-2 token accounts", () => {
  const result = normalize([account(4, "25", { state: 2 })], { currentMintSupplyRaw: "25" });
  assert.equal(result.tokenAccountCount, 1);
  assert.equal(result.nonzeroTokenAccountCount, 1);
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "25");
  assert.deepEqual(result.tokenAccountStateSummary.frozen, {
    tokenAccountCount: 1, positiveBalanceTokenAccountCount: 1, observedBalanceRaw: "25",
  });
});

test("preserves page count and every provider context slot", () => {
  const result = normalize([account(1, "1")], {
    pages: [
      { accounts: [account(1, "1")], paginationKey: "next", contextSlot: 123 },
      { accounts: [], paginationKey: null, contextSlot: 124 },
    ],
  });
  assert.deepEqual(result.enumeration, {
    completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [123, 124],
  });
  assert.equal(result.tokenAccountStateSummary.initialized.tokenAccountCount, 1);
  assert.equal(result.enumeration.slotConsistency, "not_guaranteed");
});

test("does not report completeness when the final page still has a cursor", () => {
  assert.throws(() => normalize([], {
    pages: [{ accounts: [], paginationKey: "more", contextSlot: 123 }],
  }), /enumeration is incomplete/);
});

test("partial Token-2022 amount coverage is unchanged while state evidence remains observable", () => {
  const result = normalize([account(1, "10", { state: 2, program: "token-2022", extension: { type: 2 } })], {
    tokenProgram: "token-2022",
  });
  assert.equal(result.amountCoverage.state, "partial");
  assert.equal(result.tokenAccountStateSummary.frozen.tokenAccountCount, 1);
  assert.equal(result.tokenAccountStateSummary.frozen.observedBalanceRaw, "10");
  assert.equal(result.enumeration.completeness, "complete");
  assert.equal(result.enumeration.slotConsistency, "not_guaranteed");
});

test("rejects duplicate token-account addresses instead of double-counting", () => {
  const row = account(1, "1");
  assert.throws(() => normalize([row, row]), /duplicate/);
});

test("rejects accounts for a different mint", () => {
  const row = account(1, "1");
  const data = Buffer.from(row.dataBase64, "base64");
  data[0] = 9;
  row.dataBase64 = data.toString("base64");
  assert.throws(() => normalize([row]), /different mint/);
});

test("rejects malformed base64, data length, and invalid account state", () => {
  const malformed = account(1, "1");
  malformed.dataBase64 = "not-base64!";
  assert.throws(() => normalize([malformed]), /base64/);
  const wrongSpace = account(1, "1");
  wrongSpace.reportedSpace = 2;
  assert.throws(() => normalize([wrongSpace]), /reported space/);
  const badState = account(1, "1");
  for (const invalidState of [0, 3]) {
    const bytes = Buffer.from(badState.dataBase64, "base64");
    bytes[108] = invalidState;
    badState.dataBase64 = bytes.toString("base64");
    assert.throws(() => normalize([badState]), /uninitialized/);
  }
});

test("does not convert a zero current supply into a zero concentration", () => {
  const result = normalize([account(1, "0")], { currentMintSupplyRaw: "0" });
  assert.equal(result.concentration.top1.status, "unavailable");
  assert.equal(result.concentration.top1.reason, "zero_supply");
  assert.equal(result.concentration.top1.percentage, null);
});

test("reconciles positive balances equal to current mint supply exactly", () => {
  const result = normalize([account(1, "70"), account(2, "30")], { currentMintSupplyRaw: "100" });
  assert.equal(result.observedPositiveBalanceRaw, "100");
  assert.equal(result.currentMintSupplyRaw, "100");
  assert.equal(result.supplyDifferenceRaw, "0");
  assert.equal(result.amountCoverage.state, "complete");
  assert.equal(result.concentration.top20.percentage, "100.000000");
});

test("preserves positive supply difference and calculates concentration below supply", () => {
  const result = normalize([account(1, "70"), account(2, "20")], { currentMintSupplyRaw: "100" });
  assert.equal(result.observedPositiveBalanceRaw, "90");
  assert.equal(result.supplyDifferenceRaw, "10");
  assert.equal(result.amountCoverage.state, "complete");
  assert.equal(result.concentration.top1.percentage, "70.000000");
  assert.equal(result.concentration.top20.percentage, "90.000000");
});

test("marks exact concentration unavailable when observed balances exceed supply", () => {
  const result = normalize([account(1, "70"), account(2, "50")], { currentMintSupplyRaw: "100" });
  assert.equal(result.observedPositiveBalanceRaw, "120");
  assert.equal(result.supplyDifferenceRaw, "-20");
  assert.equal(result.amountCoverage.state, "partial");
  assert.equal(result.amountCoverage.reason, "supply_inconsistency");
  assert.equal(result.concentration.top1.status, "unavailable");
  assert.equal(result.concentration.top1.reason, "supply_inconsistency");
  assert.equal(result.concentration.top1.numeratorRaw, null);
  assert.equal(result.concentration.top1.percentage, null);
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "70");
});

test("marks balances and concentration partial for known balance-affecting Token-2022 extensions", () => {
  const result = normalize([account(1, "10", { program: "token-2022", extension: { type: 2 } })], {
    tokenProgram: "token-2022",
  });
  assert.equal(result.amountCoverage.state, "partial");
  assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, [2]);
  assert.equal(result.concentration.top1.reason, "unsupported_balance_affecting_extension");
});

test("ConfidentialMintBurn type 24 downgrades amount coverage and concentration", () => {
  const result = normalize([account(1, "10", { program: "token-2022" })], {
    tokenProgram: "token-2022",
    mintExtensionTypes: [24],
  });
  assert.equal(result.amountCoverage.state, "partial");
  assert.equal(result.amountCoverage.reason, "unsupported_balance_affecting_extension");
  assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, [24]);
  assert.equal(result.concentration.top1.status, "unavailable");
  assert.equal(result.concentration.top1.reason, "unsupported_balance_affecting_extension");
});

test("mint extensions 1, 4, and 16 conservatively make amount coverage partial", () => {
  for (const extensionType of [1, 4, 16]) {
    const result = normalize([account(1, "10", { program: "token-2022" })], {
      tokenProgram: "token-2022",
      mintExtensionTypes: [extensionType],
    });
    assert.equal(result.amountCoverage.state, "partial", `mint extension ${extensionType}`);
    assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, [extensionType]);
    assert.equal(result.concentration.top1.status, "unavailable");
    assert.equal(result.concentration.top1.reason, "unsupported_balance_affecting_extension");
  }
});

test("token-account extensions 5 and 17 conservatively make amount coverage partial", () => {
  for (const extensionType of [5, 17]) {
    const result = normalize([account(1, "10", { program: "token-2022", extension: { type: extensionType } })], {
      tokenProgram: "token-2022",
    });
    assert.equal(result.amountCoverage.state, "partial", `account extension ${extensionType}`);
    assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, [extensionType]);
    assert.equal(result.concentration.top1.status, "unavailable");
    assert.equal(result.concentration.top1.reason, "unsupported_balance_affecting_extension");
  }
});

test("ScaledUiAmount type 25 alone preserves exact raw-balance coverage", () => {
  const result = normalize([account(1, "10", { program: "token-2022" })], {
    tokenProgram: "token-2022",
    mintExtensionTypes: [25],
  });
  assert.equal(result.amountCoverage.state, "complete");
  assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, []);
  assert.equal(result.concentration.top1.status, "available");
  assert.equal(result.concentration.top1.percentage, "1.000000");
});

test("marks unknown structurally valid Token-2022 account extensions as partial", () => {
  const result = normalize([account(1, "10", { program: "token-2022", extension: { type: 99 } })], {
    tokenProgram: "token-2022",
  });
  assert.deepEqual(result.amountCoverage.unsupportedExtensionTypes, [99]);
  assert.equal(result.amountCoverage.state, "partial");
  assert.equal(result.amountCoverage.reason, "unsupported_balance_affecting_extension");
  assert.equal(result.concentration.top1.status, "unavailable");
});

test("rounds an exact half-unit percentage boundary up to six decimal places", () => {
  const result = normalize([account(1, "1")], { currentMintSupplyRaw: "200000000" });
  assert.equal(result.concentration.top1.percentage, "0.000001");
});

test("formats concentration for a numerator exactly one raw unit below supply", () => {
  const result = normalize([account(1, "999999")], { currentMintSupplyRaw: "1000000" });
  assert.equal(result.concentration.top1.percentage, "99.999900");
});

test("rejects malformed Token-2022 TLV and wrong account discriminator", () => {
  const row = account(1, "10", { program: "token-2022", extension: { type: 7 } });
  const bytes = Buffer.from(row.dataBase64, "base64");
  bytes[165] = 1;
  row.dataBase64 = bytes.toString("base64");
  assert.throws(() => normalize([row], { tokenProgram: "token-2022" }), /layout/);
  bytes[165] = 2;
  bytes.writeUInt16LE(9, 168);
  row.dataBase64 = bytes.toString("base64");
  assert.throws(() => normalize([row], { tokenProgram: "token-2022" }), /malformed extension/);
});

test("rejects a truncated Token-2022 token-account TLV header", () => {
  const row = account(1, "10", { program: "token-2022", extension: { type: 7 } });
  const bytes = Buffer.from(row.dataBase64, "base64").subarray(0, 168);
  row.dataBase64 = bytes.toString("base64");
  row.reportedSpace = bytes.length;
  assert.throws(() => normalize([row], { tokenProgram: "token-2022" }), /malformed extension/);
});

test("rejects a token account with the wrong outer program owner", () => {
  const row = account(1, "10", { program: "token-2022" });
  assert.throws(() => normalize([row]), /unexpected token program/);
});

test("retains exact maximum u64 token-account amount", () => {
  const result = normalize([account(1, "18446744073709551615")], {
    currentMintSupplyRaw: "18446744073709551615",
  });
  assert.equal(result.rawOwnerAuthorities[0].balanceRaw, "18446744073709551615");
  assert.equal(result.concentration.top1.percentage, "100.000000");
});

test("returns deterministic extension type set and timestamp fields", () => {
  const result = normalize([account(1, "0")]);
  assert.equal(result.fetchedAt, FETCHED_AT);
  assert.equal(result.amountCoverage.reason, null);
  assert.deepEqual(result.enumeration.contextSlots, [123]);
});
