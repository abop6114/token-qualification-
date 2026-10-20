import { evaluateSolanaClaimPermissions } from "../analysis/solanaClaimPermission";
import { deriveSolanaQualificationMetricEvidence } from "../analysis/solanaQualificationMetricEvidence";
import { verifySolanaReferenceCaseArtifact } from "./solanaReferenceCase";
import { createApplicationControlledPublicReportReviewResolver } from "./publicReportReviewResolver";
import { getSolanaPublicReportCompositionConfiguration } from "./solanaPublicReportCompositionConfiguration";
import { validatePublicReportCompositionInput } from "../validation/publicReportComposition";
import type { SolanaClaimPermissionEvidence } from "../types/solanaClaimPermission";
import type { SolanaQualificationMetricEvidence } from "../types/solanaQualificationMetricEvidence";
import type { PublicReportReviewRegistryRestriction } from "../types/publicReportReviewRegistry";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";

export const SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION = "solana-internal-public-report-context-v1" as const;
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
  | "composition_validation_failed";

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
};

export interface SolanaSavedCaseCompositionRequest {
  readonly caseId: string;
}

export interface SolanaValidatedPublicReportContext {
  readonly schemaVersion: typeof SOLANA_INTERNAL_PUBLIC_REPORT_CONTEXT_SCHEMA_VERSION;
  readonly identity: {
    readonly chain: "solana";
    readonly assetId: string;
    readonly caseId: string;
    readonly caseContentSha256: string;
    readonly generatedAt: string;
  };
  readonly metrics: SolanaQualificationMetricEvidence;
  readonly claims: SolanaClaimPermissionEvidence;
  readonly review: {
    readonly resolutionSucceeded: true;
    readonly registrySource: "application_configuration_source_unverified";
    readonly validatorAuthority: "unverified_assertion";
    readonly disposition: "case_bound_no_restrictions_confirmed" | "case_bound_restrictions_applied";
    readonly recordId: string;
    readonly analystNoteSha256: string;
    readonly restrictions: readonly PublicReportReviewRegistryRestriction[];
  };
  readonly provenance: {
    readonly evidenceSource: "saved_reference_case";
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
    let verified;
    try { verified = verifySolanaReferenceCaseArtifact(caseArtifactJson); }
    catch { fail("saved_evidence_invalid"); }
    if (verified.referenceCase.caseId !== input.caseId
      || verified.referenceCase.identity.chain !== resolutionResult.resolution.chain
      || verified.referenceCase.identity.mintAddress !== resolutionResult.resolution.mintAddress
      || verified.referenceCase.contentHash.digestHex !== resolutionResult.resolution.caseContentSha256) fail("saved_evidence_invalid");

    const report = verified.referenceCase.evidenceReport;
    let metrics: SolanaQualificationMetricEvidence;
    let claims: SolanaClaimPermissionEvidence;
    try {
      metrics = deriveSolanaQualificationMetricEvidence(report);
      claims = evaluateSolanaClaimPermissions(report);
    } catch { fail("composition_validation_failed"); }
    const compositionInput = { schemaVersion: "public-report-composition-input-v1" as const, report, metrics, claims };
    const reviewAssertion = resolutionResult.resolution.disposition === "case_bound_restrictions_applied"
      ? {
          disposition: resolutionResult.resolution.disposition,
          referenceCaseArtifactJson: caseArtifactJson,
          analystNoteJson,
          overlay: resolutionResult.resolution.restrictionOverlay,
        }
      : {
          disposition: resolutionResult.resolution.disposition,
          referenceCaseArtifactJson: caseArtifactJson,
          analystNoteJson,
        };
    const validation = validatePublicReportCompositionInput(compositionInput, reviewAssertion);
    if (!validation.valid || validation.review.authority !== "unverified_assertion"
      || validation.review.assertedDisposition !== resolutionResult.resolution.disposition
      || validation.restrictionCount !== resolutionResult.resolution.restrictions.length) fail("composition_validation_failed");

    const context = makeContext(report, metrics, claims, resolutionResult.resolution);
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
