import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { evaluateSolanaClaimPermissions } from "../analysis/solanaClaimPermission";
import { deriveSolanaQualificationMetricEvidence } from "../analysis/solanaQualificationMetricEvidence";
import { verifySolanaReferenceCaseArtifact } from "./solanaReferenceCase";
import { validatePublicReportCompositionInput } from "../validation/publicReportComposition";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";
import {
  PUBLIC_REPORT_REVIEW_REGISTRY_RECORD_VERSION,
  PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION,
  type PublicReportReviewRegistryRecordV1,
  type PublicReportReviewRegistryResolverCreationResult,
  type PublicReportReviewResolutionErrorCode,
  type PublicReportReviewResolutionResult,
  type PublicReportReviewRegistryRestriction,
} from "../types/publicReportReviewRegistry";

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESTRICTION_TARGETS = new Map<string, string>([
  ["market.primary_pool.market_cap_usd", "market.market_cap_usd"],
  ["market.primary_pool.fdv_usd", "market.fdv_usd"],
]);

const MESSAGES: Record<PublicReportReviewResolutionErrorCode, string> = {
  malformed_registry: "The application review registry is malformed.",
  unsupported_registry_schema: "The application review registry schema is unsupported.",
  duplicate_registry_record: "The application review registry contains a duplicate record identifier.",
  registry_entry_missing: "No application review record exists for this saved case.",
  registry_entry_ambiguous: "The application review registry contains ambiguous records for this case.",
  case_integrity_invalid: "The saved reference case failed integrity validation.",
  identity_mismatch: "The saved case identity does not match its review record.",
  analyst_note_invalid: "The analyst note is invalid.",
  note_binding_mismatch: "The analyst note does not match its review record.",
  overlay_invalid: "The registered restrictions are invalid for this saved case.",
  review_metadata_invalid: "The review metadata does not match the analyst note.",
  caller_authority_rejected: "Review authority cannot be supplied through resolver input.",
  saved_case_reclassification_rejected: "A saved reference case cannot be reclassified as a live report.",
};

class ResolutionFailure extends Error {
  constructor(readonly code: PublicReportReviewResolutionErrorCode) { super(code); }
}

function fail(code: PublicReportReviewResolutionErrorCode): never { throw new ResolutionFailure(code); }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === "string" && keys.includes(key));
}

/** Reject executable/exotic/non-JSON values in application configuration and resolver arguments. */
function assertJson(value: unknown, stack = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; fail("malformed_registry"); }
  if (typeof value !== "object" || stack.has(value)) fail("malformed_registry");
  stack.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail("malformed_registry");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) fail("malformed_registry");
        assertJson(descriptor.value, stack);
      }
      return;
    }
    if (!isRecord(value) || keys.some((key) => typeof key !== "string")) fail("malformed_registry");
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("malformed_registry");
      assertJson(descriptor.value, stack);
    }
  } finally { stack.delete(value); }
}

