import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import { deriveSolanaQualificationMetricEvidence } from "./solanaQualificationMetricEvidence";
import type {
  SolanaQualificationMetricEvidence,
  SolanaQualificationMetricEvidenceEntry,
  SolanaQualificationMetricId,
  SolanaQualificationMetricJsonValue,
  SolanaQualificationMetricSource,
  SolanaQualificationMetricStatus,
} from "../types/solanaQualificationMetricEvidence";
import type { NormalizedPoolMarket } from "../types/market";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";
import {
  SOLANA_CLAIM_PERMISSION_SCHEMA_VERSION,
  type SolanaClaimEvidenceReference,
  type SolanaClaimId,
  type SolanaClaimLimitationCode,
  type SolanaClaimPermission,
  type SolanaClaimPermissionEvidence,
  type SolanaClaimPermissionReason,
  type SolanaClaimScope,
} from "../types/solanaClaimPermission";

type UnknownRecord = Record<string, unknown>;

const METRIC_STATUSES = new Set<SolanaQualificationMetricStatus>([
  "available", "unavailable", "not_attempted", "not_requested", "not_applicable", "unknown", "conflicting", "malformed",
]);
const CANONICAL_UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_SIGNED = /^(?:0|-?[1-9][0-9]*)$/;
const PERCENTAGE_6 = /^(?:0|[1-9][0-9]*)\.[0-9]{6}$/;
const MARKET_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class SolanaClaimPermissionInputError extends Error {
  constructor(readonly reason: "malformed_derived_evidence") {
    super("Solana claim-permission evidence is malformed.");
    this.name = "SolanaClaimPermissionInputError";
  }
}

function fail(): never {
  throw new SolanaClaimPermissionInputError("malformed_derived_evidence");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullMatch(value: string, pattern: RegExp): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function isJson(value: unknown, seen = new Set<object>()): value is SolanaQualificationMetricJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isJson(item, seen));
    if (!isRecord(value)) return false;
    return Object.values(value).every((item) => isJson(item, seen));
  } finally {
    seen.delete(value);
  }
}

function cloneJson(value: SolanaQualificationMetricJsonValue): SolanaQualificationMetricJsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const clone: Record<string, SolanaQualificationMetricJsonValue> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneJson(item as SolanaQualificationMetricJsonValue);
    return clone;
  }
  return value;
}

function validSource(value: unknown): value is SolanaQualificationMetricSource {
  return isRecord(value)
    && ["mint", "market", "holders", "historicalTransactions"].includes(String(value.section))
    && typeof value.fieldPath === "string" && value.fieldPath.length > 0
    && (value.provider === null || typeof value.provider === "string")
    && (value.method === null || typeof value.method === "string")
    && (value.observedAt === null || (typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt))))
    && (value.sourceUpdatedAt === null || (typeof value.sourceUpdatedAt === "string" && Number.isFinite(Date.parse(value.sourceUpdatedAt))))
    && (value.contextSlots === null || (Array.isArray(value.contextSlots) && value.contextSlots.every((slot) => Number.isSafeInteger(slot) && slot >= 0)));
}

