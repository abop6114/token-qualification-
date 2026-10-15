const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getSolanaProviderRequestBudgetEnvelope } = require("../dist/application/solanaProviderRequestBudgetEnvelope.js");
const {
  SOLANA_HISTORICAL_MAX_PAGES_PER_AUTHORITY,
  SOLANA_HISTORICAL_MAX_SELECTED_AUTHORITIES,
} = require("../dist/application/solanaTokenEvidenceReport.js");
const { SOLANA_TOKEN_ACCOUNT_MAX_PAGES } = require("../dist/providers/solana/heliusTokenAccounts.js");
const { SOLANA_HISTORICAL_TRANSACTION_SIGNATURE_CAP } = require("../dist/normalization/solanaHistoricalTransactionSelector.js");

test("computes the fixed 22-request envelope when history is not requested", () => {
  assert.equal(getSolanaProviderRequestBudgetEnvelope({
    chain: "solana", assetAddress: "11111111111111111111111111111111",
    historicalTransactions: { status: "not_requested" },
  }), 22);
});

test("computes the fixed 29-request envelope from authoritative built-in limits when history is requested", () => {
  assert.equal(SOLANA_TOKEN_ACCOUNT_MAX_PAGES, 20);
  assert.equal(SOLANA_HISTORICAL_MAX_SELECTED_AUTHORITIES, 1);
  assert.equal(SOLANA_HISTORICAL_MAX_PAGES_PER_AUTHORITY, 2);
  assert.equal(SOLANA_HISTORICAL_TRANSACTION_SIGNATURE_CAP, 5);
  assert.equal(getSolanaProviderRequestBudgetEnvelope({
    chain: "solana", assetAddress: "11111111111111111111111111111111",
    historicalTransactions: { status: "requested", requestedWindow: {
      fromUnixSecondsInclusive: 1, toUnixSecondsExclusive: 2,
    } },
  }), 29);
});

test("does not accept public JSON or malformed historical status as an envelope override", () => {
  for (const input of [null, {}, { historicalTransactions: { status: "other" } }]) {
    assert.throws(() => getSolanaProviderRequestBudgetEnvelope(input), TypeError);
  }
});