function isCanonicalUtc(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateRestriction(value: unknown): asserts value is PublicReportReviewRegistryRestriction {
  if (!isRecord(value) || !exactKeys(value, ["metricId", "claimId", "action", "explanationCode"])) fail("malformed_registry");
  const expectedClaim = typeof value.metricId === "string" ? RESTRICTION_TARGETS.get(value.metricId) : undefined;
  if (!expectedClaim || value.claimId !== expectedClaim || !(value.action === "suppress_value" || value.action === "provider_reported_only")
    || value.explanationCode !== "valuation_scope_and_denominator_unestablished") fail("malformed_registry");
}

function validateRecord(value: unknown): asserts value is PublicReportReviewRegistryRecordV1 {
  const keys = ["recordId", "recordVersion", "caseId", "chain", "mintAddress", "caseContentSha256", "analystNoteSha256", "disposition", "restrictions", "reviewerPseudonym", "reviewedAt"];
  if (!isRecord(value) || !exactKeys(value, keys)) fail("malformed_registry");
  if (typeof value.recordId !== "string" || !RECORD_ID.test(value.recordId) || value.recordVersion !== PUBLIC_REPORT_REVIEW_REGISTRY_RECORD_VERSION
    || typeof value.caseId !== "string" || !CASE_ID.test(value.caseId) || value.chain !== "solana"
    || typeof value.mintAddress !== "string" || !isSolanaPublicKeySyntax(value.mintAddress)
    || typeof value.caseContentSha256 !== "string" || !HASH.test(value.caseContentSha256)
    || typeof value.analystNoteSha256 !== "string" || !HASH.test(value.analystNoteSha256)
    || !(value.disposition === "case_bound_no_restrictions_confirmed" || value.disposition === "case_bound_restrictions_applied")
    || !Array.isArray(value.restrictions) || typeof value.reviewerPseudonym !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(value.reviewerPseudonym)
    || !isCanonicalUtc(value.reviewedAt)) fail("malformed_registry");
  const restrictionKeys = new Set<string>();
  for (const restriction of value.restrictions) {
    validateRestriction(restriction);
    const key = `${restriction.metricId}\u0000${restriction.claimId}`;
    if (restrictionKeys.has(key)) fail("malformed_registry");
    restrictionKeys.add(key);
  }
  if ((value.disposition === "case_bound_no_restrictions_confirmed" && value.restrictions.length !== 0)
    || (value.disposition === "case_bound_restrictions_applied" && value.restrictions.length === 0)) fail("malformed_registry");
}

function validateRegistry(value: unknown): ReadonlyMap<string, PublicReportReviewRegistryRecordV1> {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "records"])) fail("malformed_registry");
  if (value.schemaVersion !== PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION) fail("unsupported_registry_schema");
  assertJson(value);
  if (!Array.isArray(value.records)) fail("malformed_registry");
  const byCase = new Map<string, PublicReportReviewRegistryRecordV1>();
  const recordIds = new Set<string>();
  const caseIds = new Set<string>();
  for (const item of value.records) {
    validateRecord(item);
    if (recordIds.has(item.recordId)) fail("duplicate_registry_record");
    recordIds.add(item.recordId);
    if (caseIds.has(item.caseId)) fail("registry_entry_ambiguous");
    caseIds.add(item.caseId);
    // Snapshot and freeze app configuration so later mutation of the source object cannot
    // change the resolver's authority or make repeated lookups nondeterministic.
    const restrictions = Object.freeze(item.restrictions.map((entry) => Object.freeze({ ...entry })));
    const snapshot = Object.freeze({ ...item, restrictions });
    byCase.set(item.caseId, snapshot);
  }
  return byCase;
}

function failure(code: PublicReportReviewResolutionErrorCode): PublicReportReviewResolutionResult {
  return { valid: false, error: { code, message: MESSAGES[code] } };
}

function hasCallerAuthorityFields(input: Record<string, unknown>): boolean {
  return ["review", "reviewAssertion", "disposition", "overlay", "restrictions", "reviewerPseudonym", "reviewedAt", "caseHash", "analystNoteSha256", "registry"]
    .some((key) => Object.hasOwn(input, key));
}

/**
 * Creates an internal resolver over app-controlled configuration. The registry source must be
 * selected and controlled by the trusted application composition root; this factory cannot
 * authenticate its argument. Never pass registry data from public JSON. The resolver only handles
 * saved cases and independently verifies canonical artifact bytes, note bytes, and D17-D1 rules.
 */