function assertDerivedLedger(value: SolanaQualificationMetricEvidence, report: SolanaTokenEvidenceReport): void {
  if (!isRecord(value) || value.schemaVersion !== "solana-qualification-metric-evidence-v1" || value.chain !== "solana"
    || value.mintAddress !== report.assetAddress || value.sourceReportSchemaVersion !== report.schemaVersion
    || value.sourceReportGeneratedAt !== report.generatedAt || !Array.isArray(value.entries)) fail();
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !METRIC_STATUSES.has(entry.status as SolanaQualificationMetricStatus)
      || !isJson(entry.value) || (entry.unit !== null && typeof entry.unit !== "string")
      || (entry.completeness !== null && !["complete", "partial", "not_established"].includes(String(entry.completeness)))
      || (entry.reason !== null && typeof entry.reason !== "string")
      || (entry.limitation !== null && typeof entry.limitation !== "string")
      || !validSource(entry.source)
      || (entry.numeratorRaw !== null && (typeof entry.numeratorRaw !== "string" || !fullMatch(entry.numeratorRaw, CANONICAL_SIGNED)))
      || (entry.denominatorRaw !== null && (typeof entry.denominatorRaw !== "string" || !fullMatch(entry.denominatorRaw, CANONICAL_UNSIGNED)))) fail();
    if (entry.status === "available" && entry.value === null) fail();
    if (entry.id.startsWith("market.primary_pool.") && entry.status === "available"
      && (typeof entry.value !== "string" || !fullMatch(entry.value, MARKET_DECIMAL) || !Number.isFinite(Number(entry.value)))) fail();
    if (["holders.token_account_count", "holders.nonzero_token_account_count", "holders.positive_owner_authority_count",
      "holders.distribution.distinct_balance_count", "holders.distribution.repeated_balance_group_count",
      "holders.distribution.authorities_in_repeated_balance_groups"].includes(entry.id)
      && entry.status === "available" && (!Number.isSafeInteger(entry.value) || (entry.value as number) < 0)) fail();
    if (["holders.observed_positive_balance_raw", "holders.current_mint_supply_raw", "holders.distribution.minimum_balance_raw",
      "holders.distribution.maximum_balance_raw", "holders.distribution.median_balance_raw", "holders.distribution.quantile_p25_raw",
      "holders.distribution.quantile_p50_raw", "holders.distribution.quantile_p75_raw", "holders.distribution.quantile_p90_raw",
      "holders.distribution.quantile_p99_raw"].includes(entry.id)
      && entry.status === "available" && (typeof entry.value !== "string" || !fullMatch(entry.value, CANONICAL_UNSIGNED))) fail();
    if (String(entry.id).startsWith("holders.concentration_") && entry.status === "available"
      && (typeof entry.value !== "string" || !fullMatch(entry.value, PERCENTAGE_6)
        || typeof entry.numeratorRaw !== "string" || typeof entry.denominatorRaw !== "string")) fail();
    if (entry.scope !== null && (!isRecord(entry.scope) || typeof entry.scope.address !== "string"
      || (entry.scope.kind === "authority" && !isSolanaPublicKeySyntax(entry.scope.address))
      || !["authority", "selected_pool"].includes(String(entry.scope.kind)))) fail();
  }
  const supply = value.entries.find((entry) => entry.id === "holders.current_mint_supply_raw");
  for (const entry of value.entries) {
    if (!String(entry.id).startsWith("holders.concentration_") || entry.status !== "available") continue;
    if (typeof entry.numeratorRaw !== "string" || typeof entry.denominatorRaw !== "string"
      || !fullMatch(entry.numeratorRaw, CANONICAL_UNSIGNED) || !fullMatch(entry.denominatorRaw, CANONICAL_UNSIGNED)
      || supply?.status !== "available" || supply.value !== entry.denominatorRaw
      || BigInt(entry.denominatorRaw) === 0n || BigInt(entry.numeratorRaw) > BigInt(entry.denominatorRaw)) fail();
    const [whole, fractional] = (entry.value as string).split(".");
    if (BigInt(whole!) > 100n || (BigInt(whole!) === 100n && BigInt(fractional!) !== 0n)) fail();
  }
}

function metricRef(entry: SolanaQualificationMetricEvidenceEntry): SolanaClaimEvidenceReference {
  return {
    metricId: entry.id,
    fieldPath: entry.source.fieldPath,
    status: entry.status,
    value: cloneJson(entry.value),
    unit: entry.unit,
    completeness: entry.completeness,
    numeratorRaw: entry.numeratorRaw,
    denominatorRaw: entry.denominatorRaw,
    measurementBasis: entry.measurementBasis,
    evidenceKind: entry.evidenceKind,
    limitation: entry.limitation,
    reason: entry.reason,
    sourceCoverage: null,
    source: { ...entry.source, contextSlots: entry.source.contextSlots === null ? null : [...entry.source.contextSlots] },
  };
}

function directRef(
  fieldPath: string,
  status: SolanaQualificationMetricStatus | "report_field",
  value: SolanaQualificationMetricJsonValue,
  unit: string | null,
  source: SolanaQualificationMetricSource,
  reason: string | null = null,
  details: { measurementBasis?: string | null; evidenceKind?: "provider_observation" | "deterministic_derivation" | null; limitation?: string | null } = {},
): SolanaClaimEvidenceReference {
  return { metricId: null, fieldPath, status, value: cloneJson(value), unit, completeness: null, numeratorRaw: null, denominatorRaw: null,
    measurementBasis: details.measurementBasis ?? null, evidenceKind: details.evidenceKind ?? null, limitation: details.limitation ?? null, reason, sourceCoverage: null,
    source: { ...source, contextSlots: source.contextSlots === null ? null : [...source.contextSlots] } };
}

function redactCoverageValues(value: SolanaQualificationMetricJsonValue): SolanaQualificationMetricJsonValue {
  if (Array.isArray(value)) return value.map(redactCoverageValues);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "supplyDifferenceRaw" ? null : redactCoverageValues(item as SolanaQualificationMetricJsonValue),
  ]));
}

function redactClaimEvidence(refs: readonly SolanaClaimEvidenceReference[]): SolanaClaimEvidenceReference[] {
  return refs.map((reference) => ({
    ...reference,
    value: null,
    numeratorRaw: null,
    denominatorRaw: null,
    sourceCoverage: reference.sourceCoverage === null ? null : redactCoverageValues(reference.sourceCoverage),
  }));
}

