import { readValidatedSolanaPublicReportContext } from "./solanaPublicReportCompositionService";
import type { SolanaValidatedPublicReportContext, SolanaValidatedPublicReportContextHandle } from "./solanaPublicReportCompositionService";
import type { SolanaClaimPermission } from "../types/solanaClaimPermission";
import type { SolanaQualificationMetricEvidenceEntry, SolanaQualificationMetricStatus } from "../types/solanaQualificationMetricEvidence";
import {
  PUBLIC_REPORT_SCHEMA_VERSION,
  type PublicEvidenceGapCode,
  type PublicEvidenceState,
  type PublicFieldExplanationCode,
  type PublicLimitationCode,
  type PublicReportField,
  type PublicReportFieldExplanation,
  type PublicReportFieldId,
  type PublicReportFieldLabel,
  type PublicReportProvenance,
  type PublicReportSection,
  type PublicReportSectionId,
  type PublicReportSafeValue,
  type PublicRestrictionOverlayEntry,
  type PublicTokenReportV1,
} from "../types/publicReportComposition";

const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const HASH = /^[0-9a-f]{64}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const PERCENT = /^(?:0|[1-9][0-9]*)\.[0-9]{6}$/;

export type SolanaPublicReportComposerResult =
  | { readonly valid: true; readonly report: PublicTokenReportV1 }
  | { readonly valid: false; readonly error: { readonly code: "invalid_context" | "restriction_invalid"; readonly message: string } };

const ERROR_MESSAGES = {
  invalid_context: "A validated evidence context is required.",
  restriction_invalid: "The validated analyst restrictions are inconsistent with the evidence.",
} as const;

type FieldDefinition = {
  id: PublicReportFieldId;
  section: PublicReportSectionId;
  label: PublicReportFieldLabel;
  explanation: PublicReportFieldExplanation;
  metricId: SolanaQualificationMetricEvidenceEntry["id"] | null;
  claimId: SolanaClaimPermission["id"] | null;
  unit: PublicReportField["unit"];
  limitations: readonly PublicLimitationCode[];
  display: "scalar" | "distribution" | "extensions" | "history" | "identity";
  restrictedMetricId?: PublicRestrictionOverlayEntry["metricId"];
};

