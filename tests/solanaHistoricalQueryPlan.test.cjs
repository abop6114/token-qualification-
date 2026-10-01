const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSolanaHistoricalQueryPlan } = require("../dist/normalization/solanaHistoricalQueryPlan.js");
const { selectSolanaHistoricalAuthorities } = require("../dist/normalization/solanaHistoricalAuthoritySelector.js");
const { encodeSolanaPublicKey } = require("../dist/validation/solanaAddress.js");

const key = (byte) => encodeSolanaPublicKey(Buffer.alloc(32, byte));
const MINT = key(42);
const WINDOW = { fromUnixSecondsInclusive: 1_700_000_000, toUnixSecondsExclusive: 1_700_086_400 };

function holderStructure(balances, overrides = {}) {
  const rawOwnerAuthorities = balances.map((balanceRaw, index) => ({
    ownerAddress: key(index + 1),
    balanceRaw: String(balanceRaw),
    tokenAccountCount: 1,
  }));
  return {
    chain: "solana",
    mintAddress: MINT,
    tokenProgram: "spl-token",
    decimals: 6,
    currentMintSupplyRaw: "1000000000",
    observedPositiveBalanceRaw: "100",
    supplyDifferenceRaw: "999999900",
    fetchedAt: "2026-10-01T12:00:00.000Z",
    enumeration: { completeness: "complete", slotConsistency: "not_guaranteed", pageCount: 2, contextSlots: [100, 101] },
    tokenAccountCount: rawOwnerAuthorities.length,
    nonzeroTokenAccountCount: rawOwnerAuthorities.length,
    tokenAccountStateSummary: {
      initialized: { tokenAccountCount: rawOwnerAuthorities.length, positiveBalanceTokenAccountCount: rawOwnerAuthorities.length, observedBalanceRaw: "100" },
      frozen: { tokenAccountCount: 0, positiveBalanceTokenAccountCount: 0, observedBalanceRaw: "0" },
    },
    rawOwnerCount: rawOwnerAuthorities.length,
    rawOwnerAuthorities,
    amountCoverage: { state: "complete", unsupportedExtensionTypes: [], reason: null },
    concentration: {},
    ...overrides,
  };
}

function planInput(balances, authorityCap = 2) {
  const holder = holderStructure(balances);
  const selection = selectSolanaHistoricalAuthorities(holder, authorityCap);
  return {
    holderStructure: holder,
    selection,
    requestedWindow: { ...WINDOW },
    maxPagesPerAuthority: 3,
    maxRecordsPerAuthority: 50,
  };
}

function makePlan(input) {
  return buildSolanaHistoricalQueryPlan(input);
}

test("validates inclusive/exclusive Unix bounds", () => {
  for (const requestedWindow of [
    { fromUnixSecondsInclusive: -1, toUnixSecondsExclusive: 10 },
    { fromUnixSecondsInclusive: 1.5, toUnixSecondsExclusive: 10 },
    { fromUnixSecondsInclusive: Number.MAX_SAFE_INTEGER + 1, toUnixSecondsExclusive: Number.MAX_SAFE_INTEGER + 2 },
    { fromUnixSecondsInclusive: 0, toUnixSecondsExclusive: -1 },
    { fromUnixSecondsInclusive: 0, toUnixSecondsExclusive: 1.5 },
    { fromUnixSecondsInclusive: 0, toUnixSecondsExclusive: Number.MAX_SAFE_INTEGER + 1 },
    { fromUnixSecondsInclusive: 10, toUnixSecondsExclusive: 10 },
    { fromUnixSecondsInclusive: 11, toUnixSecondsExclusive: 10 },
  ]) {
    const input = planInput([3]);
    input.requestedWindow = requestedWindow;
    assert.throws(() => makePlan(input), /time window/);
  }
});

test("validates positive safe page and record caps", () => {
  for (const cap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const pageInput = planInput([3]);
    pageInput.maxPagesPerAuthority = cap;
    assert.throws(() => makePlan(pageInput), /maxPagesPerAuthority/);

    const recordInput = planInput([3]);
    recordInput.maxRecordsPerAuthority = cap;
    assert.throws(() => makePlan(recordInput), /maxRecordsPerAuthority/);
  }
});

test("plans zero selected authorities while retaining an empty candidate frame and zero bounds", () => {
  const result = makePlan(planInput([], 4));
  assert.equal(result.selectedAuthorityCount, 0);
  assert.equal(result.maximumProviderRequests, 0);
  assert.equal(result.maximumReturnedRecords, 0);
  assert.deepEqual(result.candidateAuthorities, []);
});