export function createApplicationControlledPublicReportReviewResolver(
  applicationControlledRegistry: unknown,
): PublicReportReviewRegistryResolverCreationResult {
  let index: ReadonlyMap<string, PublicReportReviewRegistryRecordV1>;
  try { index = validateRegistry(applicationControlledRegistry); }
  catch (error: unknown) {
    const code = error instanceof ResolutionFailure ? error.code : "malformed_registry";
    return { valid: false, error: { code, message: MESSAGES[code] } };
  }

  const resolve = (input: unknown): PublicReportReviewResolutionResult => {
    try {
      if (!isRecord(input)) fail("malformed_registry");
      if (hasCallerAuthorityFields(input)) fail("caller_authority_rejected");
      if (Object.hasOwn(input, "report") || Object.hasOwn(input, "liveReport") || Object.hasOwn(input, "liveRequest")) fail("saved_case_reclassification_rejected");
      if (!exactKeys(input, ["caseArtifactJson", "analystNoteJson"]) || typeof input.caseArtifactJson !== "string" || typeof input.analystNoteJson !== "string") fail("malformed_registry");
      if (Buffer.byteLength(input.caseArtifactJson, "utf8") > MAX_JSON_BYTES || Buffer.byteLength(input.analystNoteJson, "utf8") > MAX_JSON_BYTES) fail("malformed_registry");

      let verified;
      try { verified = verifySolanaReferenceCaseArtifact(input.caseArtifactJson); }
      catch { fail("case_integrity_invalid"); }
      const referenceCase = verified.referenceCase;
      const record = index.get(referenceCase.caseId);
      if (!record) fail("registry_entry_missing");
      if (record.caseId !== referenceCase.caseId || record.chain !== referenceCase.identity.chain || record.mintAddress !== referenceCase.identity.mintAddress
        || record.caseContentSha256 !== referenceCase.contentHash.digestHex) fail("identity_mismatch");

      const noteSha256 = createHash("sha256").update(input.analystNoteJson, "utf8").digest("hex");
      if (record.analystNoteSha256 !== noteSha256) fail("note_binding_mismatch");
      let note: unknown;
      try { note = JSON.parse(input.analystNoteJson) as unknown; }
      catch { fail("analyst_note_invalid"); }
      if (!isRecord(note) || note.caseId !== referenceCase.caseId || note.caseHash !== referenceCase.contentHash.digestHex) fail("analyst_note_invalid");
      if (note.reviewerPseudonym !== record.reviewerPseudonym || note.reviewedAt !== record.reviewedAt) fail("review_metadata_invalid");

      let metrics;
      let claims;
      try {
        metrics = deriveSolanaQualificationMetricEvidence(referenceCase.evidenceReport);
        claims = evaluateSolanaClaimPermissions(referenceCase.evidenceReport);
      } catch { fail("case_integrity_invalid"); }
      const compositionInput = {
        schemaVersion: "public-report-composition-input-v1" as const,
        report: referenceCase.evidenceReport,
        metrics,
        claims,
      };
      const hasRestrictions = record.disposition === "case_bound_restrictions_applied";
      const overlay = hasRestrictions ? {
        schemaVersion: "token-analyst-restriction-overlay-v1" as const,
        caseId: record.caseId,
        caseContentHash: record.caseContentSha256,
        analystNoteSha256: record.analystNoteSha256,
        reviewerPseudonym: record.reviewerPseudonym,
        reviewedAt: record.reviewedAt,
        restrictions: record.restrictions,
      } : null;
      const reviewAssertion = record.disposition === "case_bound_restrictions_applied"
        ? { disposition: record.disposition, referenceCaseArtifactJson: input.caseArtifactJson, analystNoteJson: input.analystNoteJson, overlay: overlay! }
        : { disposition: record.disposition, referenceCaseArtifactJson: input.caseArtifactJson, analystNoteJson: input.analystNoteJson };
      const validation = validatePublicReportCompositionInput(compositionInput, reviewAssertion);
      if (!validation.valid) {
        if (validation.error.code === "analyst_note_invalid") fail("analyst_note_invalid");
        if (validation.error.code.startsWith("restriction_")) fail("overlay_invalid");
        if (validation.error.code === "review_disposition_unresolved") fail("overlay_invalid");
        fail("case_integrity_invalid");
      }
      if (validation.review.assertedDisposition !== record.disposition) fail("review_metadata_invalid");
      // D17-D1 strictly parses note JSON (including duplicate-key rejection); only now use its metadata.
      const parsedNote = JSON.parse(input.analystNoteJson) as Record<string, unknown>;
      if (!isDeepStrictEqual(parsedNote.reviewerPseudonym, record.reviewerPseudonym) || !isDeepStrictEqual(parsedNote.reviewedAt, record.reviewedAt)) {
        fail("review_metadata_invalid");
      }

      return {
        valid: true,
        resolution: {
          recordId: record.recordId,
          recordVersion: record.recordVersion,
          caseId: record.caseId,
          chain: record.chain,
          mintAddress: record.mintAddress,
          caseContentSha256: record.caseContentSha256,
          analystNoteSha256: record.analystNoteSha256,
          disposition: record.disposition,
          reviewerPseudonym: record.reviewerPseudonym,
          reviewedAt: record.reviewedAt,
          restrictions: record.restrictions,
          restrictionOverlay: overlay,
          authority: "application_configuration_source_unverified",
        },
      };
    } catch (error: unknown) {
      const code = error instanceof ResolutionFailure ? error.code : "malformed_registry";
      return failure(code);
    }
  };

  return { valid: true, resolve };
}