const DEFINITIONS: readonly FieldDefinition[] = [
  { id: "identity.chain", section: "identity", label: "Token network", explanation: "The network associated with this saved evidence.", metricId: null, claimId: null, unit: null, limitations: [], display: "identity" },
  { id: "identity.asset", section: "identity", label: "Token address", explanation: "The requested token address.", metricId: null, claimId: null, unit: null, limitations: [], display: "identity" },
  { id: "identity.name", section: "identity", label: "Token name", explanation: "A token name was not included in the validated evidence.", metricId: null, claimId: null, unit: null, limitations: [], display: "identity" },
  { id: "identity.symbol", section: "identity", label: "Token symbol", explanation: "A token symbol was not included in the validated evidence.", metricId: null, claimId: null, unit: null, limitations: [], display: "identity" },
  { id: "market.price", section: "market", label: "Price", explanation: "Price reported for one selected market pool.", metricId: "market.primary_pool.price_usd", claimId: "market.price_usd", unit: "USD", limitations: ["selected_pool_only", "single_snapshot"], display: "scalar" },
  { id: "market.liquidity", section: "market", label: "Liquidity in selected pool", explanation: "Liquidity reported for one selected pool; one observation does not show whether it persists.", metricId: "market.primary_pool.liquidity_usd", claimId: "market.liquidity_usd", unit: "USD", limitations: ["selected_pool_only", "single_snapshot"], display: "scalar" },
  { id: "market.volume", section: "market", label: "Reported 24-hour volume", explanation: "Reported volume for the selected pool and 24-hour window; this does not establish trading quality.", metricId: "market.primary_pool.volume_h24_usd", claimId: "market.volume_h24_usd", unit: "USD", limitations: ["selected_pool_only", "single_snapshot"], display: "scalar" },
  { id: "market.market_cap", section: "market", label: "Reported market capitalization", explanation: "Provider-reported valuation only; its denominator and scope are not established.", metricId: "market.primary_pool.market_cap_usd", claimId: "market.market_cap_usd", unit: "USD", limitations: ["selected_pool_only", "single_snapshot", "provider_valuation_scope_unverified"], display: "scalar", restrictedMetricId: "market.primary_pool.market_cap_usd" },
  { id: "market.fdv", section: "market", label: "Reported fully diluted value", explanation: "Provider-reported valuation only; its denominator and scope are not established.", metricId: "market.primary_pool.fdv_usd", claimId: "market.fdv_usd", unit: "USD", limitations: ["selected_pool_only", "single_snapshot", "provider_valuation_scope_unverified"], display: "scalar", restrictedMetricId: "market.primary_pool.fdv_usd" },
  { id: "holders.observed_address_count", section: "holders", label: "Observed holder addresses", explanation: "A count of observed owner-authority addresses, not a count of people or economic owners.", metricId: "holders.positive_owner_authority_count", claimId: "holders.positive_owner_authority_count", unit: "addresses", limitations: ["owner_authorities_not_people"], display: "scalar" },
  { id: "holders.observed_balance_distribution", section: "holders", label: "Observed balance distribution", explanation: "Describes the retrieved holder records only; it does not establish the full holder population.", metricId: null, claimId: "holders.observed_frame_balance_distribution", unit: null, limitations: ["owner_authorities_not_people"], display: "distribution" },
  { id: "holders.concentration_top1", section: "holders", label: "Largest observed holder share", explanation: "Share of reported token supply represented by the largest observed owner authority; not economic control.", metricId: "holders.concentration_top1", claimId: "holders.concentration_top1", unit: "percent", limitations: ["owner_authorities_not_people", "not_atomic"], display: "scalar" },
  { id: "holders.concentration_top5", section: "holders", label: "Top 5 observed holder share", explanation: "Share of reported token supply represented by the five largest observed owner authorities; not economic control.", metricId: "holders.concentration_top5", claimId: "holders.concentration_top5", unit: "percent", limitations: ["owner_authorities_not_people", "not_atomic"], display: "scalar" },
  { id: "holders.concentration_top10", section: "holders", label: "Top 10 observed holder share", explanation: "Share of reported token supply represented by the ten largest observed owner authorities; not economic control.", metricId: "holders.concentration_top10", claimId: "holders.concentration_top10", unit: "percent", limitations: ["owner_authorities_not_people", "not_atomic"], display: "scalar" },
  { id: "holders.concentration_top20", section: "holders", label: "Top 20 observed holder share", explanation: "Share of reported token supply represented by the twenty largest observed owner authorities; not economic control.", metricId: "holders.concentration_top20", claimId: "holders.concentration_top20", unit: "percent", limitations: ["owner_authorities_not_people", "not_atomic"], display: "scalar" },
  { id: "token_controls.token_program", section: "token_controls", label: "Token program", explanation: "The program identified for this token mint.", metricId: "token_controls.token_program", claimId: "token_controls.token_program", unit: null, limitations: ["base_authority_fields_only"], display: "scalar" },
  { id: "token_controls.mint_authority_state", section: "token_controls", label: "Mint authority setting", explanation: "The base mint-authority setting only; this is not a security assessment.", metricId: "token_controls.mint_authority_state", claimId: "token_controls.mint_authority_state", unit: null, limitations: ["base_authority_fields_only"], display: "scalar" },
  { id: "token_controls.freeze_authority_state", section: "token_controls", label: "Freeze authority setting", explanation: "The base freeze-authority setting only; this is not a security assessment.", metricId: "token_controls.freeze_authority_state", claimId: "token_controls.freeze_authority_state", unit: null, limitations: ["base_authority_fields_only"], display: "scalar" },
  { id: "token_controls.extension_inventory_summary", section: "token_controls", label: "Token-2022 extension inventory", explanation: "Presence-only inventory of recognized mint extensions; it does not establish extension behavior or intent.", metricId: "token_controls.mint_extension_inventory", claimId: "token_controls.mint_extension_inventory", unit: null, limitations: ["extension_inventory_only"], display: "extensions" },
  { id: "historical.sampled_activity", section: "historical", label: "Historical activity sample", explanation: "Historical evidence applies only to the selected bounded sample, not all token activity.", metricId: "historical.request_state", claimId: "historical.sampled_activity", unit: null, limitations: ["sampled_authorities_only"], display: "history" },
  { id: "historical.integration_coverage", section: "historical", label: "Historical transaction integration", explanation: "Integration coverage applies only to supplied transaction candidates.", metricId: null, claimId: "historical.transaction_integration_coverage", unit: null, limitations: ["sampled_authorities_only"], display: "scalar" },
];