test("plans one selected authority with its configured caps", () => {
  const result = makePlan(planInput([8], 1));
  assert.equal(result.selectedAuthorityCount, 1);
  assert.equal(result.maximumProviderRequests, 3);
  assert.equal(result.maximumReturnedRecords, 50);
  assert.equal(result.candidateAuthorities[0].plannedDisposition.status, "selected");
});

test("preserves the entire candidate frame when all authorities are selected", () => {
  const result = makePlan(planInput([2, 7, 4], 3));
  assert.equal(result.sourceHolder.candidateAuthorityCount, 3);
  assert.equal(result.candidateAuthorities.length, 3);
  assert.ok(result.candidateAuthorities.every((candidate) => candidate.plannedDisposition.status === "selected"));
});

test("preserves selected and not-selected dispositions for a subset plan", () => {
  const result = makePlan(planInput([1, 9, 3, 7, 5], 2));
  assert.equal(result.candidateAuthorities.length, 5);
  assert.equal(result.selectedAuthorityCount, 2);
  assert.equal(result.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "selected").length, 2);
  assert.equal(result.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "not_selected").length, 3);
  assert.ok(result.candidateAuthorities.filter((candidate) => candidate.plannedDisposition.status === "not_selected").every((candidate) =>
    !("activity" in candidate) && !("queryResult" in candidate)));
});

test("calculates exact maximum request and returned-record bounds", () => {
  const result = makePlan(planInput([4, 1, 8, 2], 2));
  assert.equal(result.maximumProviderRequests, 2 * 3);
  assert.equal(result.maximumReturnedRecords, 2 * 50);
});

test("rejects overflow in maximum provider requests and maximum returned records", () => {
  const requestOverflow = planInput([1, 2, 3], 2);
  requestOverflow.maxPagesPerAuthority = Number.MAX_SAFE_INTEGER;
  assert.throws(() => makePlan(requestOverflow), /Maximum provider request count exceeds/);

  const recordOverflow = planInput([1, 2, 3], 2);
  recordOverflow.maxRecordsPerAuthority = Number.MAX_SAFE_INTEGER;
  assert.throws(() => makePlan(recordOverflow), /Maximum returned record count exceeds/);
});

test("reconstructs ranks from a permuted holder candidate frame", () => {
  const input = planInput([2, 100, 4, 8, 16, 32]);
  const expected = makePlan(input);
  input.holderStructure.rawOwnerAuthorities.reverse();
  const actual = makePlan(input);
  assert.deepEqual(actual.candidateAuthorities, expected.candidateAuthorities);
});

test("rejects mint and snapshot-time mismatches", () => {
  const mintMismatch = planInput([1, 2]);
  mintMismatch.holderStructure.mintAddress = key(99);
  assert.throws(() => makePlan(mintMismatch), /mint does not match/);

  const timeMismatch = planInput([1, 2]);
  timeMismatch.holderStructure.fetchedAt = "2026-10-02T12:00:00.000Z";
  assert.throws(() => makePlan(timeMismatch), /snapshot time does not match/);
});

test("rejects candidate-count and source-coverage mismatches", () => {
  const countMismatch = planInput([1, 2]);
  countMismatch.holderStructure.rawOwnerCount = 3;
  assert.throws(() => makePlan(countMismatch), /count does not match/);

  const frameMismatch = planInput([1, 2]);
  frameMismatch.selection.candidateAuthorityCount = 3;
  assert.throws(() => makePlan(frameMismatch), /Selection counts/);

  const coverageMismatch = planInput([1, 2]);
  coverageMismatch.selection.sourceCoverage.enumeration.contextSlots[0] += 1;
  assert.throws(() => makePlan(coverageMismatch), /source coverage does not match/);

  const amountCoverageMismatch = planInput([1, 2]);
  amountCoverageMismatch.selection.sourceCoverage.amountCoverage.state = "partial";
  assert.throws(() => makePlan(amountCoverageMismatch), /source coverage does not match/);
});

test("rejects a selected authority absent from the holder frame", () => {
  const input = planInput([1, 2]);
  input.selection.selectedAuthorities[0].authorityAddress = key(99);
  assert.throws(() => makePlan(input), /absent from the holder candidate frame/);
});

test("rejects selected balance and source-rank mismatches", () => {
  const balanceMismatch = planInput([1, 2]);
  balanceMismatch.selection.selectedAuthorities[0].balanceRaw = "999";
  assert.throws(() => makePlan(balanceMismatch), /balance does not match/);

  const rankMismatch = planInput([1, 2]);
  rankMismatch.selection.selectedAuthorities[0].sourceRank = 1;
  assert.throws(() => makePlan(rankMismatch), /source rank does not match/);
});