function decisionFromReference(reference: SolanaClaimEvidenceReference):
  | { outcome: "permitted"; reason: null }
  | { outcome: "withheld_conflicting"; reason: "conflicting_evidence" }
  | { outcome: "withheld_insufficient"; reason: SolanaClaimPermissionReason } {
  if (reference.status === "conflicting") return { outcome: "withheld_conflicting", reason: "conflicting_evidence" };
  if (reference.status === "available" || reference.status === "report_field") return { outcome: "permitted", reason: null };
  return { outcome: "withheld_insufficient", reason: reference.status === "malformed" ? "metric_not_eligible" : "metric_unavailable" };
}

function createClaim(
  id: SolanaClaimId,
  scope: SolanaClaimScope,
  refs: readonly SolanaClaimEvidenceReference[],
  limitations: readonly SolanaClaimLimitationCode[],
  value: SolanaQualificationMetricJsonValue | null,
  unit: string | null,
  forced?: { outcome: "withheld_insufficient" | "withheld_conflicting"; reason: SolanaClaimPermissionReason },
  permitNotApplicable = false,
  scopeAddress: string | null = null,
): SolanaClaimPermission {
  const hasPermittedSource = refs.some((reference) => reference.status === "available" || reference.status === "report_field");
  const decision = forced ?? (permitNotApplicable && refs[0]?.status === "not_applicable"
    ? { outcome: "permitted" as const, reason: null }
    : value !== null && hasPermittedSource
      ? { outcome: "permitted" as const, reason: null }
    : refs.length === 0
    ? { outcome: "withheld_insufficient" as const, reason: "no_backing_metric" as const }
    : decisionFromReference(refs[0]!));
  if (decision.outcome === "permitted") {
    if (value === null) return { id, scope, scopeAddress, outcome: "withheld_insufficient", value: null, unit, evidence: redactClaimEvidence(refs), limitationCodes: limitations, reason: "metric_not_eligible" };
    return { id, scope, scopeAddress, outcome: "permitted", value: cloneJson(value), unit, evidence: refs, limitationCodes: limitations, reason: null };
  }
  return { id, scope, scopeAddress, outcome: decision.outcome, value: null, unit, evidence: redactClaimEvidence(refs), limitationCodes: limitations, reason: decision.reason };
}

function indexEntries(ledger: SolanaQualificationMetricEvidence): Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]> {
  const index = new Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>();
  for (const entry of ledger.entries) {
    const list = index.get(entry.id) ?? [];
    list.push(entry);
    index.set(entry.id, list);
  }
  return index;
}

function one(index: Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>, id: SolanaQualificationMetricId): SolanaQualificationMetricEvidenceEntry {
  const values = index.get(id);
  if (!values || values.length !== 1) return fail();
  return values[0]!;
}

function selectedPool(report: SolanaTokenEvidenceReport): { pool: NormalizedPoolMarket; index: number } | null {
  const market = report.market;
  if (market.status !== "present" || market.evidence.primaryPoolAddress === null) return null;
  const index = market.evidence.pools.findIndex((pool) => pool.poolAddress === market.evidence.primaryPoolAddress);
  const pool = market.evidence.pools[index];
  if (!pool) return fail();
  return { pool, index };
}

function marketDirectReference(
  report: SolanaTokenEvidenceReport,
  selection: ReturnType<typeof selectedPool>,
  window: "m5" | "h1" | "h6",
): SolanaClaimEvidenceReference {
  if (report.market.status !== "present") {
    const status = report.market.status === "not_attempted" ? "not_attempted" : "unavailable";
    return directRef("report.market", status, null, "USD", { section: "market", fieldPath: "report.market", provider: null, method: null, observedAt: null, sourceUpdatedAt: null, contextSlots: null }, report.market.reason);
  }
  const snapshot = report.market.evidence;
  if (!selection) {
    return directRef("report.market.evidence.primaryPoolAddress", "unavailable", null, "USD", {
      section: "market", fieldPath: "report.market.evidence.primaryPoolAddress", provider: snapshot.provenance.provider,
      method: "token-pairs", observedAt: snapshot.snapshotAt, sourceUpdatedAt: snapshot.provenance.sourceUpdatedAt, contextSlots: null,
    }, "no_market");
  }
  const metric = selection.pool.volumeUsd[window];
  const path = `report.market.evidence.pools[${selection.index}].volumeUsd.${window}`;
  const source: SolanaQualificationMetricSource = {
    section: "market", fieldPath: path, provider: selection.pool.provenance.provider, method: "token-pairs",
    observedAt: selection.pool.provenance.fetchedAt, sourceUpdatedAt: selection.pool.provenance.sourceUpdatedAt, contextSlots: null,
  };
  if (metric.status === "available" && (typeof metric.value !== "string" || !fullMatch(metric.value, MARKET_DECIMAL))) fail();
  if (metric.status === "available" && !Number.isFinite(Number(metric.value))) fail();
  return metric.status === "available"
    ? directRef(path, "report_field", metric.value, "USD", source, null, {
      measurementBasis: metric.sourceField === undefined ? `Normalized selected-pool volume ${window} field.` : `Normalized selected-pool volume ${window} field (${metric.sourceField}).`,
      evidenceKind: metric.basis === "provider_reported" ? "provider_observation" : "deterministic_derivation",
      limitation: "One selected pool observation only; this does not establish volume outside the reported window or trading quality.",
    })
    : directRef(path, "unavailable", null, "USD", source, metric.reason);
}

