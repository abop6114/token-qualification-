import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { evaluateSolanaClaimPermissions } from "../analysis/solanaClaimPermission";
import { deriveSolanaQualificationMetricEvidence } from "../analysis/solanaQualificationMetricEvidence";
import { verifySolanaReferenceCaseArtifact } from "../application/solanaReferenceCase";
import {
  PUBLIC_REPORT_COMPOSITION_INPUT_SCHEMA_VERSION,
  PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION,
  PUBLIC_RESTRICTION_OVERLAY_SCHEMA_VERSION,
  type PublicAnalystReviewDisposition,
  type PublicReportCompositionInputV1,
  type PublicReportValidationErrorCode,
  type PublicReportValidationResult,
  type PublicRestrictionAction,
  type PublicRestrictionClaimId,
  type PublicRestrictionMetricId,
  type PublicAnalystReviewAssertion,
} from "../types/publicReportComposition";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PYUSD_MINT = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const EXPLANATION = "valuation_scope_and_denominator_unestablished" as const;
const TARGETS = {
  "market.primary_pool.market_cap_usd": "market.market_cap_usd",
  "market.primary_pool.fdv_usd": "market.fdv_usd",
} as const satisfies Record<PublicRestrictionMetricId, PublicRestrictionClaimId>;

const MESSAGES: Record<PublicReportValidationErrorCode, string> = {
  malformed_input: "Public report evidence is malformed.",
  unsupported_schema: "A public report input uses an unsupported schema version.",
  identity_mismatch: "Public report evidence identities do not match.",
  source_linkage_mismatch: "Public report evidence does not link to the supplied source report.",
  metric_ledger_mismatch: "The supplied metric ledger does not match deterministic derivation.",
  claim_permission_mismatch: "The supplied claim permissions do not match deterministic evaluation.",
  review_disposition_unresolved: "A trusted analyst-review disposition is required.",
  case_binding_invalid: "The reference-case binding is invalid.",
  analyst_note_invalid: "The analyst note is invalid or does not match its case.",
  restriction_overlay_invalid: "The restriction overlay is invalid.",
  restriction_target_invalid: "The restriction overlay contains an unsupported target.",
  restriction_conflict: "The restriction overlay contains duplicate or conflicting targets.",
  restriction_basis_unsupported: "The restricted value is not supported on the provider-reported basis.",
};

class ValidationFailure extends Error {
  constructor(readonly code: PublicReportValidationErrorCode) { super(code); }
}

function fail(code: PublicReportValidationErrorCode): never { throw new ValidationFailure(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}
function isoUtc(value: unknown): value is string {
  return typeof value === "string" && UTC_ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Rejects accessors, cycles, exotic objects, sparse arrays and non-JSON values before inspecting data. */
function assertJson(value: unknown, stack = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; fail("malformed_input"); }
  if (typeof value !== "object" || stack.has(value)) fail("malformed_input");
  stack.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail("malformed_input");
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !("value" in descriptor)) fail("malformed_input");
        assertJson(descriptor.value, stack);
      }
      return;
    }
    if (!isRecord(value) || keys.some((key) => typeof key !== "string")) fail("malformed_input");
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("malformed_input");
      assertJson(descriptor.value, stack);
    }
  } finally { stack.delete(value); }
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("malformed_input");
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > MAX_INPUT_BYTES) fail("malformed_input");
    return size;
  } catch (error) {
    if (error instanceof ValidationFailure) throw error;
    fail("malformed_input");
  }
}

