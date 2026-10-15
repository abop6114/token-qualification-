import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { deriveSolanaQualificationMetricEvidence } from "../analysis/solanaQualificationMetricEvidence";
import { aggregateSolanaReportOperationalTelemetry } from "./solanaReportOperationalTelemetry";
import { executeSolanaTokenEvidencePublicRequest } from "./solanaTokenEvidencePublicExecution";
import { generateSolanaTokenEvidenceReportWithTelemetry } from "./solanaTokenEvidenceReport";
import { presentSolanaTokenEvidenceReport } from "./solanaTokenEvidencePresentation";
import { parseSolanaTokenEvidencePublicRequest } from "./solanaTokenEvidencePublicRequest";
import {
  SOLANA_REFERENCE_CASE_BATCH_LIMIT,
  SOLANA_REFERENCE_CASE_CANONICALIZATION,
  SOLANA_REFERENCE_CASE_REQUEST_BUDGET,
  SOLANA_REFERENCE_CASE_SCHEMA_VERSION,
  type SolanaReferenceCaseCaptureDependencies,
  type SolanaReferenceCaseCaptureResult,
  type SolanaReferenceCaseErrorReason,
  type SolanaReferenceCaseIntegrityResult,
  type SolanaReferenceCaseV1,
} from "../types/solanaReferenceCase";
import type { SolanaTokenEvidenceReport } from "../types/solanaTokenEvidenceReport";