function holderLimitations(report: SolanaTokenEvidenceReport, ownerAuthorities = false): SolanaClaimLimitationCode[] {
  const result: SolanaClaimLimitationCode[] = ["observed_frame_only"];
  if (report.holders.status === "present") {
    const structure = report.holders.evidence.holderStructure;
    if (structure.enumeration.completeness !== "complete") result.push("partial_enumeration");
    if (structure.amountCoverage.state !== "complete") result.push("partial_amount_coverage");
    if (structure.enumeration.slotConsistency === "not_guaranteed") result.push("slot_consistency_not_guaranteed");
    if (structure.supplyDifferenceRaw !== "0") result.push("not_atomic_with_mint_supply");
  }
  if (ownerAuthorities) result.push("owner_authorities_are_not_wallets_or_people", "not_atomic_with_mint_supply");
  return result;
}

function assertHolderSnapshotLink(report: SolanaTokenEvidenceReport): void {
  if (report.holders.status !== "present") return;
  const { holderStructure: structure, snapshotRecord } = report.holders.evidence;
  if (!isRecord(snapshotRecord) || !isRecord(snapshotRecord.snapshot) || !isRecord(snapshotRecord.acquisition)
    || !isRecord(snapshotRecord.source) || !isRecord(snapshotRecord.snapshot.enumeration)
    || !isRecord(snapshotRecord.snapshot.amountCoverage) || !isRecord(snapshotRecord.snapshot.concentration)) fail();
  const snapshot = snapshotRecord.snapshot;
  const acquisition = snapshotRecord.acquisition;
  const validCollectionLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  const validPageCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  if (snapshotRecord.schemaVersion !== "solana-holder-snapshot-record-v2"
    || snapshotRecord.source.provider !== "helius" || snapshotRecord.source.method !== "getProgramAccountsV2"
    || snapshotRecord.source.commitment !== "finalized"
    || snapshot.chain !== structure.chain || snapshot.mintAddress !== structure.mintAddress
    || snapshot.tokenProgram !== structure.tokenProgram || snapshot.decimals !== structure.decimals
    || snapshot.currentMintSupplyRaw !== structure.currentMintSupplyRaw
    || snapshot.observedPositiveBalanceRaw !== structure.observedPositiveBalanceRaw
    || snapshot.supplyDifferenceRaw !== structure.supplyDifferenceRaw || snapshot.fetchedAt !== structure.fetchedAt
    || snapshot.enumeration.completeness !== structure.enumeration.completeness
    || snapshot.enumeration.slotConsistency !== structure.enumeration.slotConsistency
    || snapshot.enumeration.pageCount !== structure.enumeration.pageCount
    || snapshot.enumeration.contextSlots.length !== structure.enumeration.contextSlots.length
    || snapshot.enumeration.contextSlots.some((slot, index) => slot !== structure.enumeration.contextSlots[index])
    || snapshot.amountCoverage.state !== structure.amountCoverage.state
    || snapshot.amountCoverage.reason !== structure.amountCoverage.reason
    || snapshot.amountCoverage.unsupportedExtensionTypes.length !== structure.amountCoverage.unsupportedExtensionTypes.length
    || snapshot.amountCoverage.unsupportedExtensionTypes.some((extension, index) => extension !== structure.amountCoverage.unsupportedExtensionTypes[index])
    || acquisition.completeness !== structure.enumeration.completeness
    || !validCollectionLimit(acquisition.configuredMaxPages) || !validCollectionLimit(acquisition.requestedPageSize)
    || !validPageCount(structure.enumeration.pageCount) || structure.enumeration.pageCount > acquisition.configuredMaxPages
    || (acquisition.completeness === "complete" && acquisition.stopReason !== "provider_terminated")) fail();
  if (acquisition.completeness === "complete" && structure.enumeration.pageCount > acquisition.configuredMaxPages) fail();
  if (acquisition.completeness === "partial") {
    if (structure.enumeration.completeness !== "partial" || !("acquisition" in structure)
      || acquisition.stopReason !== structure.acquisition.stopReason
      || acquisition.configuredMaxPages !== structure.acquisition.configuredMaxPages
      || acquisition.requestedPageSize !== structure.acquisition.requestedPageSize
      || !validCollectionLimit(structure.acquisition.configuredMaxPages)
      || !validCollectionLimit(structure.acquisition.requestedPageSize)) fail();
    if ((acquisition.stopReason === "page_cap" && structure.enumeration.pageCount !== acquisition.configuredMaxPages)
      || (acquisition.stopReason !== "page_cap" && structure.enumeration.pageCount >= acquisition.configuredMaxPages)) fail();
  }
  if (snapshot.tokenAccountCount !== structure.tokenAccountCount
    || snapshot.nonzeroTokenAccountCount !== structure.nonzeroTokenAccountCount
    || snapshot.rawOwnerCount !== structure.rawOwnerCount) fail();
  for (const key of ["top1", "top5", "top10", "top20"] as const) {
    if (JSON.stringify(snapshot.concentration[key]) !== JSON.stringify(structure.concentration[key])) fail();
  }
}

