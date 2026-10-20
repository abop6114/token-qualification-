import { createApplicationControlledPublicReportReviewResolver, readInternalValidatedPublicReportSnapshot } from "./publicReportReviewResolver";
import { getSolanaPublicReportCompositionConfiguration } from "./solanaPublicReportCompositionConfiguration";
import type { SolanaClaimPermissionEvidence } from "../types/solanaClaimPermission";
import type { SolanaQualificationMetricEvidence } from "../types/solanaQualificationMetricEvidence";
import type { PublicReportReviewRegistryRestriction } from "../types/publicReportReviewRegistry";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";
import { deriveSolanaQualificationMetricEvidence } from "../analysis/solanaQualificationMetricEvidence";
import { evaluateSolanaClaimPermissions } from "../analysis/solanaClaimPermission";
import { validatePublicReportCompositionInput } from "../validation/publicReportComposition";
import { executeSolanaTokenEvidencePublicRequest } from "./solanaTokenEvidencePublicExecution";
import { generateSolanaTokenEvidenceReportWithTelemetry } from "./solanaTokenEvidenceReport";
import { presentSolanaTokenEvidenceReport } from "./solanaTokenEvidencePresentation";
import type { SolanaTokenEvidencePublicExecutionDependencies } from "../types/solanaTokenEvidencePublicExecution";
import type { SolanaTokenEvidenceReportTelemetryOptions } from "./solanaTokenEvidenceReport";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import { SolanaTokenEvidenceAdmissionError } from "./solanaTokenEvidencePublicExecution";
import { SolanaProviderRequestBudgetError } from "../types/solanaProviderRequestBudget";
import { SolanaExecutionCancelledError } from "../types/solanaTrustedExecutionContext";

export const SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION = "solana-internal-public-report-context-v1" as const;
export const SOLANA_LIVE_REVIEW_POLICY_VERSION = "solana-live-review-policy-v1" as const;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SolanaPublicReportCompositionErrorCode =
  | "invalid_request"
  | "caller_authority_rejected"
  | "saved_case_reclassification_rejected"
  | "application_configuration_unavailable"
  | "registry_invalid"
  | "registry_entry_missing"
  | "registry_entry_ambiguous"
  | "saved_evidence_unavailable"
  | "saved_evidence_invalid"
  | "review_resolution_failed"
  | "composition_validation_failed"
  | "live_mint_unverified"
  | "live_budget_rejected"
  | "live_admission_rejected"
  | "live_execution_cancelled";

const MESSAGES: Record<SolanaPublicReportCompositionErrorCode, string> = {
  invalid_request: "The saved-case composition request is invalid.",
  caller_authority_rejected: "Review authority must come from application-controlled configuration.",
  saved_case_reclassification_rejected: "Saved evidence cannot be reclassified as live evidence.",
  application_configuration_unavailable: "Application-controlled review configuration is unavailable.",
  registry_invalid: "Application-controlled review configuration is invalid.",
  registry_entry_missing: "No approved review record exists for this saved case.",
  registry_entry_ambiguous: "Multiple review records exist for this saved case.",
  saved_evidence_unavailable: "Saved case evidence or its analyst note is unavailable.",
  saved_evidence_invalid: "Saved case evidence failed integrity validation.",
  review_resolution_failed: "The saved case could not be resolved against its review record.",
  composition_validation_failed: "Deterministic report evidence validation failed.",
  live_mint_unverified: "The requested address could not be verified as a Solana token mint.",
  live_budget_rejected: "The local provider-request allowance is exhausted.",
  live_admission_rejected: "Another analysis is active or analysis is unavailable.",
  live_execution_cancelled: "The analysis was cancelled. No completed report was returned.",
};

export interface SolanaSavedCaseCompositionRequest {
  readonly caseId: string;
}