function failure(code: "invalid_context" | "restriction_invalid"): SolanaPublicReportComposerResult {
  return { valid: false, error: { code, message: ERROR_MESSAGES[code] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value);
  return date.toISOString() === value ? value : null;
}

function indexUnique<T extends { id: string }>(values: readonly T[]): Map<string, T> | null {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) return null;
    result.set(value.id, value);
  }
  return result;
}

function validateContext(value: unknown): value is SolanaValidatedPublicReportContext {
  if (!isRecord(value) || value.schemaVersion !== "solana-internal-public-report-context-v1"
    || !isRecord(value.identity) || value.identity.chain !== "solana" || typeof value.identity.assetId !== "string"
    || safeTimestamp(value.identity.generatedAt) === null || !isRecord(value.metrics) || !isRecord(value.claims)
    || value.metrics.schemaVersion !== "solana-qualification-metric-evidence-v1" || value.metrics.chain !== "solana"
    || value.metrics.mintAddress !== value.identity.assetId || !Array.isArray(value.metrics.entries)
    || value.claims.schemaVersion !== "tqe-claim-permission-proposal-v1" || value.claims.chain !== "solana"
    || value.claims.mintAddress !== value.identity.assetId || !Array.isArray(value.claims.claims)
    || !isRecord(value.review) || value.review.resolutionSucceeded !== true
    || !Array.isArray(value.review.restrictions) || !isRecord(value.provenance) || !isRecord(value.provenance.sections)
    || !isRecord(value.provenance.holderCoverage)) return false;
  if (value.provenance.evidenceSource === "live_observation") {
    if (value.identity.caseId !== null || value.identity.caseContentSha256 !== null
      || value.review.disposition !== "not_applicable" || value.review.recordId !== null
      || value.review.analystNoteSha256 !== null || value.review.livePolicyVersion !== "solana-live-review-policy-v1"
      || value.review.restrictions.length !== 0) return false;
  } else if (value.provenance.evidenceSource === "saved_reference_case") {
    if (!CASE_ID.test(String(value.identity.caseId)) || !HASH.test(String(value.identity.caseContentSha256))
      || !(value.review.disposition === "case_bound_no_restrictions_confirmed" || value.review.disposition === "case_bound_restrictions_applied")
      || typeof value.review.recordId !== "string" || typeof value.review.analystNoteSha256 !== "string") return false;
  } else return false;
  return indexUnique(value.metrics.entries as { id: string }[]) !== null && indexUnique(value.claims.claims as { id: string }[]) !== null;
}

function validateRestrictions(context: SolanaValidatedPublicReportContext): Map<string, PublicRestrictionOverlayEntry> | null {
  const map = new Map<string, PublicRestrictionOverlayEntry>();
  for (const item of context.review.restrictions) {
    if (!isRecord(item)) return null;
    const keys = Reflect.ownKeys(item);
    if (keys.length !== 4 || !["metricId", "claimId", "action", "explanationCode"].every((key) => Object.hasOwn(item, key))) return null;
    const expectedClaim = item.metricId === "market.primary_pool.market_cap_usd" ? "market.market_cap_usd"
      : item.metricId === "market.primary_pool.fdv_usd" ? "market.fdv_usd" : null;
    if (!expectedClaim || item.claimId !== expectedClaim || !(item.action === "suppress_value" || item.action === "provider_reported_only")
      || item.explanationCode !== "valuation_scope_and_denominator_unestablished") return null;
    const key = `${item.metricId}\0${item.claimId}`;
    if (map.has(key)) return null;
    map.set(key, item as unknown as PublicRestrictionOverlayEntry);
  }
  if (context.provenance.evidenceSource === "live_observation") {
    if (context.review.disposition !== "not_applicable" || map.size !== 0) return null;
    return map;
  }
  if ((context.review.disposition === "case_bound_no_restrictions_confirmed" && map.size !== 0)
    || (context.review.disposition === "case_bound_restrictions_applied" && map.size === 0)) return null;
  if (context.identity.assetId === PYUSD) {
    for (const [metric, claim] of [["market.primary_pool.market_cap_usd", "market.market_cap_usd"], ["market.primary_pool.fdv_usd", "market.fdv_usd"]]) {
      const row = map.get(`${metric}\0${claim}`);
      if (!row || row.action !== "provider_reported_only") return null;
    }
    if (map.size !== 2) return null;
  }
  return map;
}