function withHolderCoverage(reference: SolanaClaimEvidenceReference, report: SolanaTokenEvidenceReport): SolanaClaimEvidenceReference {
  if (report.holders.status !== "present") return reference;
  const structure = report.holders.evidence.holderStructure;
  const acquisition = report.holders.evidence.snapshotRecord.acquisition;
  return {
    ...reference,
    sourceCoverage: {
      enumeration: {
        completeness: structure.enumeration.completeness,
        slotConsistency: structure.enumeration.slotConsistency,
        pageCount: structure.enumeration.pageCount,
        contextSlots: [...structure.enumeration.contextSlots],
      },
      amountCoverage: {
        state: structure.amountCoverage.state,
        reason: structure.amountCoverage.reason,
        unsupportedExtensionTypes: [...structure.amountCoverage.unsupportedExtensionTypes],
      },
      acquisition: {
        completeness: acquisition.completeness,
        stopReason: acquisition.stopReason,
        configuredMaxPages: acquisition.configuredMaxPages,
        requestedPageSize: acquisition.requestedPageSize,
      },
      supplyDifferenceRaw: structure.supplyDifferenceRaw,
    },
  };
}

function authorityMetricsFor(ledger: SolanaQualificationMetricEvidence, address: string): SolanaQualificationMetricEvidenceEntry[] {
  return ledger.entries.filter((entry) => entry.scope?.kind === "authority" && entry.scope.address === address);
}