test("rejects duplicate selected authorities and source ranks", () => {
  const input = planInput([1, 2, 3], 3);
  input.selection.selectedAuthorities[1] = { ...input.selection.selectedAuthorities[0] };
  assert.throws(() => makePlan(input), /duplicate authority, source rank, or selection position/);
});

test("rejects invalid, duplicate, and noncontiguous selection positions", () => {
  const invalid = planInput([1, 2, 3], 2);
  invalid.selection.selectedAuthorities[0].selectionPosition = -1;
  assert.throws(() => makePlan(invalid), /invalid selection position/);

  const duplicate = planInput([1, 2, 3], 2);
  duplicate.selection.selectedAuthorities[1].selectionPosition = duplicate.selection.selectedAuthorities[0].selectionPosition;
  assert.throws(() => makePlan(duplicate), /duplicate authority, source rank, or selection position/);

  const gap = planInput([1, 2, 3], 2);
  gap.selection.selectedAuthorities[0].selectionPosition = 1;
  gap.selection.selectedAuthorities[1].selectionPosition = 2;
  assert.throws(() => makePlan(gap), /invalid selection position|contiguous/);
});

test("rejects selection count, cap, and minimum-count invariant mismatches", () => {
  const countMismatch = planInput([1, 2, 3], 2);
  countMismatch.selection.selectedAuthorityCount = 1;
  assert.throws(() => makePlan(countMismatch), /Selection counts/);

  const overCap = planInput([1, 2, 3], 2);
  overCap.selection.configuredMaximumSelectedAuthorityCount = 1;
  assert.throws(() => makePlan(overCap), /Selection counts/);

  const underSelected = planInput([1, 2, 3], 2);
  underSelected.selection.selectedAuthorities.pop();
  underSelected.selection.selectedAuthorityCount -= 1;
  assert.throws(() => makePlan(underSelected), /Selection counts/);
});

test("rejects malformed or duplicate holder authorities and zero or malformed balances", () => {
  const malformedAddress = planInput([1]);
  malformedAddress.holderStructure.rawOwnerAuthorities[0].ownerAddress = "bad-address";
  assert.throws(() => makePlan(malformedAddress), /malformed owner-authority/);

  const duplicateAddress = planInput([1, 2]);
  duplicateAddress.holderStructure.rawOwnerAuthorities[1].ownerAddress = duplicateAddress.holderStructure.rawOwnerAuthorities[0].ownerAddress;
  assert.throws(() => makePlan(duplicateAddress), /duplicate owner-authority/);

  for (const balanceRaw of ["0", "", "-1", "1.5", "01", " 1"]) {
    const malformedBalance = planInput([1]);
    malformedBalance.holderStructure.rawOwnerAuthorities[0].balanceRaw = balanceRaw;
    assert.throws(() => makePlan(malformedBalance), /canonical positive raw integer string/);
  }
});

test("preserves source coverage and window provenance", () => {
  const input = planInput([1, 2, 3], 2);
  input.holderStructure.amountCoverage = {
    state: "partial",
    unsupportedExtensionTypes: [4, 24],
    reason: "unsupported_balance_affecting_extension",
  };
  input.selection.sourceCoverage.amountCoverage = structuredClone(input.holderStructure.amountCoverage);
  const result = makePlan(input);
  assert.deepEqual(result.requestedWindow, WINDOW);
  assert.deepEqual(result.sourceHolder.enumeration, input.holderStructure.enumeration);
  assert.deepEqual(result.sourceHolder.amountCoverage, input.holderStructure.amountCoverage);
  assert.equal(result.sourceHolder.fetchedAt, input.holderStructure.fetchedAt);
});

test("identical inputs produce identical plans", () => {
  const input = planInput([1, 8, 3, 4, 5]);
  assert.deepEqual(makePlan(input), makePlan(input));
});

test("does not mutate holder, selection, or time-window inputs", () => {
  const input = planInput([1, 8, 3, 4, 5]);
  const before = structuredClone(input);
  makePlan(input);
  assert.deepEqual(input, before);
});

test("plan contains no provider observations or execution outcomes", () => {
  const result = makePlan(planInput([1, 2, 3], 2));
  assert.equal("provider" in result, false);
  assert.equal("method" in result, false);
  assert.equal("observations" in result, false);
  assert.equal("outcomes" in result, false);
});