function evidenceState(status: SolanaQualificationMetricStatus | null, completeness: SolanaQualificationMetricEvidenceEntry["completeness"], claim: SolanaClaimPermission | null): PublicEvidenceState {
  if (!status) {
    if (claim?.outcome === "not_evaluated_not_requested") return "not_requested";
    if (claim?.outcome === "withheld_conflicting") return "conflicting";
    if (claim?.outcome === "permitted") return "available";
    return "unknown";
  }
  if (status === "available" && (completeness === "partial" || (claim !== null && claim.outcome !== "permitted"))) return "partial";
  if (status === "not_requested") return "not_requested";
  if (status === "conflicting") return "conflicting";
  if (status === "available") return "available";
  if (status === "not_applicable" && claim?.outcome === "permitted") return "available";
  if (status === "unknown") return "unknown";
  return "unavailable";
}

function publicSource(entry: SolanaQualificationMetricEvidenceEntry | null, claim: SolanaClaimPermission | null = null): PublicReportProvenance | null {
  const sourceEvidence = entry?.source ?? claim?.evidence[0]?.source ?? null;
  if (!sourceEvidence) return null;
  const provider = sourceEvidence.provider;
  const source: PublicReportProvenance["source"] = provider === "helius" ? "helius"
    : provider === "dexscreener" ? "dexscreener"
      : entry?.evidenceKind === "deterministic_derivation" || provider === null ? "normalized_report" : "unknown";
  return { source, observedAt: safeTimestamp(sourceEvidence.observedAt), sourceUpdatedAt: safeTimestamp(sourceEvidence.sourceUpdatedAt) };
}

function allowedValue(definition: FieldDefinition, metric: SolanaQualificationMetricEvidenceEntry | null, claim: SolanaClaimPermission | null): PublicReportSafeValue | null {
  if (definition.display === "identity") {
    if (definition.id === "identity.chain") return "solana";
    if (definition.id === "identity.asset") return null; // supplied separately from the validated context identity
    return null;
  }
  if (!claim || claim.outcome !== "permitted") return null;
  if (definition.display === "distribution") return "A distribution summary is available for the retrieved records.";
  if (definition.display === "history") return definition.id === "historical.integration_coverage"
    ? "Transaction integration evidence applies only to the supplied candidate set."
    : "Bounded historical evidence is available for the selected sample.";
  if (!metric || metric.status !== "available" && metric.status !== "not_applicable") return null;
  if (definition.display === "extensions") {
    if (metric.status === "not_applicable") return "Not applicable to the classic SPL Token program.";
    if (!Array.isArray(metric.value) || !metric.value.every((row) => isRecord(row)
      && Number.isSafeInteger(row.extensionTypeId) && typeof row.extensionName === "string" && Number.isSafeInteger(row.payloadLength))) return null;
    return metric.value.length === 0 ? "No recognized mint extensions were recorded." : `${metric.value.length} recognized mint extension${metric.value.length === 1 ? "" : "s"} recorded; presence only.`;
  }
  if (definition.id === "holders.observed_balance_distribution") return "A distribution summary is available for the retrieved records.";
  let value: unknown = claim.value;
  if (definition.id.startsWith("holders.concentration_") && isRecord(claim.value)
    && claim.value.percentage === metric.value) value = claim.value.percentage;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  if (definition.unit === "USD") return DECIMAL.test(value) && Number.isFinite(Number(value)) ? value : null;
  if (definition.unit === "percent") return PERCENT.test(value) ? value : null;
  if (["spl-token", "token-2022", "set", "unset"].includes(value)) return value;
  return null;
}

function explanationCode(metric: SolanaQualificationMetricEvidenceEntry | null, restriction: PublicRestrictionOverlayEntry | undefined, emptyPopulation: boolean): PublicFieldExplanationCode | null {
  if (restriction) return restriction.explanationCode;
  if (emptyPopulation || metric?.reason === "orientation_unsupported") return "source_unavailable";
  if (metric?.status === "not_requested") return "source_not_requested";
  if (metric?.completeness === "partial") return "partial_coverage";
  if (metric?.status === "conflicting") return "claim_withheld";
  return null;
}

function fieldExplanation(definition: FieldDefinition, metric: SolanaQualificationMetricEvidenceEntry | null, claim: SolanaClaimPermission | null, emptyPopulation: boolean): PublicReportFieldExplanation {
  if (emptyPopulation) return "Largest-holder concentration is unavailable. The reported token supply is positive, but no positive token balances were found in the retrieved records.";
  if (metric?.reason === "orientation_unsupported") return "The selected pool orientation does not support a token-oriented value.";
  if (metric?.status === "not_requested" || claim?.outcome === "not_evaluated_not_requested") return "No historical evidence was requested.";
  if (claim && claim.outcome !== "permitted") return "The evidence is unavailable or was not sufficient for this claim.";
  return definition.explanation;
}