function historyClaim(report: SolanaTokenEvidenceReport, index: Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>): SolanaClaimPermission {
  const request = one(index, "historical.request_state");
  if (request.status === "not_requested") return {
    id: "historical.sampled_activity", scope: "selected_authorities_requested_window", scopeAddress: null, outcome: "not_evaluated_not_requested",
    value: null, unit: null, evidence: redactClaimEvidence([metricRef(request)]), limitationCodes: ["bounded_selected_authorities_only"], reason: "history_not_requested",
  };
  if (report.historicalTransactions.status !== "present" || request.status !== "available") {
    return createClaim("historical.sampled_activity", "selected_authorities_requested_window", [metricRef(request)], [], null, null,
      { outcome: "withheld_insufficient", reason: "history_not_sufficiently_bounded" });
  }
  const historical = report.historicalTransactions.evidence;
  const planWindow = historical.queryPlan.requestedWindow;
  const sourceWindow = historical.execution.evidence.provenance.requestedWindow;
  const metricWindow = historical.descriptiveMetrics.source.requestedWindow;
  if (!isRecord(planWindow) || !Number.isSafeInteger(planWindow.fromUnixSecondsInclusive) || !Number.isSafeInteger(planWindow.toUnixSecondsExclusive)
    || planWindow.fromUnixSecondsInclusive >= planWindow.toUnixSecondsExclusive
    || !isRecord(sourceWindow) || !isRecord(metricWindow)
    || planWindow.fromUnixSecondsInclusive !== sourceWindow.fromUnixSecondsInclusive || planWindow.toUnixSecondsExclusive !== sourceWindow.toUnixSecondsExclusive
    || planWindow.fromUnixSecondsInclusive !== metricWindow.fromUnixSecondsInclusive || planWindow.toUnixSecondsExclusive !== metricWindow.toUnixSecondsExclusive) {
    return createClaim("historical.sampled_activity", "selected_authorities_requested_window", [metricRef(request)], [], null, null,
      { outcome: "withheld_conflicting", reason: "conflicting_evidence" });
  }
  const sample = one(index, "historical.sample_coverage");
  const queried = historical.descriptiveMetrics.authorities.filter((authority) => authority.queryStatus === "success"
    && authority.paginationStatus !== "not_applicable");
  if (historical.descriptiveMetrics.authorities.length !== historical.execution.evidence.authorities.length) return fail();
  for (let authorityIndex = 0; authorityIndex < historical.descriptiveMetrics.authorities.length; authorityIndex += 1) {
    const metricAuthority = historical.descriptiveMetrics.authorities[authorityIndex]!;
    const executionAuthority = historical.execution.evidence.authorities[authorityIndex]!;
    if (!executionAuthority || metricAuthority.authorityAddress !== executionAuthority.authorityAddress
      || metricAuthority.queryStatus !== executionAuthority.queryStatus
      || metricAuthority.paginationStatus !== executionAuthority.paginationStatus) return fail();
  }
  if (queried.length === 0) return createClaim("historical.sampled_activity", "selected_authorities_requested_window", [metricRef(request), metricRef(sample)], [], null, null,
    { outcome: "withheld_insufficient", reason: "history_not_sufficiently_bounded" });
  const authorityEvidence: SolanaQualificationMetricJsonValue[] = [];
  const refs: SolanaClaimEvidenceReference[] = [metricRef(request), metricRef(one(index, "historical.requested_window")), metricRef(sample)];
  for (const authority of queried) {
    if (!isSolanaPublicKeySyntax(authority.authorityAddress)) return fail();
    const executionAuthority = historical.execution.evidence.authorities.find((candidate) => candidate.authorityAddress === authority.authorityAddress);
    if (!executionAuthority || executionAuthority.queryStatus !== "success" || executionAuthority.paginationStatus !== authority.paginationStatus) return fail();
    const metrics = authorityMetricsForFromIndex(index, authority.authorityAddress);
    const accepted = metrics.find((entry) => entry.id === "historical.authority.accepted_observation_count");
    if (!accepted || accepted.status !== "available" || typeof accepted.value !== "number" || !Number.isSafeInteger(accepted.value) || accepted.value < 0) {
      return createClaim("historical.sampled_activity", "selected_authorities_requested_window", refs, ["bounded_selected_authorities_only"], null, null,
        { outcome: "withheld_insufficient", reason: "history_not_sufficiently_bounded" });
    }
    const selectedMetrics = metrics.filter((entry) => entry.id.startsWith("historical.authority."));
    refs.push(...selectedMetrics.map(metricRef));
    authorityEvidence.push({
      authorityAddress: authority.authorityAddress,
      queryStatus: authority.queryStatus,
      paginationStatus: authority.paginationStatus,
      terminalReason: executionAuthority.terminalReason,
      requestCount: executionAuthority.requestCount,
      pages: executionAuthority.pages.map((page) => ({ ...page })),
      metrics: selectedMetrics.map((entry) => ({ id: entry.id, status: entry.status, value: cloneJson(entry.value), unit: entry.unit, completeness: entry.completeness })),
    });
  }
  const value: SolanaQualificationMetricJsonValue = {
    requestedWindow: cloneJson(metricRef(one(index, "historical.requested_window")).value),
    queryProvenance: {
      provider: historical.execution.evidence.provenance.provider,
      method: historical.execution.evidence.provenance.method,
      fetchedAt: historical.execution.evidence.provenance.fetchedAt,
      maxAuthorities: historical.execution.evidence.provenance.maxAuthorities,
      maxPagesPerAuthority: historical.execution.evidence.provenance.maxPagesPerAuthority,
      maxRecordsPerAuthority: historical.execution.evidence.provenance.maxRecordsPerAuthority,
      candidateAuthorityCount: historical.execution.evidence.authorityScope.candidateAuthorityCount,
      candidateSetCompleteness: historical.execution.evidence.authorityScope.candidateSetCompleteness,
    },
    sampleCoverage: cloneJson(sample.value),
    authorities: authorityEvidence,
  };
  return createClaim("historical.sampled_activity", "selected_authorities_requested_window", refs,
    ["bounded_selected_authorities_only", "requested_window_is_not_observed_coverage", "no_trade_or_direction_inference"], value, null);
}

function authorityMetricsForFromIndex(index: Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>, address: string): SolanaQualificationMetricEvidenceEntry[] {
  const ids: SolanaQualificationMetricId[] = [
    "historical.authority.accepted_observation_count", "historical.authority.distinct_signature_count",
    "historical.authority.observed_block_time_bounds", "historical.authority.missing_block_time_count",
    "historical.authority.transfer_type_counts", "historical.authority.endpoint_relationship_counts", "historical.authority.amount_evidence_profile",
  ];
  return ids.flatMap((id) => (index.get(id) ?? []).filter((entry) => entry.scope?.kind === "authority" && entry.scope.address === address));
}