/** Parse JSON while rejecting duplicate object member names, which JSON.parse otherwise accepts. */
function parseJsonRejectingDuplicateKeys(serialized: string): unknown {
  let index = 0;
  const invalid = (): never => { throw new Error("invalid_json"); };
  const whitespace = (): void => { while (serialized[index] === " " || serialized[index] === "\t" || serialized[index] === "\r" || serialized[index] === "\n") index += 1; };
  const string = (): string => {
    const start = index;
    if (serialized[index] !== '"') return invalid();
    index += 1;
    while (index < serialized.length) {
      const char = serialized[index];
      if (char === '"') {
        index += 1;
        try { return JSON.parse(serialized.slice(start, index)) as string; } catch { return invalid(); }
      }
      if (char === "\\") index += 2;
      else index += 1;
    }
    return invalid();
  };
  const value = (): unknown => {
    whitespace();
    const char = serialized[index];
    if (char === '"') return string();
    if (char === "{") {
      index += 1;
      whitespace();
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (serialized[index] === "}") { index += 1; return object; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) return invalid();
        keys.add(key);
        whitespace();
        if (serialized[index] !== ":") return invalid();
        index += 1;
        Object.defineProperty(object, key, { value: value(), enumerable: true, configurable: true, writable: true });
        whitespace();
        if (serialized[index] === "}") { index += 1; return object; }
        if (serialized[index] !== ",") return invalid();
        index += 1;
      }
    }
    if (char === "[") {
      index += 1;
      whitespace();
      const array: unknown[] = [];
      if (serialized[index] === "]") { index += 1; return array; }
      while (true) {
        array.push(value());
        whitespace();
        if (serialized[index] === "]") { index += 1; return array; }
        if (serialized[index] !== ",") return invalid();
        index += 1;
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (serialized.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const start = index;
    while (index < serialized.length && !/[\s,\]}]/.test(serialized[index])) index += 1;
    if (start === index) return invalid();
    try { return JSON.parse(serialized.slice(start, index)) as unknown; } catch { return invalid(); }
  };

  const parsed = value();
  whitespace();
  if (index !== serialized.length) return invalid();
  return parsed;
}

function validateNote(serialized: string, expectedCaseId: string, expectedCaseHash: string): Record<string, unknown> {
  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) fail("analyst_note_invalid");
  let note: unknown;
  try { note = parseJsonRejectingDuplicateKeys(serialized); } catch { fail("analyst_note_invalid"); }
  if (!isRecord(note) || !exactKeys(note, ["schemaVersion", "caseId", "caseHash", "reviewerPseudonym", "reviewedAt", "evidenceReferences", "observations", "uncertainties", "alternativeExplanations", "disagreements", "openQuestions"])) fail("analyst_note_invalid");
  if (note.schemaVersion !== "solana-reference-case-analyst-note-v1" || note.caseId !== expectedCaseId || note.caseHash !== expectedCaseHash
    || typeof note.reviewerPseudonym !== "string" || note.reviewerPseudonym.trim().length === 0 || !isoUtc(note.reviewedAt)
    || !Array.isArray(note.evidenceReferences) || !Array.isArray(note.observations) || !Array.isArray(note.uncertainties)
    || !Array.isArray(note.alternativeExplanations) || !Array.isArray(note.disagreements) || !Array.isArray(note.openQuestions)) fail("analyst_note_invalid");
  assertJson(note);
  for (const item of [...note.observations, ...note.uncertainties, ...note.alternativeExplanations, ...note.openQuestions]) {
    if (typeof item !== "string") fail("analyst_note_invalid");
  }
  for (const ref of note.evidenceReferences) {
    if (!isRecord(ref) || !exactKeys(ref, ["metricId", "reportFieldPath"])
      || !(ref.metricId === null || typeof ref.metricId === "string")
      || typeof ref.reportFieldPath !== "string" || ref.reportFieldPath.length === 0) fail("analyst_note_invalid");
  }
  for (const item of note.disagreements) {
    if (!isRecord(item) || !exactKeys(item, ["topic", "position", "rationale"])
      || ![item.topic, item.position, item.rationale].every((part) => typeof part === "string")) fail("analyst_note_invalid");
  }
  return note;
}