function makeField(
  definition: FieldDefinition,
  context: SolanaValidatedPublicReportContext,
  metrics: Map<string, SolanaQualificationMetricEvidenceEntry>,
  claims: Map<string, SolanaClaimPermission>,
  restrictions: Map<string, PublicRestrictionOverlayEntry>,
): PublicReportField {
  const metric = definition.metricId ? metrics.get(definition.metricId) ?? null : null;
  const claim = definition.claimId ? claims.get(definition.claimId) ?? null : null;
  if ((definition.metricId && !metric) || (definition.claimId && !claim)) throw new Error(`incomplete_validated_ledger:${definition.metricId}:${definition.claimId}`);
  const restriction = definition.restrictedMetricId && definition.claimId
    ? restrictions.get(`${definition.restrictedMetricId}\0${definition.claimId}`) : undefined;
  if (restriction?.action === "provider_reported_only"
    && (!metric || metric.status !== "available" || metric.evidenceKind !== "provider_observation" || metric.measurementBasis !== "provider_reported"
      || !claim || claim.outcome !== "permitted" || typeof metric.value !== "string" || claim.value !== metric.value || !DECIMAL.test(metric.value))) throw new Error("invalid_restriction_basis");
  const status = metric?.status ?? null;
  const positiveSupply = metrics.get("holders.current_mint_supply_raw");
  const observedOwners = metrics.get("holders.positive_owner_authority_count");
  const emptyPopulation = definition.id.startsWith("holders.concentration_") && metric?.reason === "empty_observed_population"
    && positiveSupply?.status === "available" && typeof positiveSupply.value === "string" && BigInt(positiveSupply.value) > 0n
    && observedOwners?.status === "available" && observedOwners.value === 0;
  const completeness = metric?.completeness ?? (definition.display === "distribution"
    ? context.provenance.holderCoverage.enumeration === "complete" && context.provenance.holderCoverage.amountCoverage === "complete" ? "complete"
      : context.provenance.holderCoverage.enumeration === "partial" || context.provenance.holderCoverage.amountCoverage === "partial" ? "partial" : "not_established"
    : null);
  const state = definition.display === "identity"
    ? definition.id === "identity.name" || definition.id === "identity.symbol" ? "unknown" : "available"
    : evidenceState(status, completeness, claim);
  const withheld = restriction?.action === "suppress_value" || (claim !== null && claim.outcome !== "permitted")
    || (definition.display !== "identity" && allowedValue(definition, metric, claim) === null);
  const valuationClaim = definition.claimId === "market.market_cap_usd" || definition.claimId === "market.fdv_usd";
  const visibility: PublicReportField["visibility"] = withheld ? "withheld"
    : restriction?.action === "provider_reported_only" || valuationClaim ? "technical_details" : "summary";
  const base = {
    id: definition.id,
    label: definition.label,
    ...(context.provenance.evidenceSource === "live_observation" && definition.id === "identity.chain"
      ? {} : { explanation: fieldExplanation(definition, metric, claim, emptyPopulation) }),
    evidenceState: state,
    unit: definition.unit,
    explanationCode: explanationCode(metric, restriction, emptyPopulation),
    provenance: publicSource(metric, claim),
    completeness,
    limitationCodes: definition.limitations,
    technicalDetailRef: visibility === "withheld" ? null : definition.id,
    claimOutcome: claim?.outcome ?? null,
  };
  return visibility === "withheld" ? { ...base, visibility }
    : { ...base, visibility, value: definition.id === "identity.asset" ? context.identity.assetId : allowedValue(definition, metric, claim) };
}

function sectionState(status: string): PublicEvidenceState {
  if (status === "present") return "available";
  if (status === "unavailable" || status === "not_requested") return status;
  if (status === "not_attempted") return "unavailable";
  return "unknown";
}

function sectionCompleteness(id: PublicReportSectionId, context: SolanaValidatedPublicReportContext, fields: readonly PublicReportField[]): PublicReportSection["completeness"] {
  if (id === "holders") {
    const { enumeration, amountCoverage } = context.provenance.holderCoverage;
    if (enumeration === "partial" || amountCoverage === "partial") return "partial";
    if (enumeration === "complete" && amountCoverage === "complete") return "complete";
    return "not_established";
  }
  const values = fields.map((field) => field.completeness).filter((value): value is "complete" | "partial" | "not_established" => value !== null && value !== undefined);
  if (values.includes("partial")) return "partial";
  if (values.length > 0 && values.every((value) => value === "complete")) return "complete";
  return values.includes("not_established") ? "not_established" : null;
}