function historicalIntegrationClaim(report: SolanaTokenEvidenceReport, index: Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>): SolanaClaimPermission {
  if (report.historicalTransactions.status !== "present") {
    const request = one(index, "historical.request_state");
    if (request.status === "not_requested") return {
      id: "historical.transaction_integration_coverage", scope: "selected_transaction_candidates", scopeAddress: null, outcome: "not_evaluated_not_requested",
      value: null, unit: null, evidence: redactClaimEvidence([metricRef(request)]), limitationCodes: ["bounded_selected_authorities_only"], reason: "history_not_requested",
    };
    return createClaim("historical.transaction_integration_coverage", "selected_transaction_candidates", [metricRef(request)],
      ["bounded_selected_authorities_only"], null, null);
  }
  const entry = one(index, "historical.transaction_integration_coverage");
  if (entry.status === "not_requested") return {
    id: "historical.transaction_integration_coverage", scope: "selected_transaction_candidates", scopeAddress: null, outcome: "not_evaluated_not_requested",
    value: null, unit: null, evidence: redactClaimEvidence([metricRef(entry)]), limitationCodes: ["bounded_selected_authorities_only"], reason: "history_not_requested",
  };
  return createClaim("historical.transaction_integration_coverage", "selected_transaction_candidates", [metricRef(entry)],
    ["bounded_selected_authorities_only", "no_trade_or_direction_inference"], entry.status === "available" || entry.status === "not_applicable" ? entry.value : null, null,
    undefined, entry.status === "not_applicable");
}

function marketClaim(
  id: SolanaClaimId,
  metricId: SolanaQualificationMetricId | null,
  directWindow: "m5" | "h1" | "h6" | null,
  report: SolanaTokenEvidenceReport,
  selection: ReturnType<typeof selectedPool>,
  index: Map<SolanaQualificationMetricId, SolanaQualificationMetricEvidenceEntry[]>,
): SolanaClaimPermission {
  const reference = metricId ? metricRef(one(index, metricId)) : marketDirectReference(report, selection, directWindow!);
  const permitted = reference.status === "available" || reference.status === "report_field";
  return createClaim(id, "selected_pool", [reference], ["selected_pool_only", "single_pool_observation"], permitted ? reference.value : null, "USD",
    undefined, false, selection?.pool.poolAddress ?? null);
}

/**
 * Evaluates a fixed catalog of factual claim permissions. It derives and validates the existing
 * Phase 4B ledger internally; it accepts no caller-supplied metrics and performs no acquisition.
 */