function validateOverlay(
  value: unknown,
  caseId: string,
  caseHash: string,
  noteSha256: string,
  reviewer: string,
  reviewedAt: string,
  metrics: ReturnType<typeof deriveSolanaQualificationMetricEvidence>,
  claims: ReturnType<typeof evaluateSolanaClaimPermissions>,
  mintAddress: string,
): number {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "caseId", "caseContentHash", "analystNoteSha256", "reviewerPseudonym", "reviewedAt", "restrictions"])) fail("restriction_overlay_invalid");
  if (value.schemaVersion !== PUBLIC_RESTRICTION_OVERLAY_SCHEMA_VERSION || value.caseId !== caseId || value.caseContentHash !== caseHash
    || value.analystNoteSha256 !== noteSha256 || value.reviewerPseudonym !== reviewer || value.reviewedAt !== reviewedAt
    || !HASH.test(String(value.analystNoteSha256)) || !Array.isArray(value.restrictions) || value.restrictions.length === 0) fail("restriction_overlay_invalid");
  assertJson(value);
  const metricIndex = new Map(metrics.entries.map((entry) => [entry.id, entry]));
  const claimIndex = new Map(claims.claims.map((claim) => [claim.id, claim]));
  const seen = new Set<string>();
  const restrictions = value.restrictions as unknown[];
  for (const row of restrictions) {
    if (!isRecord(row) || !exactKeys(row, ["metricId", "claimId", "action", "explanationCode"])) fail("restriction_overlay_invalid");
    if (typeof row.metricId !== "string" || typeof row.claimId !== "string" || !(row.action === "suppress_value" || row.action === "provider_reported_only")
      || row.explanationCode !== EXPLANATION) fail("restriction_target_invalid");
    const expectedClaim = (TARGETS as Record<string, string>)[row.metricId];
    if (!expectedClaim || expectedClaim !== row.claimId) fail("restriction_target_invalid");
    const key = `${row.metricId}\u0000${row.claimId}`;
    if (seen.has(key)) fail("restriction_conflict");
    seen.add(key);
    const metric = metricIndex.get(row.metricId as PublicRestrictionMetricId);
    const claim = claimIndex.get(row.claimId as PublicRestrictionClaimId);
    if (!metric || !claim) fail("restriction_target_invalid");
    if (row.action === "provider_reported_only"
      && (metric.status !== "available" || metric.evidenceKind !== "provider_observation" || metric.measurementBasis !== "provider_reported"
        || claim.outcome !== "permitted" || !isDeepStrictEqual(claim.value, metric.value))) fail("restriction_basis_unsupported");
  }
  if (mintAddress === PYUSD_MINT) {
    const required = new Map<string, string>([
      ["market.primary_pool.market_cap_usd", "market.market_cap_usd"],
      ["market.primary_pool.fdv_usd", "market.fdv_usd"],
    ]);
    if (seen.size !== required.size || [...required].some(([metric, claim]) => !seen.has(`${metric}\u0000${claim}`)
      || restrictions.some((item) => isRecord(item) && item.metricId === metric && item.action !== "provider_reported_only"))) {
      fail("restriction_target_invalid");
    }
  }
  return restrictions.length;
}

function assertOrdinaryInput(input: unknown): asserts input is PublicReportCompositionInputV1 {
  if (!isRecord(input) || !exactKeys(input, ["schemaVersion", "report", "metrics", "claims"])) fail("malformed_input");
  if (input.schemaVersion !== PUBLIC_REPORT_COMPOSITION_INPUT_SCHEMA_VERSION) fail("unsupported_schema");
  assertJson(input);
  jsonByteLength(input);
  if (!isRecord(input.report) || !isRecord(input.metrics) || !isRecord(input.claims)) fail("malformed_input");
  if (input.report.schemaVersion !== "solana-token-evidence-report-v1"
    || input.metrics.schemaVersion !== "solana-qualification-metric-evidence-v1"
    || input.claims.schemaVersion !== "tqe-claim-permission-proposal-v1") fail("unsupported_schema");
  if (input.report.chain !== "solana" || input.metrics.chain !== "solana" || input.claims.chain !== "solana"
    || input.report.assetAddress !== input.metrics.mintAddress || input.report.assetAddress !== input.claims.mintAddress) fail("identity_mismatch");
  if (input.metrics.sourceReportSchemaVersion !== input.report.schemaVersion || input.metrics.sourceReportGeneratedAt !== input.report.generatedAt
    || input.claims.sourceReportSchemaVersion !== input.report.schemaVersion || input.claims.sourceReportGeneratedAt !== input.report.generatedAt) fail("source_linkage_mismatch");
  if (!isoUtc(input.report.generatedAt)) fail("malformed_input");
}