const LIMITATIONS = ["history_not_requested", "report_not_atomic"] as const;
const CASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_ASSIGNMENT = /\b(?:api[-_]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*[^\s"'<>]+/i;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i;
const CREDENTIAL_BEARING_URL = /https?:\/\/[^\s"'<>]*[?&](?:api[-_]?key|access[_-]?token|refresh[_-]?token|authorization)=/i;

function isForbiddenFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "url" || normalized === "uri" || normalized === "endpoint" || normalized === "auth" || normalized === "token" ||
    normalized.includes("apikey") || normalized.includes("authorization") ||
    normalized.includes("authurl") || normalized.includes("authendpoint") || normalized.includes("authenticatedurl") || normalized.includes("authenticatedendpoint") ||
    normalized.includes("accesstoken") || normalized.includes("refreshtoken") || normalized.includes("bearertoken") ||
    normalized.includes("secret") || normalized.includes("credential") || normalized.includes("password") ||
    normalized.includes("privatekey") || normalized === "cursor" || normalized.endsWith("cursor") ||
    normalized.includes("paginationtoken") || normalized.includes("paginationkey") ||
    normalized.includes("continuationtoken") || normalized.includes("continuationkey") ||
    normalized.includes("rawproviderbody") || normalized.includes("rawprovidererror") || normalized.includes("rawproviderresponse") ||
    normalized.includes("providerresponse") || normalized.includes("providererrorbody") || normalized.includes("providerpayload") ||
    normalized.includes("rawresponse") || normalized.includes("responsebody") || normalized.includes("errorbody") ||
    normalized.includes("responsepayload") || normalized.includes("errorpayload");
}

function isCredentialBearingValue(value: string): boolean {
  return CREDENTIAL_ASSIGNMENT.test(value) || BEARER_CREDENTIAL.test(value) || CREDENTIAL_BEARING_URL.test(value);
}

export class SolanaReferenceCaseError extends Error {
  constructor(readonly reason: SolanaReferenceCaseErrorReason) {
    const messages: Record<SolanaReferenceCaseErrorReason, string> = {
      invalid_request: "The reference-case request is invalid.",
      invalid_storage_path: "Reference-case storage must be a safe local path outside the repository.",
      invalid_case: "The reference-case artifact is malformed.",
      identity_mismatch: "Reference-case identities do not match.",
      unresolved_mint: "The report does not establish the requested address as a resolved mint.",
      synthetic_capture_not_accepted: "Synthetic evidence cannot be accepted as a protected capture.",
      integrity_mismatch: "The reference-case content hash does not match its canonical content.",
      case_exists: "A reference case with this ID already exists.",
      storage_failure: "The reference-case artifact could not be stored safely.",
    };
    super(messages[reason]);
    this.name = "SolanaReferenceCaseError";
  }
}

function fail(reason: SolanaReferenceCaseErrorReason): never {
  throw new SolanaReferenceCaseError(reason);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function canonicalValue(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_case");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return fail("invalid_case");
  if (stack.has(value)) return fail("invalid_case");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
        return fail("invalid_case");
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail("invalid_case");
        entries.push(canonicalValue(descriptor.value, stack));
      }
      if (ownKeys.length !== value.length + 1) return fail("invalid_case");
      return `[${entries.join(",")}]`;
    }
    if (!isPlainRecord(value)) return fail("invalid_case");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return fail("invalid_case");
    const sorted = (keys as string[]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const entries: string[] = [];
    for (const key of sorted) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail("invalid_case");
      if (isForbiddenFieldName(key)) return fail("invalid_case");
      entries.push(`${JSON.stringify(key)}:${canonicalValue(descriptor.value, stack)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/** Canonical JSON: UTF-8 is applied by the caller; keys sort recursively, arrays retain order. */
export function canonicalizeSolanaReferenceCaseValue(value: unknown): string {
  assertSafeFields(value);
  return canonicalValue(value, new Set<object>());
}

function assertSafeFields(value: unknown, stack = new Set<object>()): void {
  if (typeof value === "string") {
    if (isCredentialBearingValue(value)) fail("invalid_case");
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (stack.has(value)) fail("invalid_case");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertSafeFields(entry, stack);
    } else if (isPlainRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (isForbiddenFieldName(key)) fail("invalid_case");
        assertSafeFields(entry, stack);
      }
    } else {
      fail("invalid_case");
    }
  } finally {
    stack.delete(value);
  }
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function withoutHash(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("invalid_case");
    if (key !== "contentHash") copy[key] = value[key];
  }
  return copy;
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeSolanaReferenceCaseValue(payload), "utf8").digest("hex");
}

function isResolvedMintReport(report: SolanaTokenEvidenceReport, mintAddress: string): boolean {
  if (report.chain !== "solana" || report.assetAddress !== mintAddress || report.historicalTransactions.status !== "not_requested") {
    return false;
  }
  if (report.mint.status !== "present") return false;
  const resolution = report.mint.evidence.resolution;
  return resolution.exists === true && resolution.isMint === true && resolution.mintAddress === mintAddress;
}

function validateReportAndTelemetry(
  report: unknown,
  telemetry: unknown,
  mintAddress: string,
): asserts report is SolanaTokenEvidenceReport {
  if (!isPlainRecord(telemetry) || !Array.isArray(telemetry.requestObservations) ||
      !Array.isArray(telemetry.stageObservations) || !Object.hasOwn(telemetry, "reportElapsedMs")) {
    fail("invalid_case");
  }
  try {
    const projected = deriveSolanaQualificationMetricEvidence(report as SolanaTokenEvidenceReport);
    if (projected.chain !== "solana" || projected.mintAddress !== mintAddress) fail("identity_mismatch");
    if (!isResolvedMintReport(report as SolanaTokenEvidenceReport, mintAddress)) fail("unresolved_mint");
    if (!exactKeys(telemetry, ["schemaVersion", "chain", "requestObservations", "stageObservations", "counts", "reportElapsedMs", "requestObservationCoverage", "providerUsage", "monetaryCost"])) {
      fail("invalid_case");
    }
    const telemetryRecord = telemetry as {
      requestObservations: never[];
      stageObservations: never[];
      reportElapsedMs: number | null;
    };
    const rebuilt = aggregateSolanaReportOperationalTelemetry({
      requestObservations: telemetryRecord.requestObservations,
      stageObservations: telemetryRecord.stageObservations,
      reportElapsedMs: telemetryRecord.reportElapsedMs,
    });
    if (!isDeepStrictEqual(rebuilt, telemetry)) fail("invalid_case");
    if (rebuilt.counts.attemptedRequestCount > SOLANA_REFERENCE_CASE_REQUEST_BUDGET) fail("invalid_case");
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    fail("invalid_case");
  }
}

function validateCase(value: unknown): asserts value is SolanaReferenceCaseV1 {
  if (!isPlainRecord(value) || !exactKeys(value, ["schemaVersion", "caseId", "identity", "capture", "evidenceReport", "limitations", "contentHash"])) {
    fail("invalid_case");
  }
  if (value.schemaVersion !== SOLANA_REFERENCE_CASE_SCHEMA_VERSION || typeof value.caseId !== "string" || !CASE_ID_PATTERN.test(value.caseId)) {
    fail("invalid_case");
  }
  if (!isPlainRecord(value.identity) || !exactKeys(value.identity, ["chain", "mintAddress"]) || value.identity.chain !== "solana" ||
      typeof value.identity.mintAddress !== "string") fail("invalid_case");
  const mintAddress = value.identity.mintAddress;
  if (!isPlainRecord(value.capture) || !exactKeys(value.capture, ["startedAt", "completedAt", "request", "executionBoundary", "captureOrigin", "requestBudgetEnvelope", "operationalTelemetry"])) {
    fail("invalid_case");
  }
  if (value.capture.captureOrigin === "synthetic_test_fixture") fail("synthetic_capture_not_accepted");
  if (!isoDate(value.capture.startedAt) || !isoDate(value.capture.completedAt) ||
      Date.parse(value.capture.completedAt) < Date.parse(value.capture.startedAt) ||
      value.capture.executionBoundary !== "protected_public_execution" ||
      value.capture.captureOrigin !== "protected_application_composition" ||
      value.capture.requestBudgetEnvelope !== SOLANA_REFERENCE_CASE_REQUEST_BUDGET) fail("invalid_case");
  let parsedRequest;
  try {
    parsedRequest = parseSolanaTokenEvidencePublicRequest(value.capture.request);
  } catch {
    fail("invalid_request");
  }
  if (parsedRequest.chain !== "solana" || parsedRequest.assetAddress !== mintAddress ||
      parsedRequest.historicalTransactions.status !== "not_requested") fail("identity_mismatch");
  const limitations = value.limitations;
  if (!Array.isArray(limitations) || limitations.length !== LIMITATIONS.length ||
      !LIMITATIONS.every((limitation, index) => (limitations as unknown[])[index] === limitation)) fail("invalid_case");
  if (!isPlainRecord(value.contentHash) || !exactKeys(value.contentHash, ["algorithm", "canonicalization", "digestHex"]) ||
      value.contentHash.algorithm !== "sha256" || value.contentHash.canonicalization !== SOLANA_REFERENCE_CASE_CANONICALIZATION ||
      typeof value.contentHash.digestHex !== "string" || !HASH_PATTERN.test(value.contentHash.digestHex)) fail("invalid_case");
  if (!isPlainRecord(value.evidenceReport) || value.evidenceReport.assetAddress !== mintAddress) fail("identity_mismatch");
  validateReportAndTelemetry(value.evidenceReport, value.capture.operationalTelemetry, mintAddress);
  assertSafeFields(value);
  canonicalizeSolanaReferenceCaseValue(value);
}

function createHashedCase(payload: Omit<SolanaReferenceCaseV1, "contentHash">): SolanaReferenceCaseV1 {
  const plainPayload = payload as unknown as Record<string, unknown>;
  const digestHex = hashPayload(plainPayload);
  const result: SolanaReferenceCaseV1 = {
    ...payload,
    contentHash: { algorithm: "sha256", canonicalization: SOLANA_REFERENCE_CASE_CANONICALIZATION, digestHex },
  };
  validateCase(result);
  return result;
}

function serializeCase(value: SolanaReferenceCaseV1): string {
  return canonicalizeSolanaReferenceCaseValue(value);
}

/** Parses canonical bytes, validates the report contract, and verifies the content hash. */
export function verifySolanaReferenceCaseArtifact(serialized: string): SolanaReferenceCaseIntegrityResult {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    fail("invalid_case");
  }
  validateCase(value);
  if (serializeCase(value) !== serialized) fail("integrity_mismatch");
  const digest = hashPayload(withoutHash(value as unknown as Record<string, unknown>));
  if (digest !== value.contentHash.digestHex) fail("integrity_mismatch");
  return { referenceCase: value, integrity: "valid", provenance: "capture_path_claim_unverified" };
}

/** Offline-only metric projection. The returned ledger is freshly derived and is not stored in the case. */
export function deriveMetricsFromSolanaReferenceCase(serialized: string) {
  const verified = verifySolanaReferenceCaseArtifact(serialized);
  return deriveSolanaQualificationMetricEvidence(verified.referenceCase.evidenceReport);
}

function pathIsInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  const normalized = rel.toLowerCase();
  return normalized === "" || (!normalized.startsWith(`..${sep}`) && normalized !== ".." && !isAbsolute(rel));
}

async function safeStorageDirectory(directory: string): Promise<string> {
  try {
    await validateStorageDestination(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const realDirectory = await realpath(directory);
    const realWorkingDirectory = await realpath(process.cwd());
    if (pathIsInside(realWorkingDirectory, realDirectory)) fail("invalid_storage_path");
    return realDirectory;
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    fail("invalid_storage_path");
  }
}

async function validateStorageDestination(directory: string): Promise<void> {
  if (typeof directory !== "string" || !isAbsolute(directory)) fail("invalid_storage_path");
  try {
    const lexicalDirectory = resolve(directory);
    if (pathIsInside(resolve(process.cwd()), lexicalDirectory)) fail("invalid_storage_path");
    const realWorkingDirectory = await realpath(process.cwd());
    let existingAncestor = lexicalDirectory;
    for (;;) {
      try {
        const realAncestor = await realpath(existingAncestor);
        if (pathIsInside(realWorkingDirectory, realAncestor)) fail("invalid_storage_path");
        return;
      } catch (error: unknown) {
        if (error instanceof SolanaReferenceCaseError) throw error;
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) throw error;
        existingAncestor = parent;
      }
    }
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    fail("invalid_storage_path");
  }
}

async function safeExistingStorageDirectory(directory: string): Promise<string> {
  if (typeof directory !== "string" || !isAbsolute(directory)) fail("invalid_storage_path");
  try {
    const [realDirectory, realWorkingDirectory] = await Promise.all([realpath(directory), realpath(process.cwd())]);
    if (pathIsInside(realWorkingDirectory, realDirectory)) fail("invalid_storage_path");
    return realDirectory;
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    fail("invalid_storage_path");
  }
}

async function writeCreateOnly(directory: string, caseId: string, bytes: string): Promise<string> {
  if (!CASE_ID_PATTERN.test(caseId)) fail("invalid_case");
  const target = resolve(directory, `${caseId}.json`);
  if (relative(directory, target).startsWith(`..${sep}`) || isAbsolute(relative(directory, target))) fail("invalid_storage_path");
  const temporary = resolve(directory, `.${caseId}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") fail("case_exists");
      fail("storage_failure");
    }
    return target;
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    return fail("storage_failure");
  } finally {
    try { await handle?.close(); } catch { /* Preserve the primary result. */ }
    try { await unlink(temporary); } catch { /* A complete linked file remains valid if cleanup is denied. */ }
  }
}

/** Stores an already-hashed case atomically without overwriting an existing ID. */
export async function writeSolanaReferenceCaseArtifact(value: unknown, storageDirectory: string): Promise<string> {
  validateCase(value);
  const serialized = serializeCase(value);
  verifySolanaReferenceCaseArtifact(serialized);
  const directory = await safeStorageDirectory(storageDirectory);
  return writeCreateOnly(directory, value.caseId, serialized);
}

/** Loads only canonical case filenames from restricted storage and checks their integrity. */
export async function loadSolanaReferenceCaseArtifact(filePath: string): Promise<SolanaReferenceCaseIntegrityResult> {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) fail("invalid_storage_path");
  const normalized = resolve(filePath);
  const fileName = normalized.slice(normalized.lastIndexOf(sep) + 1);
  if (!new RegExp(`^${CASE_ID_PATTERN.source.slice(1, -1)}\\.json$`).test(fileName)) fail("invalid_storage_path");
  const directory = await safeExistingStorageDirectory(resolve(normalized, ".."));
  const safePath = resolve(directory, fileName);
  if (relative(directory, safePath).startsWith(`..${sep}`) || isAbsolute(relative(directory, safePath))) fail("invalid_storage_path");
  try {
    const fileInfo = await lstat(safePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) fail("invalid_storage_path");
    return verifySolanaReferenceCaseArtifact(await readFile(safePath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseError) throw error;
    fail("storage_failure");
  }
}

/** Loads, verifies, then recomputes the existing Phase 4B ledger from the saved report. */
export async function deriveMetricsFromSolanaReferenceCaseFile(filePath: string) {
  const loaded = await loadSolanaReferenceCaseArtifact(filePath);
  return deriveSolanaQualificationMetricEvidence(loaded.referenceCase.evidenceReport);
}

/**
 * Captures one mint through the existing protected public wrapper. The trusted
 * closure retains report/telemetry only in memory; persistence happens only
 * after admission, report generation, cancellation check, budget settlement,
 * and permit release have all succeeded.
 */
export async function captureSolanaReferenceCase(
  mintAddress: string,
  dependencies: SolanaReferenceCaseCaptureDependencies,
): Promise<SolanaReferenceCaseCaptureResult> {
  const request = {
    chain: "solana" as const,
    assetAddress: mintAddress,
    historicalTransactions: { status: "not_requested" as const },
  };
  try {
    parseSolanaTokenEvidencePublicRequest(request);
  } catch {
    fail("invalid_request");
  }
  await validateStorageDestination(dependencies.storageDirectory);
  const startedAt = new Date().toISOString();
  const captureState: { value: { report: SolanaTokenEvidenceReport; operationalTelemetry: SolanaReferenceCaseV1["capture"]["operationalTelemetry"] } | null } = { value: null };
  const executePresentation = async (
    internalRequest: Parameters<typeof generateSolanaTokenEvidenceReportWithTelemetry>[0],
    context: Parameters<typeof generateSolanaTokenEvidenceReportWithTelemetry>[3],
  ) => {
    if (captureState.value !== null) fail("invalid_case");
    const result = await generateSolanaTokenEvidenceReportWithTelemetry(internalRequest, {}, {}, context);
    captureState.value = result;
    return presentSolanaTokenEvidenceReport(result.report);
  };
  await executeSolanaTokenEvidencePublicRequest(request, {
    admissionPolicy: dependencies.admissionPolicy,
    providerRequestBudgetController: dependencies.providerRequestBudgetController,
    executePresentation,
  }, dependencies.signal === undefined ? {} : { signal: dependencies.signal });
  const completedAt = new Date().toISOString();
  const result = captureState.value;
  if (result === null) fail("invalid_case");
  validateReportAndTelemetry(result.report, result.operationalTelemetry, mintAddress);
  const referenceCase = createHashedCase({
    schemaVersion: SOLANA_REFERENCE_CASE_SCHEMA_VERSION,
    caseId: randomUUID(),
    identity: { chain: "solana", mintAddress },
    capture: {
      startedAt,
      completedAt,
      request,
      executionBoundary: "protected_public_execution",
      captureOrigin: "protected_application_composition",
      requestBudgetEnvelope: SOLANA_REFERENCE_CASE_REQUEST_BUDGET,
      operationalTelemetry: result.operationalTelemetry,
    },
    evidenceReport: result.report,
    limitations: LIMITATIONS,
  });
  const canonicalBytes = serializeCase(referenceCase);
  verifySolanaReferenceCaseArtifact(canonicalBytes);
  const filePath = await writeSolanaReferenceCaseArtifact(referenceCase, dependencies.storageDirectory);
  return { referenceCase, filePath };
}

/** Validates the full bounded batch before any work, then captures sequentially with shared controllers. */
export async function captureSolanaReferenceCaseBatch(
  mintAddresses: readonly string[],
  dependencies: SolanaReferenceCaseCaptureDependencies,
): Promise<SolanaReferenceCaseCaptureResult[]> {
  if (!Array.isArray(mintAddresses) || mintAddresses.length < 1 || mintAddresses.length > SOLANA_REFERENCE_CASE_BATCH_LIMIT) {
    fail("invalid_request");
  }
  const seen = new Set<string>();
  for (const address of mintAddresses) {
    try {
      parseSolanaTokenEvidencePublicRequest({ chain: "solana", assetAddress: address, historicalTransactions: { status: "not_requested" } });
    } catch {
      fail("invalid_request");
    }
    if (seen.has(address)) fail("invalid_request");
    seen.add(address);
  }
  const results: SolanaReferenceCaseCaptureResult[] = [];
  for (const address of mintAddresses) results.push(await captureSolanaReferenceCase(address, dependencies));
  return results;
}