export function evaluateSolanaClaimPermissions(report: SolanaTokenEvidenceReport): SolanaClaimPermissionEvidence {
  let ledger: SolanaQualificationMetricEvidence;
  try {
    ledger = deriveSolanaQualificationMetricEvidence(report);
  } catch (error) {
    if (error instanceof Error && error.name === "SolanaQualificationMetricEvidenceInputError") throw error;
    return fail();
  }
  assertDerivedLedger(ledger, report);
  assertHolderSnapshotLink(report);
  const index = indexEntries(ledger);
  const pool = selectedPool(report);
  const claims: SolanaClaimPermission[] = [];

  claims.push(marketClaim("market.price_usd", "market.primary_pool.price_usd", null, report, pool, index));
  claims.push(marketClaim("market.liquidity_usd", "market.primary_pool.liquidity_usd", null, report, pool, index));
  claims.push(marketClaim("market.market_cap_usd", "market.primary_pool.market_cap_usd", null, report, pool, index));
  claims.push(marketClaim("market.fdv_usd", "market.primary_pool.fdv_usd", null, report, pool, index));
  claims.push(marketClaim("market.volume_m5_usd", null, "m5", report, pool, index));
  claims.push(marketClaim("market.volume_h1_usd", null, "h1", report, pool, index));
  claims.push(marketClaim("market.volume_h6_usd", null, "h6", report, pool, index));
  claims.push(marketClaim("market.volume_h24_usd", "market.primary_pool.volume_h24_usd", null, report, pool, index));

  const frameLimits = holderLimitations(report);
  const ownerLimits = holderLimitations(report, true);
  const holderClaims: readonly [SolanaClaimId, SolanaQualificationMetricId, SolanaClaimScope, readonly SolanaClaimLimitationCode[]][] = [
    ["holders.token_account_count", "holders.token_account_count", "observed_token_account_rows", frameLimits],
    ["holders.positive_token_account_count", "holders.nonzero_token_account_count", "observed_positive_balance_accounts", frameLimits],
    ["holders.positive_owner_authority_count", "holders.positive_owner_authority_count", "observed_positive_owner_authorities", ownerLimits],
    ["holders.observed_positive_balance_raw", "holders.observed_positive_balance_raw", "observed_frame", ownerLimits],
  ];
  for (const [id, metricId, scope, limitations] of holderClaims) {
    const entry = one(index, metricId);
    claims.push(createClaim(id, scope, [withHolderCoverage(metricRef(entry), report)], limitations, entry.status === "available" ? entry.value : null, entry.unit));
  }

  const distributionIds: SolanaQualificationMetricId[] = [
    "holders.distribution.minimum_balance_raw", "holders.distribution.maximum_balance_raw", "holders.distribution.median_balance_raw",
    "holders.distribution.quantile_p25_raw", "holders.distribution.quantile_p50_raw", "holders.distribution.quantile_p75_raw",
    "holders.distribution.quantile_p90_raw", "holders.distribution.quantile_p99_raw", "holders.distribution.distinct_balance_count",
    "holders.distribution.repeated_balance_group_count", "holders.distribution.authorities_in_repeated_balance_groups",
    "holders.distribution.authority_share_in_repeated_balance_groups", "holders.distribution.cumulative_profile", "holders.distribution.repeated_balance_groups",
  ];
  const distributionEntries = distributionIds.map((id) => one(index, id));
  const distributionRefs = distributionEntries.map((entry) => withHolderCoverage(metricRef(entry), report));
  const availableDistribution = distributionEntries.filter((entry) => entry.status === "available");
  const distributionValue: SolanaQualificationMetricJsonValue | null = availableDistribution.length === 0 ? null : Object.fromEntries(
    availableDistribution.map((entry) => [entry.id, cloneJson(entry.value)]),
  );
  claims.push(createClaim("holders.observed_frame_balance_distribution", "observed_frame", distributionRefs, ownerLimits,
    distributionValue, null, distributionEntries.some((entry) => entry.status === "conflicting")
      ? { outcome: "withheld_conflicting", reason: "conflicting_evidence" }
      : availableDistribution.length === 0 ? { outcome: "withheld_insufficient", reason: "metric_unavailable" } : undefined));

  claims.push(createClaim("holders.full_population_count", "full_holder_population", [withHolderCoverage(metricRef(one(index, "holders.positive_owner_authority_count")), report)], ["observed_frame_only", "owner_authorities_are_not_wallets_or_people"], null, "holders",
    { outcome: "withheld_insufficient", reason: "unsupported_claim" }));
  for (const [id, metricId] of [
    ["holders.concentration_top1", "holders.concentration_top1"], ["holders.concentration_top5", "holders.concentration_top5"],
    ["holders.concentration_top10", "holders.concentration_top10"], ["holders.concentration_top20", "holders.concentration_top20"],
  ] as const) {
    const entry = one(index, metricId);
    const enumerationComplete = report.holders.status === "present" && report.holders.evidence.holderStructure.enumeration.completeness === "complete";
    const forced = !enumerationComplete
      ? { outcome: "withheld_insufficient" as const, reason: "enumeration_incomplete" as const }
      : entry.status === "conflicting"
        ? { outcome: "withheld_conflicting" as const, reason: "conflicting_evidence" as const }
        : entry.status !== "available" ? { outcome: "withheld_insufficient" as const, reason: "metric_not_eligible" as const }
          : undefined;
    const limitations: SolanaClaimLimitationCode[] = [...ownerLimits, "not_economic_control_concentration"];
    if (entry.completeness !== "complete") limitations.push("partial_amount_coverage");
    const value = entry.status === "available" ? {
      percentage: entry.value,
      numeratorRaw: entry.numeratorRaw,
      denominatorRaw: entry.denominatorRaw,
    } : null;
    claims.push(createClaim(id, "raw_owner_authority_concentration", [withHolderCoverage(metricRef(entry), report)], limitations, value, "percent", forced));
  }

  for (const [id, metricId, scope, limits] of [
    ["token_controls.mint_authority_state", "token_controls.mint_authority_state", "mint_base_authority_fields", ["base_fields_only", "not_security_or_risk_assessment"]],
    ["token_controls.freeze_authority_state", "token_controls.freeze_authority_state", "mint_base_authority_fields", ["base_fields_only", "not_security_or_risk_assessment"]],
    ["token_controls.token_program", "token_controls.token_program", "mint_base_authority_fields", ["base_fields_only", "not_security_or_risk_assessment"]],
    ["token_controls.mint_extension_inventory", "token_controls.mint_extension_inventory", "mint_base_and_inventory_fields", ["inventory_only", "not_security_or_risk_assessment"]],
  ] as const) {
    const entry = one(index, metricId);
    const classicInventoryNotApplicable = id === "token_controls.mint_extension_inventory"
      && entry.status === "not_applicable" && entry.reason === "classic_spl_token_program";
    const permitted = entry.status === "available" || classicInventoryNotApplicable;
    const value = classicInventoryNotApplicable
      ? { status: "not_applicable", reason: entry.reason }
      : entry.value;
    claims.push(createClaim(id, scope, [metricRef(entry)], limits, permitted ? value : null, entry.unit,
      undefined, classicInventoryNotApplicable));
  }

  claims.push(historyClaim(report, index));
  claims.push(historicalIntegrationClaim(report, index));
  claims.push(createClaim("historical.momentum", "temporal_momentum", [], ["no_momentum_metric_supported"], null, null,
    { outcome: "withheld_insufficient", reason: "unsupported_claim" }));

  return {
    schemaVersion: SOLANA_CLAIM_PERMISSION_SCHEMA_VERSION,
    chain: "solana",
    mintAddress: ledger.mintAddress,
    sourceReportSchemaVersion: ledger.sourceReportSchemaVersion,
    sourceReportGeneratedAt: ledger.sourceReportGeneratedAt,
    claims,
  };
}