function validateCaseReview(
  review: PublicAnalystReviewAssertion,
  input: PublicReportCompositionInputV1,
): { disposition: Exclude<PublicAnalystReviewDisposition, "unresolved">; restrictionCount: number } {
  if (!isRecord(review) || typeof review.disposition !== "string") fail("review_disposition_unresolved");
  if (review.disposition === "unresolved") fail("review_disposition_unresolved");
  if (review.disposition === "not_applicable") {
    if (!exactKeys(review, ["disposition"])) fail("malformed_input");
    return { disposition: "not_applicable", restrictionCount: 0 };
  }
  if (review.disposition !== "case_bound_no_restrictions_confirmed" && review.disposition !== "case_bound_restrictions_applied") fail("review_disposition_unresolved");
  const hasOverlay = review.disposition === "case_bound_restrictions_applied";
  const allowedKeys = hasOverlay
    ? ["disposition", "referenceCaseArtifactJson", "analystNoteJson", "overlay"]
    : ["disposition", "referenceCaseArtifactJson", "analystNoteJson"];
  if (!exactKeys(review, allowedKeys) || typeof review.referenceCaseArtifactJson !== "string" || typeof review.analystNoteJson !== "string"
    || Buffer.byteLength(review.referenceCaseArtifactJson, "utf8") > MAX_INPUT_BYTES) fail("case_binding_invalid");
  let verified;
  try { verified = verifySolanaReferenceCaseArtifact(review.referenceCaseArtifactJson); }
  catch { fail("case_binding_invalid"); }
  const referenceCase = verified.referenceCase;
  if (referenceCase.identity.chain !== input.report.chain || referenceCase.identity.mintAddress !== input.report.assetAddress
    || referenceCase.evidenceReport.chain !== input.report.chain || !isDeepStrictEqual(referenceCase.evidenceReport, input.report)) fail("case_binding_invalid");
  const note = validateNote(review.analystNoteJson, referenceCase.caseId, referenceCase.contentHash.digestHex);
  const noteSha256 = createHash("sha256").update(review.analystNoteJson, "utf8").digest("hex");
  if (!HASH.test(noteSha256)) fail("analyst_note_invalid");
  if (!hasOverlay) {
    if (referenceCase.identity.mintAddress === PYUSD_MINT) fail("review_disposition_unresolved");
    return { disposition: "case_bound_no_restrictions_confirmed", restrictionCount: 0 };
  }
  const count = validateOverlay(review.overlay, referenceCase.caseId, referenceCase.contentHash.digestHex, noteSha256,
    String(note.reviewerPseudonym), String(note.reviewedAt), input.metrics, input.claims, input.report.assetAddress);
  return { disposition: "case_bound_restrictions_applied", restrictionCount: count };
}

/**
 * Validates normalized evidence and separately supplied review assertions. This function does
 * not authenticate the caller or review provenance; its success result labels that assertion
 * unverified. A future public composer must resolve review authority outside public request data.
 */
export function validatePublicReportCompositionInput(
  input: unknown,
  reviewAssertion: PublicAnalystReviewAssertion | undefined,
): PublicReportValidationResult {
  try {
    if (reviewAssertion === undefined) fail("review_disposition_unresolved");
    assertJson(reviewAssertion);
    jsonByteLength(reviewAssertion);
    assertOrdinaryInput(input);
    let metrics: ReturnType<typeof deriveSolanaQualificationMetricEvidence>;
    let claims: ReturnType<typeof evaluateSolanaClaimPermissions>;
    try { metrics = deriveSolanaQualificationMetricEvidence(input.report); }
    catch (error) {
      if (error instanceof Error && error.name === "SolanaQualificationMetricEvidenceInputError" && "reason" in error && error.reason === "identity_mismatch") fail("identity_mismatch");
      fail("malformed_input");
    }
    if (!isDeepStrictEqual(metrics, input.metrics)) fail("metric_ledger_mismatch");
    try { claims = evaluateSolanaClaimPermissions(input.report); }
    catch { fail("malformed_input"); }
    if (!isDeepStrictEqual(claims, input.claims)) fail("claim_permission_mismatch");
    const review = validateCaseReview(reviewAssertion, input);
    return {
      schemaVersion: PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION,
      valid: true,
      review: { assertedDisposition: review.disposition, authority: "unverified_assertion" },
      restrictionCount: review.restrictionCount,
    };
  } catch (error) {
    const code = error instanceof ValidationFailure ? error.code : "malformed_input";
    return { schemaVersion: PUBLIC_REPORT_VALIDATION_RESULT_SCHEMA_VERSION, valid: false, error: { code, message: MESSAGES[code] } };
  }
}