export interface SolanaValidatedPublicReportContext {
  readonly schemaVersion: typeof SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION;
  readonly identity: {
    readonly chain: "solana";
    readonly assetId: string;
    readonly caseId: string | null;
    readonly caseContentSha256: string | null;
    readonly generatedAt: string;
  };
  readonly metrics: SolanaQualificationMetricEvidence;
  readonly claims: SolanaClaimPermissionEvidence;
  readonly review: {
    readonly resolutionSucceeded: true;
    readonly registrySource: "application_configuration_source_unverified";
    readonly validatorAuthority: "unverified_assertion";
    readonly disposition: "not_applicable" | "case_bound_no_restrictions_confirmed" | "case_bound_restrictions_applied";
    readonly recordId: string | null;
    readonly analystNoteSha256: string | null;
    readonly restrictions: readonly PublicReportReviewRegistryRestriction[];
    readonly livePolicyVersion?: typeof SOLANA_LIVE_REVIEW_POLICY_VERSION;
  };
  readonly provenance: {
    readonly evidenceSource: "saved_reference_case" | "live_observation";
    readonly reportGeneratedAt: string;
    readonly sections: {
      readonly mint: string;
      readonly market: string;
      readonly holders: string;
      readonly historicalTransactions: string;
    };
    readonly holderCoverage: {
      readonly enumeration: "complete" | "partial" | null;
      readonly enumerationStopReason: string | null;
      readonly amountCoverage: "complete" | "partial" | null;
      readonly amountCoverageReason: string | null;
      readonly pageCount: number | null;
      readonly contextSlots: readonly number[] | null;
      readonly slotConsistency: "not_guaranteed" | null;
    };
  };
}

/** Opaque process-local capability. A structurally fabricated object is not accepted. */
declare const validatedContextHandleBrand: unique symbol;
export interface SolanaValidatedPublicReportContextHandle {
  readonly [validatedContextHandleBrand]: true;
}

export type SolanaPublicReportCompositionResult =
  | { readonly valid: true; readonly context: SolanaValidatedPublicReportContextHandle }
  | { readonly valid: false; readonly error: { readonly code: SolanaPublicReportCompositionErrorCode; readonly message: string } };

const contextByHandle = new WeakMap<object, SolanaValidatedPublicReportContext>();

class CompositionFailure extends Error {
  constructor(readonly code: SolanaPublicReportCompositionErrorCode) { super(code); }
}