function sectionLimitations(id: PublicReportSectionId, context: SolanaValidatedPublicReportContext, fields: readonly PublicReportField[]): PublicLimitationCode[] {
  const result = new Set<PublicLimitationCode>(fields.flatMap((field) => field.limitationCodes ?? []));
  if (id === "holders") {
    if (context.provenance.holderCoverage.enumeration === "partial") result.add("partial_enumeration");
    if (context.provenance.holderCoverage.amountCoverage === "partial") result.add("partial_amount_coverage");
    if (context.provenance.holderCoverage.slotConsistency === "not_guaranteed") result.add("not_atomic");
  }
  if (id === "market" && fields.length) result.add("selected_pool_only");
  return [...result];
}

function gapCodes(fields: readonly PublicReportField[], restrictions: readonly PublicRestrictionOverlayEntry[]): { code: PublicEvidenceGapCode }[] {
  const result = new Set<PublicEvidenceGapCode>();
  for (const field of fields) {
    if (field.evidenceState === "unavailable" || field.evidenceState === "conflicting") result.add("source_unavailable");
    if (field.evidenceState === "not_requested") result.add("source_not_requested");
    if (field.evidenceState === "partial") result.add("partial_coverage");
    if (field.visibility === "withheld") result.add("claim_withheld");
    if (field.explanationCode === "valuation_scope_and_denominator_unestablished") result.add("analyst_restriction");
  }
  if (restrictions.length) result.add("analyst_restriction");
  return [...result].map((code) => ({ code }));
}

function latestObservation(metrics: readonly SolanaQualificationMetricEvidenceEntry[]): string | null {
  const dates = metrics.map((entry) => safeTimestamp(entry.source.observedAt)).filter((value): value is string => value !== null);
  dates.sort((left, right) => Date.parse(right) - Date.parse(left));
  return dates[0] ?? null;
}

/** Pure deterministic projection. Only a process-local validated context handle is accepted. */
export function composeSolanaPublicReport(handle: unknown): SolanaPublicReportComposerResult {
  const rawContext = readValidatedSolanaPublicReportContext(handle);
  if (!validateContext(rawContext)) return failure("invalid_context");
  const context = rawContext;
  const restrictions = validateRestrictions(context);
  if (!restrictions) return failure("restriction_invalid");
  const metricIndex = indexUnique(context.metrics.entries);
  const claimIndex = indexUnique(context.claims.claims);
  if (!metricIndex || !claimIndex) return failure("invalid_context");
  try {
    const all = DEFINITIONS.map((definition) => makeField(definition, context, metricIndex, claimIndex, restrictions));
    const sections: PublicReportSection[] = (["identity", "market", "holders", "token_controls", "historical"] as const).map((id) => {
      const fields = all.filter((field) => DEFINITIONS.find((definition) => definition.id === field.id)?.section === id);
      const sourceStatus = id === "identity" ? "present"
        : id === "token_controls" ? context.provenance.sections.mint
          : id === "historical" ? context.provenance.sections.historicalTransactions
            : context.provenance.sections[id];
      return { id, evidenceState: sectionState(sourceStatus), completeness: sectionCompleteness(id, context, fields), fields,
        limitationCodes: sectionLimitations(id, context, fields) };
    });
    const summary = all.filter((field) => field.visibility === "summary");
    const technicalDetails = all.map((field) => field.visibility === "summary"
      ? { ...field, visibility: "technical_details" as const, technicalDetailRef: null }
      : { ...field, technicalDetailRef: null });
    const report: PublicTokenReportV1 = {
      schemaVersion: PUBLIC_REPORT_SCHEMA_VERSION,
      token: { chain: "solana", assetId: context.identity.assetId, name: null, symbol: null },
      generatedAt: context.identity.generatedAt,
      freshness: { state: context.provenance.evidenceSource === "live_observation"
        ? latestObservation(context.metrics.entries) ? "current_observation" : "not_established"
        : "historical_observation", observedAt: latestObservation(context.metrics.entries) },
      summary,
      sections,
      evidenceGaps: gapCodes(all, context.review.restrictions),
      technicalDetails,
      analystReview: { disposition: context.review.disposition, restrictions: context.review.restrictions.map((row) => ({ ...row })) },
    };
    return { valid: true, report };
  } catch {
    return failure("invalid_context");
  }
}
