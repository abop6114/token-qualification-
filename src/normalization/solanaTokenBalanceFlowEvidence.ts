import { isSolanaPublicKeySyntax, isSolanaTransactionSignatureSyntax } from "../validation/solanaAddress";
import type { SolanaTokenBalanceObservation, SolanaTokenBalanceSide, SolanaTransactionEvidence } from "../types/solanaTransactionEvidence";
import type { SolanaHistoricalTransactionSelectionEvidence } from "../types/solanaHistoricalTransactionSelection";
import type {
  SolanaTokenBalanceFlowConflict,
  SolanaTokenBalanceFlowDelta,
  SolanaTokenBalanceFlowEvidence,
  SolanaTokenBalanceFlowField,
  SolanaTokenBalanceFlowPair,
  SolanaTokenBalanceFlowPhase2AContext,
  SolanaTokenBalanceFlowPhase2ALinkage,
  SolanaTokenBalanceFlowRawAmount,
  SolanaTokenBalanceFlowReason,
  SolanaTokenBalanceFlowUnmatchedObservation,
} from "../types/solanaTokenBalanceFlowEvidence";

type Side = "pre" | "post";
type Row = { side: Side; observation: SolanaTokenBalanceObservation };
type Identity = { accountIndex: number; mint: string; key: string };
type ExecutionState = "succeeded" | "failed" | "unavailable" | "conflicting";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const REASON_ORDER: readonly SolanaTokenBalanceFlowReason[] = [
  "transaction_failed", "execution_state_unavailable", "execution_state_conflicting", "balance_side_unavailable",
  "balance_side_conflicting", "account_space_conflicting",
  "invalid_pair_identity", "duplicate_pair_key", "account_index_multiple_mints", "unmatched_pre", "unmatched_post",
  "amount_unavailable", "amount_not_exact", "amount_evidence_conflicting", "decimals_unavailable",
  "decimals_mismatch", "decimals_evidence_conflicting", "unresolved_account_address", "account_address_mismatch",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Solana transaction evidence for balance-flow normalization: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeDecimals(value: unknown): value is number {
  return safeIndex(value) && value <= 255;
}

function tokenField<T>(value: unknown, isValid: (candidate: unknown) => candidate is T): SolanaTokenBalanceFlowField<T> {
  if (!isRecord(value) || (value.status !== "available" && value.status !== "unavailable")) {
    return { status: "unavailable", value: null, reason: "malformed" };
  }
  if (value.status === "available") {
    return isValid(value.value)
      ? { status: "available", value: value.value }
      : { status: "unavailable", value: null, reason: "malformed" };
  }
  const reason = value.reason;
  if (reason === "missing" || reason === "null" || reason === "malformed" || reason === "unresolved_account") {
    return { status: "unavailable", value: null, reason };
  }
  return { status: "unavailable", value: null, reason: "malformed" };
}

function identity(observation: SolanaTokenBalanceObservation): Identity | null {
  const index = tokenField(observation.accountIndex, safeIndex);
  const mint = tokenField(observation.mint, (value): value is string => typeof value === "string" && isSolanaPublicKeySyntax(value));
  if (index.status !== "available" || mint.status !== "available") return null;
  return { accountIndex: index.value, mint: mint.value, key: `${index.value}\u0000${mint.value}` };
}

type AmountResult =
  | { kind: "exact"; value: string }
  | { kind: "non_exact"; reason: "amount_unavailable" | "amount_not_exact" }
  | { kind: "conflicting" };

const AMOUNT_TYPES = new Set(["integer_string", "non_integer_string", "safe_integer_number", "non_integer_number", "unsafe_integer_number", "null", "missing"]);

function canonicalNumberRepresentation(value: unknown, kind: "safe_integer" | "non_integer"): boolean {
  if (typeof value !== "string") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && String(parsed) === value &&
    (kind === "safe_integer" ? Number.isSafeInteger(parsed) : !Number.isInteger(parsed));
}

function amountEvidenceResult(field: unknown): AmountResult {
  if (!isRecord(field) || (field.status !== "available" && field.status !== "unavailable")) return { kind: "conflicting" };
  if (field.status === "unavailable") {
    return field.evidence === null && (field.reason === "missing" || field.reason === "null" || field.reason === "malformed")
      ? { kind: "non_exact", reason: "amount_unavailable" }
      : { kind: "conflicting" };
  }
  if (!isRecord(field.evidence)) return { kind: "conflicting" };
  const value = field.evidence as unknown as Record<string, unknown>;
  const type = value.reportedAmountType;
  if (typeof type !== "string" || !AMOUNT_TYPES.has(type)) return { kind: "conflicting" };
  if (type === "integer_string") {
    if (typeof value.rawAmount !== "string" || !/^[0-9]+$/.test(value.rawAmount) || value.exactRawAvailable !== true ||
      value.exactnessBasis !== "provider_integer_string" || value.unavailableReason !== null || value.reportedAmount !== value.rawAmount) {
      return { kind: "conflicting" };
    }
    return { kind: "exact", value: value.rawAmount };
  }
  const expectedReason = type === "null" || type === "missing" ? "not_reported" : "provider_representation_not_exact";
  let reportedValid = false;
  if (type === "non_integer_string") reportedValid = typeof value.reportedAmount === "string" && value.reportedAmount.length > 0 && !/^[0-9]+$/.test(value.reportedAmount);
  else if (type === "safe_integer_number") reportedValid = canonicalNumberRepresentation(value.reportedAmount, "safe_integer");
  else if (type === "non_integer_number") reportedValid = canonicalNumberRepresentation(value.reportedAmount, "non_integer");
  else reportedValid = value.reportedAmount === null;
  if (value.rawAmount !== null || value.exactRawAvailable !== false || value.exactnessBasis !== null ||
    value.unavailableReason !== expectedReason || !reportedValid) return { kind: "conflicting" };
  return { kind: "non_exact", reason: type === "missing" || type === "null" ? "amount_unavailable" : "amount_not_exact" };
}

function rawAmount(result: AmountResult): SolanaTokenBalanceFlowRawAmount {
  return result.kind === "exact"
    ? { status: "available", value: result.value, basis: "provider_integer_string" }
    : { status: "unavailable", value: null, reason: result.kind === "conflicting" ? "amount_evidence_conflicting" : result.reason };
}

function decimalsField(observation: SolanaTokenBalanceObservation): SolanaTokenBalanceFlowField<number> {
  return tokenField(observation.decimals, safeDecimals);
}

function ownerField(observation: SolanaTokenBalanceObservation): SolanaTokenBalanceFlowField<string> {
  return tokenField(observation.owner, (value): value is string => typeof value === "string" && isSolanaPublicKeySyntax(value));
}

function addressField(observation: SolanaTokenBalanceObservation): SolanaTokenBalanceFlowField<string> {
  return tokenField(observation.tokenAccountAddress, (value): value is string => typeof value === "string" && isSolanaPublicKeySyntax(value));
}

function rowsFor(side: Side, value: SolanaTokenBalanceSide): Row[] {
  if (value.status === "unavailable") return [];
  return value.entries.map((entry) => ({ side, observation: entry.observation }));
}

function executionState(value: unknown): { state: ExecutionState; reason: SolanaTokenBalanceFlowReason | null } {
  if (!isRecord(value)) return { state: "unavailable", reason: "execution_state_unavailable" };
  if (value.status === "succeeded") return value.basis === "provider_meta_err_null" && exactKeys(value, ["status", "basis"])
    ? { state: "succeeded", reason: null } : { state: "conflicting", reason: "execution_state_conflicting" };
  if (value.status === "failed") return value.basis === "provider_meta_err_non_null" && exactKeys(value, ["status", "basis", "reportedError"]) &&
    value.reportedError !== null && isJsonValue(value.reportedError)
    ? { state: "failed", reason: "transaction_failed" } : { state: "conflicting", reason: "execution_state_conflicting" };
  if (value.status === "unavailable") {
    return exactKeys(value, ["status", "reason"]) && ["meta_missing", "meta_null", "meta_malformed", "err_missing"].includes(String(value.reason))
      ? { state: "unavailable", reason: "execution_state_unavailable" }
      : { state: "conflicting", reason: "execution_state_conflicting" };
  }
  return { state: "conflicting", reason: "execution_state_conflicting" };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

// Phase 2A fingerprint syntax and linkage are checked structurally here; this
// consumer does not recompute the fingerprint or claim cryptographic re-verification.
function validatePhase2ALinkage(
  signature: string,
  context: SolanaTokenBalanceFlowPhase2AContext | undefined,
): SolanaTokenBalanceFlowPhase2ALinkage | null {
  if (context === undefined) return null;
  const selection = context.selection;
  const request = context.transactionRequest;
  assert(isRecord(selection) && selection.schemaVersion === "solana-historical-transaction-selection-v1" && selection.chain === "solana" &&
    typeof selection.sourceFingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(selection.sourceFingerprint) &&
    selection.signatureCap === 5 && selection.selectionCompleteness === "complete" &&
    (selection.sourceHistoricalPlanVersion === "solana-bounded-history-query-plan-v1" || selection.sourceHistoricalPlanVersion === "solana-bounded-history-query-plan-v2") &&
    isRecord(selection.requestedWindow) && safeIndex(selection.requestedWindow.fromUnixSecondsInclusive) &&
    safeIndex(selection.requestedWindow.toUnixSecondsExclusive) && selection.requestedWindow.fromUnixSecondsInclusive < selection.requestedWindow.toUnixSecondsExclusive &&
    typeof selection.sourceEvidenceFetchedAt === "string" && Number.isFinite(Date.parse(selection.sourceEvidenceFetchedAt)) &&
    isRecord(selection.sourceCoverage) && ["complete", "partial", "unknown"].includes(String(selection.sourceCoverage.holderCandidateFrameCompleteness)) &&
    ["complete", "partial"].includes(String(selection.sourceCoverage.signatureSourceCompleteness)) &&
    (["candidateAuthorityCount", "selectedAuthorityCount", "naturallyCompleteAuthorityCount", "truncatedAuthorityCount", "providerErrorAuthorityCount", "unqueriedAuthorityCount"] as const)
      .every((field) => safeIndex(selection.sourceCoverage[field])) &&
    safeIndex(selection.uniqueSignatureCount) && safeIndex(selection.selectedUniqueSignatureCount) &&
    selection.selectedUniqueSignatureCount <= 5 && Array.isArray(selection.candidates) &&
    selection.candidates.every((candidate) => isRecord(candidate) && typeof candidate.signature === "string" &&
      isSolanaTransactionSignatureSyntax(candidate.signature) && isRecord(candidate.disposition) &&
      Array.isArray(candidate.sourceObservations)),
  "Phase 2A selection context is malformed");
  const matching = selection.candidates.filter((candidate) => candidate.signature === signature);
  assert(matching.length === 1 && matching[0].disposition.status === "selected" &&
    safeIndex(matching[0].disposition.selectionPosition) && matching[0].disposition.selectionPosition < 5 &&
    Array.isArray(matching[0].sourceObservations) && matching[0].sourceObservations.length > 0 &&
    matching[0].sourceObservations.every((reference) => isRecord(reference) && reference.sourceFingerprint === selection.sourceFingerprint &&
      typeof reference.authorityAddress === "string" && isSolanaPublicKeySyntax(reference.authorityAddress) &&
      safeIndex(reference.authoritySelectionPosition) && safeIndex(reference.historicalObservationIndex) &&
      isRecord(reference.rank) && (reference.rank.basis === "sourceRank" || reference.rank.basis === "observedCandidateFrameRank") &&
      safeIndex(reference.rank.value)),
  "Phase 2A selected-signature linkage is inconsistent");
  assert(isRecord(request) && request.chain === "solana" && request.provider === "helius" && request.method === "getTransaction" &&
    request.encoding === "json" && request.commitment === "finalized" && request.maxSupportedTransactionVersion === 0 &&
    request.requestedSignature === signature && typeof request.fetchedAt === "string" && Number.isFinite(Date.parse(request.fetchedAt)),
  "Phase 2A transaction request provenance is inconsistent");
  const sourceObservations = matching[0].sourceObservations.map((reference) => ({
    sourceFingerprint: reference.sourceFingerprint,
    authorityAddress: reference.authorityAddress,
    authoritySelectionPosition: reference.authoritySelectionPosition,
    historicalObservationIndex: reference.historicalObservationIndex,
    rank: { ...reference.rank },
  }));
  return {
    sourceFingerprint: selection.sourceFingerprint,
    sourceHistoricalPlanVersion: selection.sourceHistoricalPlanVersion,
    requestedWindow: { ...selection.requestedWindow },
    sourceEvidenceFetchedAt: selection.sourceEvidenceFetchedAt,
    signatureCap: 5,
    selectionPosition: matching[0].disposition.selectionPosition,
    sourceObservations,
    sourceCoverage: structuredClone(selection.sourceCoverage),
    transactionRequest: {
      chain: request.chain,
      provider: request.provider,
      method: request.method,
      encoding: request.encoding,
      commitment: request.commitment,
      maxSupportedTransactionVersion: request.maxSupportedTransactionVersion,
      requestedSignature: request.requestedSignature,
      fetchedAt: request.fetchedAt,
    },
  };
}

function validateTransaction(value: unknown): { balanceSideConflict: boolean; accountSpaceConflict: boolean } {
  assert(isRecord(value) && Array.isArray(value.signatures) && value.signatures.length > 0 &&
    value.signatures.every((signature) => typeof signature === "string" && isSolanaTransactionSignatureSyntax(signature)) &&
    isRecord(value.tokenBalances) && isRecord(value.accountSpace) && Array.isArray(value.accountSpace.accounts) &&
    ["complete", "partial", "unavailable"].includes(String(value.accountSpace.status)), "transaction evidence is malformed");
  assert(value.accountSpace.accounts.every((account) => isRecord(account) && safeIndex(account.accountIndex) &&
    typeof account.address === "string" && isSolanaPublicKeySyntax(account.address)), "transaction account address space is malformed");
  const sourceOrder: Record<string, number> = { static: 0, loaded_writable: 1, loaded_readonly: 2 };
  const accountSpace = value.accountSpace as unknown as SolanaTransactionEvidence["accountSpace"];
  const accountSpaceConflict = accountSpace.canonicalOrder !== "static_loaded_writable_loaded_readonly" ||
    accountSpace.accounts.some((account, index, accounts) =>
      account.accountIndex !== index || !Object.hasOwn(sourceOrder, account.source) ||
      (index > 0 && sourceOrder[account.source] < sourceOrder[accounts[index - 1].source]) ||
      (accountSpace.status !== "complete" && account.source !== "static") ||
      accounts.some((other, otherIndex) => otherIndex !== index && other.address === account.address));
  let balanceSideConflict = false;
  for (const side of [value.tokenBalances.pre, value.tokenBalances.post]) {
    assert(isRecord(side) && ["available", "partial", "unavailable"].includes(String(side.status)), "token-balance side is malformed");
    if (side.status === "unavailable") {
      assert(Array.isArray(side.entries) && side.entries.length === 0 && side.reportedEntryCount === null &&
        ["meta_missing", "meta_null", "meta_malformed", "field_missing", "field_null", "malformed"].includes(String(side.reason)),
      "unavailable token-balance side is inconsistent");
      continue;
    }
    assert(Array.isArray(side.entries) && Number.isSafeInteger(side.reportedEntryCount) && side.reportedEntryCount === side.entries.length,
      "token-balance side count is inconsistent");
    for (let rowIndex = 0; rowIndex < side.entries.length; rowIndex += 1) {
      const entry = side.entries[rowIndex];
      assert(isRecord(entry) && (entry.status === "available" || entry.status === "partial") && isRecord(entry.observation) &&
        safeIndex(entry.observation.providerArrayIndex), "token-balance row is malformed");
      if (entry.observation.providerArrayIndex !== rowIndex) balanceSideConflict = true;
      const observation = entry.observation;
      const fields = [observation.accountIndex, observation.tokenAccountAddress, observation.mint, observation.owner, observation.amount, observation.decimals];
      const fieldsAllAvailable = fields.every((field) => isRecord(field) && field.status === "available");
      if ((entry.status === "available") !== fieldsAllAvailable) balanceSideConflict = true;
    }
    const allEntriesAvailable = side.entries.every((entry) => isRecord(entry) && entry.status === "available");
    if ((side.status === "available") !== allEntriesAvailable) balanceSideConflict = true;
  }
  return { balanceSideConflict, accountSpaceConflict };
}

function addReason(set: Set<SolanaTokenBalanceFlowReason>, reason: SolanaTokenBalanceFlowReason): void {
  set.add(reason);
}

function makePair(
  pre: Row,
  post: Row,
  id: Identity,
  accounts: SolanaTransactionEvidence["accountSpace"]["accounts"],
  reasons: Set<SolanaTokenBalanceFlowReason>,
  execution: ExecutionState,
  balanceSideConflict: boolean,
  accountSpaceConflict: boolean,
): { pair: SolanaTokenBalanceFlowPair; conflicts: Array<"account_address_mismatch" | "decimals_mismatch" | "amount_evidence_conflicting" | "decimals_evidence_conflicting"> } {
  const preAddress = addressField(pre.observation);
  const postAddress = addressField(post.observation);
  const preRaw = amountEvidenceResult(pre.observation.amount);
  const postRaw = amountEvidenceResult(post.observation.amount);
  const preDecimals = decimalsField(pre.observation);
  const postDecimals = decimalsField(post.observation);
  const preOwner = ownerField(pre.observation);
  const postOwner = ownerField(post.observation);
  const pairConflicts = new Set<"account_address_mismatch" | "decimals_mismatch" | "amount_evidence_conflicting" | "decimals_evidence_conflicting">();

  const accountEntries = accounts.filter((account) => account.accountIndex === id.accountIndex);
  const resolvedValues = [preAddress, postAddress].filter((field) => field.status === "available");
  if ([preAddress, postAddress].some((field) => field.status === "unavailable" && field.reason !== "unresolved_account")) {
    pairConflicts.add("account_address_mismatch");
  }
  if (resolvedValues.length > 0) {
    if (accountEntries.length !== 1 || resolvedValues.some((field) => field.value !== accountEntries[0]?.address)) {
      pairConflicts.add("account_address_mismatch");
    }
    if ((preAddress.status === "available") !== (postAddress.status === "available")) pairConflicts.add("account_address_mismatch");
    if (preAddress.status === "available" && postAddress.status === "available" && preAddress.value !== postAddress.value) pairConflicts.add("account_address_mismatch");
  } else {
    addReason(reasons, "unresolved_account_address");
  }
  if (preDecimals.status === "available" && postDecimals.status === "available" && preDecimals.value !== postDecimals.value) pairConflicts.add("decimals_mismatch");
  if ((preDecimals.status === "unavailable" && preDecimals.reason !== "malformed") ||
    (postDecimals.status === "unavailable" && postDecimals.reason !== "malformed")) addReason(reasons, "decimals_unavailable");
  if ((preDecimals.status === "unavailable" && preDecimals.reason === "malformed") ||
    (postDecimals.status === "unavailable" && postDecimals.reason === "malformed")) pairConflicts.add("decimals_evidence_conflicting");
  if (preRaw.kind === "conflicting" || postRaw.kind === "conflicting") pairConflicts.add("amount_evidence_conflicting");
  if (preRaw.kind === "non_exact") addReason(reasons, preRaw.reason);
  if (postRaw.kind === "non_exact") addReason(reasons, postRaw.reason);
  for (const conflict of pairConflicts) addReason(reasons, conflict);
  if (pairConflicts.has("decimals_mismatch")) addReason(reasons, "decimals_mismatch");

  const consistentDecimals = preDecimals.status === "available" && postDecimals.status === "available" && preDecimals.value === postDecimals.value;
  const decimals = consistentDecimals ? { status: "available" as const, value: preDecimals.value }
    : { status: "unavailable" as const, value: null };
  let rawDelta: SolanaTokenBalanceFlowDelta;
  if (execution === "failed") rawDelta = { status: "unavailable", value: null, reason: "transaction_failed" };
  else if (execution === "unavailable") rawDelta = { status: "unavailable", value: null, reason: "execution_state_unavailable" };
  else if (execution === "conflicting") rawDelta = { status: "unavailable", value: null, reason: "execution_state_conflicting" };
  else if (accountSpaceConflict) rawDelta = { status: "unavailable", value: null, reason: "account_space_conflicting" };
  else if (balanceSideConflict) rawDelta = { status: "unavailable", value: null, reason: "balance_side_conflicting" };
  else if (pairConflicts.has("account_address_mismatch")) rawDelta = { status: "unavailable", value: null, reason: "account_address_mismatch" };
  else if (pairConflicts.has("decimals_mismatch")) rawDelta = { status: "unavailable", value: null, reason: "decimals_mismatch" };
  else if (pairConflicts.has("amount_evidence_conflicting")) rawDelta = { status: "unavailable", value: null, reason: "amount_evidence_conflicting" };
  else if (pairConflicts.has("decimals_evidence_conflicting")) rawDelta = { status: "unavailable", value: null, reason: "decimals_evidence_conflicting" };
  else if (preRaw.kind !== "exact" || postRaw.kind !== "exact") {
    const reason = preRaw.kind === "non_exact" ? preRaw.reason : postRaw.kind === "non_exact" ? postRaw.reason : "amount_unavailable";
    rawDelta = { status: "unavailable", value: null, reason };
  } else if (!consistentDecimals) {
    const reason = pairConflicts.has("decimals_evidence_conflicting") ? "decimals_evidence_conflicting" : "decimals_unavailable";
    addReason(reasons, reason);
    rawDelta = { status: "unavailable", value: null, reason };
  } else {
    rawDelta = { status: "available", value: (BigInt(postRaw.value) - BigInt(preRaw.value)).toString(), basis: "post_minus_pre_bigint" };
  }

  const pair: SolanaTokenBalanceFlowPair = {
    status: pairConflicts.size === 0 ? "matched" : "conflicting",
    accountIndex: id.accountIndex,
    mint: id.mint,
    preProviderArrayIndex: pre.observation.providerArrayIndex,
    postProviderArrayIndex: post.observation.providerArrayIndex,
    tokenAccountAddress: preAddress.status === "available" ? preAddress : postAddress,
    preOwner,
    postOwner,
    preRawAmount: rawAmount(preRaw),
    postRawAmount: rawAmount(postRaw),
    preDecimals,
    postDecimals,
    decimals,
    rawDelta,
  };
  return { pair, conflicts: [...pairConflicts] };
}

/** Derives transaction-local exact account-index/mint balance differences without provider access or economic interpretation. */
export function normalizeSolanaTokenBalanceFlowEvidence(
  transaction: SolanaTransactionEvidence,
  phase2AContext?: SolanaTokenBalanceFlowPhase2AContext,
): SolanaTokenBalanceFlowEvidence {
  const validation = validateTransaction(transaction);
  const signature = transaction.signatures[0];
  const phase2A = validatePhase2ALinkage(signature, phase2AContext);
  const reasons = new Set<SolanaTokenBalanceFlowReason>();
  const conflicts: SolanaTokenBalanceFlowConflict[] = [];
  const unmatched: SolanaTokenBalanceFlowUnmatchedObservation[] = [];
  const pairs: SolanaTokenBalanceFlowPair[] = [];
  const exec = executionState(transaction.execution);
  if (exec.reason) addReason(reasons, exec.reason);
  if (validation.balanceSideConflict) addReason(reasons, "balance_side_conflicting");
  if (validation.accountSpaceConflict) addReason(reasons, "account_space_conflicting");

  const preSide = transaction.tokenBalances.pre;
  const postSide = transaction.tokenBalances.post;
  const preRows = rowsFor("pre", preSide);
  const postRows = rowsFor("post", postSide);
  const bothSidesAvailable = preSide.status !== "unavailable" && postSide.status !== "unavailable";
  if (!bothSidesAvailable) addReason(reasons, "balance_side_unavailable");

  const validIdentityRows = (rows: Row[]): { rows: Array<Row & { id: Identity }>; invalid: Row[] } => {
    const valid: Array<Row & { id: Identity }> = [];
    const invalid: Row[] = [];
    for (const row of rows) {
      const id = identity(row.observation);
      if (!id) {
        invalid.push(row);
        addReason(reasons, "invalid_pair_identity");
        unmatched.push({ side: row.side, providerArrayIndex: row.observation.providerArrayIndex, reason: "invalid_pair_identity" });
      } else valid.push({ ...row, id });
    }
    return { rows: valid, invalid };
  };
  const preValid = validIdentityRows(preRows).rows;
  const postValid = validIdentityRows(postRows).rows;

  const indexesWithMultipleMints = new Set<number>();
  for (const rows of [preValid, postValid]) {
    const mintsByIndex = new Map<number, Set<string>>();
    for (const row of rows) {
      const mints = mintsByIndex.get(row.id.accountIndex) ?? new Set<string>();
      mints.add(row.id.mint);
      mintsByIndex.set(row.id.accountIndex, mints);
    }
    for (const [index, mints] of mintsByIndex) if (mints.size > 1) indexesWithMultipleMints.add(index);
  }
  for (const index of [...indexesWithMultipleMints].sort((a, b) => a - b)) {
    const preAtIndex = preValid.filter((row) => row.id.accountIndex === index);
    const postAtIndex = postValid.filter((row) => row.id.accountIndex === index);
    conflicts.push({ reason: "account_index_multiple_mints", accountIndex: index, mint: null,
      preProviderArrayIndexes: preAtIndex.map((row) => row.observation.providerArrayIndex).sort((a, b) => a - b),
      postProviderArrayIndexes: postAtIndex.map((row) => row.observation.providerArrayIndex).sort((a, b) => a - b) });
    addReason(reasons, "account_index_multiple_mints");
  }

  const group = (rows: Array<Row & { id: Identity }>): Map<string, Array<Row & { id: Identity }>> => {
    const result = new Map<string, Array<Row & { id: Identity }>>();
    for (const row of rows) {
      const items = result.get(row.id.key) ?? [];
      items.push(row);
      result.set(row.id.key, items);
    }
    return result;
  };
  const preGroups = group(preValid);
  const postGroups = group(postValid);
  const duplicateKeys = new Set<string>();
  for (const [key, preGroup] of preGroups) if (preGroup.length > 1) duplicateKeys.add(key);
  for (const [key, postGroup] of postGroups) if (postGroup.length > 1) duplicateKeys.add(key);
  for (const key of [...duplicateKeys].sort()) {
    const preGroup = preGroups.get(key) ?? [];
    const postGroup = postGroups.get(key) ?? [];
    const first = preGroup[0] ?? postGroup[0];
    conflicts.push({ reason: "duplicate_pair_key", accountIndex: first.id.accountIndex, mint: first.id.mint,
      preProviderArrayIndexes: preGroup.map((row) => row.observation.providerArrayIndex).sort((a, b) => a - b),
      postProviderArrayIndexes: postGroup.map((row) => row.observation.providerArrayIndex).sort((a, b) => a - b) });
    addReason(reasons, "duplicate_pair_key");
  }

  const excludedIndexes = indexesWithMultipleMints;
  const keys = new Set([...preGroups.keys(), ...postGroups.keys()]);
  for (const key of [...keys].sort((left, right) => {
    const a = (preGroups.get(left) ?? postGroups.get(left) as Array<Row & { id: Identity }>)[0].id;
    const b = (preGroups.get(right) ?? postGroups.get(right) as Array<Row & { id: Identity }>)[0].id;
    return a.accountIndex - b.accountIndex || compareText(a.mint, b.mint);
  })) {
    const preGroup = preGroups.get(key) ?? [];
    const postGroup = postGroups.get(key) ?? [];
    const first = preGroup[0] ?? postGroup[0];
    const index = first.id.accountIndex;
    if (excludedIndexes.has(index) || duplicateKeys.has(key)) continue;
    if (!bothSidesAvailable) {
      for (const row of [...preGroup, ...postGroup]) unmatched.push({ side: row.side,
        providerArrayIndex: row.observation.providerArrayIndex, reason: "balance_side_unavailable" });
      continue;
    }
    if (preGroup.length === 0) {
      unmatched.push({ side: "post", providerArrayIndex: postGroup[0].observation.providerArrayIndex, reason: "unmatched_post" });
      addReason(reasons, "unmatched_post");
      continue;
    }
    if (postGroup.length === 0) {
      unmatched.push({ side: "pre", providerArrayIndex: preGroup[0].observation.providerArrayIndex, reason: "unmatched_pre" });
      addReason(reasons, "unmatched_pre");
      continue;
    }
  const result = makePair(preGroup[0], postGroup[0], first.id, transaction.accountSpace.accounts, reasons, exec.state,
      validation.balanceSideConflict, validation.accountSpaceConflict);
    pairs.push(result.pair);
    for (const reason of result.conflicts) {
      conflicts.push({ reason, accountIndex: index, mint: first.id.mint,
        preProviderArrayIndexes: [preGroup[0].observation.providerArrayIndex],
        postProviderArrayIndexes: [postGroup[0].observation.providerArrayIndex] });
    }
  }

  // A partial source entry caused only by optional owner metadata does not
  // reduce balance-flow completeness; required pair-field results do.
  const hasPartialPair = pairs.some((pair) => pair.status === "matched" && pair.rawDelta.status === "unavailable");

  const uniqueReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
  let status: SolanaTokenBalanceFlowEvidence["status"];
  if (exec.state === "failed") status = "not_applicable";
  else if (exec.state === "conflicting") status = "conflicting";
  else if (exec.state === "unavailable") status = "unavailable";
  else if (!bothSidesAvailable) status = "unavailable";
  else if (conflicts.length > 0 || validation.balanceSideConflict || validation.accountSpaceConflict) status = "conflicting";
  else if (uniqueReasons.length > 0 || hasPartialPair) status = "partial";
  else status = "complete";

  const unmatchedSorted = unmatched.sort((a, b) => (a.side === b.side ? 0 : a.side === "pre" ? -1 : 1) ||
    a.providerArrayIndex - b.providerArrayIndex || compareText(a.reason, b.reason));
  conflicts.sort((a, b) => a.accountIndex - b.accountIndex || compareText(a.reason, b.reason) || compareText(a.mint ?? "", b.mint ?? ""));
  return {
    schemaVersion: "solana-token-balance-flow-evidence-v1",
    chain: "solana",
    transactionSignature: signature,
    transactionExecution: structuredClone(transaction.execution),
    status,
    reasonCodes: uniqueReasons,
    pairs,
    unmatchedObservations: unmatchedSorted,
    conflicts,
    phase2A,
  };
}