function fail(code: SolanaPublicReportCompositionErrorCode): never { throw new CompositionFailure(code); }
function failure(code: SolanaPublicReportCompositionErrorCode): SolanaPublicReportCompositionResult {
  return { valid: false, error: { code, message: MESSAGES[code] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRequest(input: unknown): asserts input is SolanaSavedCaseCompositionRequest {
  if (!isRecord(input)) fail("invalid_request");
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) fail("invalid_request");
  const caseIdDescriptor = Object.getOwnPropertyDescriptor(input, "caseId");
  if (!caseIdDescriptor?.enumerable || !("value" in caseIdDescriptor)) fail("invalid_request");
  if (keys.some((key) => ["source", "sourceKind", "live", "liveReport", "liveRequest"].includes(String(key)))) {
    fail("saved_case_reclassification_rejected");
  }
  if (keys.some((key) => ["registry", "review", "reviewAssertion", "disposition", "overlay", "restrictions", "reviewerPseudonym", "reviewedAt", "caseHash", "caseContentSha256", "analystNoteSha256"].includes(String(key)))) {
    fail("caller_authority_rejected");
  }
  if (keys.some((key) => ["path", "filePath", "casePath", "analystNotePath", "caseArtifactJson", "analystNoteJson"].includes(String(key)))) {
    fail("invalid_request");
  }
  if (keys.length !== 1 || keys[0] !== "caseId" || typeof caseIdDescriptor.value !== "string" || !CASE_ID.test(caseIdDescriptor.value)) fail("invalid_request");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  // Resolver snapshots and their metric/claim payloads are already recursively frozen.
  if (Object.isFrozen(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function sectionStatus(report: SolanaTokenEvidenceReport, section: "mint" | "market" | "holders" | "historicalTransactions"): string {
  return report[section].status;
}

function makeContext(
  report: SolanaTokenEvidenceReport,
  metrics: SolanaQualificationMetricEvidence,
  claims: SolanaClaimPermissionEvidence,
  resolution: Extract<import("../types/publicReportReviewRegistry").PublicReportReviewResolutionResult, { valid: true }>['resolution'],
): SolanaValidatedPublicReportContext {
  const holderEvidence = report.holders.status === "present" ? report.holders.evidence : null;
  const holderStructure = holderEvidence?.holderStructure;
  return deepFreeze({
    schemaVersion: SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION,
    identity: {
      chain: "solana",
      assetId: report.assetAddress,
      caseId: resolution.caseId,
      caseContentSha256: resolution.caseContentSha256,
      generatedAt: report.generatedAt,
    },
    metrics,
    claims,
    review: {
      resolutionSucceeded: true,
      registrySource: resolution.authority,
      validatorAuthority: "unverified_assertion",
      disposition: resolution.disposition,
      recordId: resolution.recordId,
      analystNoteSha256: resolution.analystNoteSha256,
      restrictions: resolution.restrictions,
    },
    provenance: {
      evidenceSource: "saved_reference_case",
      reportGeneratedAt: report.generatedAt,
      sections: {
        mint: sectionStatus(report, "mint"),
        market: sectionStatus(report, "market"),
        holders: sectionStatus(report, "holders"),
        historicalTransactions: sectionStatus(report, "historicalTransactions"),
      },
      holderCoverage: {
        enumeration: holderStructure?.enumeration.completeness ?? null,
        enumerationStopReason: holderStructure && "acquisition" in holderStructure
          ? holderStructure.acquisition.stopReason
          : holderStructure ? "provider_terminated" : null,
        amountCoverage: holderStructure?.amountCoverage.state ?? null,
        amountCoverageReason: holderStructure?.amountCoverage.reason ?? null,
        pageCount: holderStructure?.enumeration.pageCount ?? null,
        contextSlots: holderStructure ? [...holderStructure.enumeration.contextSlots] : null,
        slotConsistency: holderStructure?.enumeration.slotConsistency ?? null,
      },
    },
  });
}

/**
 * Internal live composition boundary. It owns protected execution, identity checks,
 * deterministic derivation, D17 validation and opaque-handle registration as one operation.
 * No caller-supplied ledger, claim set, review assertion, or context is accepted.
 */
export async function resolveSolanaLiveEvidenceForPublicReport(
  assetAddress: string,
  executionDependencies: SolanaTokenEvidencePublicExecutionDependencies,
  options: { signal?: AbortSignal; telemetryOptions?: SolanaTokenEvidenceReportTelemetryOptions } = {},
): Promise<SolanaPublicReportCompositionResult> {
  try {
    if (typeof assetAddress !== "string" || !isSolanaPublicKeySyntax(assetAddress)) fail("invalid_request");
    const captured: { report?: SolanaTokenEvidenceReport } = {};
    const request = { chain: "solana" as const, assetAddress };
    await executeSolanaTokenEvidencePublicRequest(request, {
      ...executionDependencies,
      executePresentation: async (validatedRequest, context) => {
        const result = await generateSolanaTokenEvidenceReportWithTelemetry(
          validatedRequest,
          undefined,
          options.telemetryOptions,
          context,
        );
        captured.report = result.report;
        return presentSolanaTokenEvidenceReport(result.report);
      },
    }, { signal: options.signal });
    const report = captured.report;
    if (!report || report.assetAddress !== assetAddress || report.chain !== "solana"
      || report.mint.status !== "present" || !report.mint.evidence.resolution.exists
      || !report.mint.evidence.resolution.isMint || report.mint.evidence.resolution.mintAddress !== assetAddress) {
      fail("live_mint_unverified");
    }
    const metrics = deriveSolanaQualificationMetricEvidence(report);
    const claims = evaluateSolanaClaimPermissions(report);
    const validation = validatePublicReportCompositionInput({ schemaVersion: "public-report-composition-input-v1", report, metrics, claims }, { disposition: "not_applicable" });
    if (!validation.valid || validation.review.authority !== "unverified_assertion"
      || validation.review.assertedDisposition !== "not_applicable" || validation.restrictionCount !== 0) {
      fail("composition_validation_failed");
    }
    const holderEvidence = report.holders.status === "present" ? report.holders.evidence : null;
    const holderStructure = holderEvidence?.holderStructure;
    const context = deepFreeze({
      schemaVersion: SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION,
      identity: { chain: "solana" as const, assetId: assetAddress, caseId: null, caseContentSha256: null, generatedAt: report.generatedAt },
      metrics, claims,
      review: { resolutionSucceeded: true as const, registrySource: "application_configuration_source_unverified" as const,
        validatorAuthority: "unverified_assertion" as const, disposition: "not_applicable" as const, recordId: null, analystNoteSha256: null,
        restrictions: [], livePolicyVersion: SOLANA_LIVE_REVIEW_POLICY_VERSION },
      provenance: { evidenceSource: "live_observation" as const, reportGeneratedAt: report.generatedAt,
        sections: { mint: report.mint.status, market: report.market.status, holders: report.holders.status,
          historicalTransactions: report.historicalTransactions.status },
        holderCoverage: { enumeration: holderStructure?.enumeration.completeness ?? null,
          enumerationStopReason: holderStructure && "acquisition" in holderStructure ? holderStructure.acquisition.stopReason : holderStructure ? "provider_terminated" : null,
          amountCoverage: holderStructure?.amountCoverage.state ?? null, amountCoverageReason: holderStructure?.amountCoverage.reason ?? null,
          pageCount: holderStructure?.enumeration.pageCount ?? null, contextSlots: holderStructure ? [...holderStructure.enumeration.contextSlots] : null,
          slotConsistency: holderStructure?.enumeration.slotConsistency ?? null } },
    }) as SolanaValidatedPublicReportContext;
    const handle = Object.freeze(Object.create(null)) as SolanaValidatedPublicReportContextHandle;
    contextByHandle.set(handle as object, context);
    return { valid: true, context: handle };
  } catch (error: unknown) {
    if (error instanceof CompositionFailure) return failure(error.code);
    if (error instanceof SolanaProviderRequestBudgetError) return failure("live_budget_rejected");
    if (error instanceof SolanaTokenEvidenceAdmissionError) return failure("live_admission_rejected");
    if (error instanceof SolanaExecutionCancelledError) return failure("live_execution_cancelled");
    return failure("composition_validation_failed");
  }
}

/**
 * Internal saved-reference-case validation only. The imported configuration module, not the
 * request, selects the registry and fixed case/note readers. This service does not acquire data.
 */
export async function resolveSolanaSavedCaseForPublicReport(input: unknown): Promise<SolanaPublicReportCompositionResult> {
  try {
    validateRequest(input);
    let configuration;
    try { configuration = getSolanaPublicReportCompositionConfiguration(); }
    catch { fail("application_configuration_unavailable"); }
    if (!configuration || !isRecord(configuration) || !configuration.registry
      || typeof configuration.readCaseArtifactJson !== "function" || typeof configuration.readAnalystNoteJson !== "function") {
      fail("application_configuration_unavailable");
    }

    const resolverCreation = createApplicationControlledPublicReportReviewResolver(configuration.registry);
    if (!resolverCreation.valid) fail("registry_invalid");
    const registry = configuration.registry as { schemaVersion?: unknown; records?: unknown };
    if (!isRecord(registry) || !Array.isArray(registry.records)) fail("registry_invalid");
    const records = registry.records.filter((record) => isRecord(record) && record.caseId === input.caseId);
    if (records.length === 0) fail("registry_entry_missing");
    if (records.length !== 1) fail("registry_entry_ambiguous");

    let caseArtifactJson: string | null;
    let analystNoteJson: string | null;
    try {
      [caseArtifactJson, analystNoteJson] = await Promise.all([
        configuration.readCaseArtifactJson(input.caseId),
        configuration.readAnalystNoteJson(input.caseId),
      ]);
    } catch { fail("saved_evidence_unavailable"); }
    if (typeof caseArtifactJson !== "string" || typeof analystNoteJson !== "string") fail("saved_evidence_unavailable");

    const resolutionResult = resolverCreation.resolve({ caseArtifactJson, analystNoteJson });
    if (!resolutionResult.valid) {
      if (resolutionResult.error.code === "registry_entry_missing") fail("registry_entry_missing");
      if (resolutionResult.error.code === "registry_entry_ambiguous") fail("registry_entry_ambiguous");
      if (resolutionResult.error.code === "case_integrity_invalid" || resolutionResult.error.code === "identity_mismatch"
        || resolutionResult.error.code === "analyst_note_invalid" || resolutionResult.error.code === "note_binding_mismatch") fail("saved_evidence_invalid");
      fail("review_resolution_failed");
    }
    const snapshot = readInternalValidatedPublicReportSnapshot(resolutionResult);
    if (!snapshot || snapshot.referenceCase.caseId !== input.caseId
      || snapshot.registrySchemaVersion !== "public-report-review-registry-v1"
      || snapshot.resolution !== resolutionResult.resolution
      || snapshot.report !== snapshot.referenceCase.evidenceReport
      || snapshot.referenceCase.identity.chain !== snapshot.resolution.chain
      || snapshot.referenceCase.identity.mintAddress !== snapshot.resolution.mintAddress
      || snapshot.registryRecord.recordId !== snapshot.resolution.recordId
      || snapshot.registryRecord.recordVersion !== snapshot.resolution.recordVersion
      || snapshot.registryRecord.caseId !== snapshot.resolution.caseId
      || snapshot.registryRecord.chain !== snapshot.resolution.chain
      || snapshot.registryRecord.mintAddress !== snapshot.resolution.mintAddress
      || snapshot.registryRecord.caseContentSha256 !== snapshot.referenceCase.contentHash.digestHex
      || snapshot.registryRecord.analystNoteSha256 !== snapshot.analystNoteBytesSha256
      || snapshot.registryRecord.disposition !== snapshot.resolution.disposition
      || snapshot.registryRecord.reviewerPseudonym !== snapshot.resolution.reviewerPseudonym
      || snapshot.registryRecord.reviewedAt !== snapshot.resolution.reviewedAt
      || snapshot.registryRecord.restrictions !== snapshot.resolution.restrictions
      || snapshot.analystNoteBytesSha256 !== snapshot.resolution.analystNoteSha256
      || snapshot.analystNoteIdentity.caseId !== input.caseId
      || snapshot.analystNoteIdentity.caseHash !== snapshot.referenceCase.contentHash.digestHex
      || snapshot.analystNoteIdentity.reviewerPseudonym !== snapshot.resolution.reviewerPseudonym
      || snapshot.analystNoteIdentity.reviewedAt !== snapshot.resolution.reviewedAt
      || snapshot.validation.review.authority !== "unverified_assertion"
      || snapshot.validation.review.assertedDisposition !== snapshot.resolution.disposition
      || snapshot.validation.restrictionCount !== snapshot.resolution.restrictions.length) fail("review_resolution_failed");

    const context = makeContext(snapshot.report, snapshot.metrics, snapshot.claims, snapshot.resolution);
    const handle = Object.freeze(Object.create(null)) as SolanaValidatedPublicReportContextHandle;
    contextByHandle.set(handle as object, context);
    return { valid: true, context: handle };
  } catch (error: unknown) {
    const code = error instanceof CompositionFailure ? error.code : "invalid_request";
    return failure(code);
  }
}

/** Returns internal evidence only for a capability created by this module in this process. */
export function readValidatedSolanaPublicReportContext(
  handle: unknown,
): SolanaValidatedPublicReportContext | null {
  if (typeof handle !== "object" || handle === null) return null;
  return contextByHandle.get(handle) ?? null;
}

/** Exposed for internal diagnostics/tests; it contains no source bytes or report object. */
export function isValidatedSolanaPublicReportContextHandle(handle: unknown): handle is SolanaValidatedPublicReportContextHandle {
  return typeof handle === "object" && handle !== null && contextByHandle.has(handle);
}
