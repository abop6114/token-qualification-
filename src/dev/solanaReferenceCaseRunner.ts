import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  captureSolanaReferenceCase,
  SolanaReferenceCaseError,
} from "../application/solanaReferenceCase";
import { createSolanaProviderRequestBudgetController } from "../application/solanaProviderRequestBudgetController";
import { createSolanaTokenEvidenceAdmissionController } from "../application/solanaTokenEvidenceAdmissionController";
import { parseSolanaTokenEvidencePublicRequest } from "../application/solanaTokenEvidencePublicRequest";
import { SolanaProviderRequestBudgetError } from "../types/solanaProviderRequestBudget";
import { SolanaTokenEvidenceAdmissionError } from "../application/solanaTokenEvidencePublicExecution";
import { SolanaExecutionCancelledError } from "../types/solanaTrustedExecutionContext";
import type {
  SolanaReferenceCaseCaptureDependencies,
  SolanaReferenceCaseCaptureResult,
} from "../types/solanaReferenceCase";
import type { SolanaTelemetryAcquisitionDisposition } from "../types/solanaReportOperationalTelemetry";

const ACKNOWLEDGEMENT = "--execute-live-capture";
const REQUEST_CAPACITY = 22;
const REPOSITORY_ROOT = resolve(__dirname, "../..");

export type SolanaReferenceCaseRunnerFailure =
  | "invalid_arguments"
  | "acknowledgement_required"
  | "invalid_mint"
  | "invalid_storage_path"
  | "storage_preflight_failed"
  | "missing_helius_configuration"
  | "admission_rejected"
  | "budget_rejected"
  | "cancelled"
  | "unresolved_mint"
  | "capture_failed";

export class SolanaReferenceCaseRunnerError extends Error {
  constructor(readonly reason: SolanaReferenceCaseRunnerFailure) {
    super(`Reference-case runner failed (${reason}).`);
    this.name = "SolanaReferenceCaseRunnerError";
  }
}

export interface SolanaReferenceCaseRunnerArguments {
  mintAddress: string;
  storageDirectory: string;
  executionAcknowledged: true;
}

/** Test seams are available only to local module callers; the command exposes none. */
export interface SolanaReferenceCaseRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  createAdmissionController?: typeof createSolanaTokenEvidenceAdmissionController;
  createBudgetController?: typeof createSolanaProviderRequestBudgetController;
  capture?: typeof captureSolanaReferenceCase;
  storagePreflight?: typeof preflightSolanaReferenceCaseStorage;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
}

function fail(reason: SolanaReferenceCaseRunnerFailure): never {
  throw new SolanaReferenceCaseRunnerError(reason);
}

/** Accepts exactly one mint, one absolute output directory, and the explicit live-capture acknowledgement. */
export function parseSolanaReferenceCaseRunnerArguments(
  argv: readonly string[],
): SolanaReferenceCaseRunnerArguments {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) fail("invalid_arguments");
  let mintAddress: string | undefined;
  let storageDirectory: string | undefined;
  let executionAcknowledged = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mint") {
      if (mintAddress !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith("--")) fail("invalid_arguments");
      mintAddress = argv[++index];
    } else if (argument === "--storage-directory") {
      if (storageDirectory !== undefined || index + 1 >= argv.length || argv[index + 1].startsWith("--")) fail("invalid_arguments");
      storageDirectory = argv[++index];
    } else if (argument === ACKNOWLEDGEMENT) {
      if (executionAcknowledged) fail("invalid_arguments");
      executionAcknowledged = true;
    } else {
      // Positional arguments, history/batch options, and unknown switches fail closed.
      fail("invalid_arguments");
    }
  }

  if (mintAddress === undefined || storageDirectory === undefined) fail("invalid_arguments");
  if (!executionAcknowledged) fail("acknowledgement_required");
  return { mintAddress, storageDirectory, executionAcknowledged: true };
}

function pathIsInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  const normalized = rel.toLowerCase();
  return normalized === "" || (!normalized.startsWith(`..${sep}`) && normalized !== ".." && !isAbsolute(rel));
}

/** Validates an existing directory and proves create/write/delete access without storing a case. */
export async function preflightSolanaReferenceCaseStorage(
  storageDirectory: string,
  repositoryRoot = REPOSITORY_ROOT,
): Promise<string> {
  if (typeof storageDirectory !== "string" || !isAbsolute(storageDirectory)) fail("invalid_storage_path");
  let canonicalRepository: string;
  let canonicalDirectory: string;
  try {
    canonicalRepository = await realpath(repositoryRoot);
    const lexicalDirectory = resolve(storageDirectory);
    if (pathIsInside(canonicalRepository, lexicalDirectory)) fail("invalid_storage_path");
    const info = await lstat(lexicalDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid_storage_path");
    canonicalDirectory = await realpath(lexicalDirectory);
    if (pathIsInside(canonicalRepository, canonicalDirectory)) fail("invalid_storage_path");
    const canonicalInfo = await lstat(canonicalDirectory);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) fail("invalid_storage_path");
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseRunnerError) throw error;
    fail("invalid_storage_path");
  }

  const probePath = resolve(canonicalDirectory, `.tqe-write-probe-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile("offline-storage-preflight", { encoding: "utf8" });
    await handle.sync();
  } catch {
    fail("storage_preflight_failed");
  } finally {
    try { await handle?.close(); } catch { /* Preserve the preflight result. */ }
    if (created) {
      try { await unlink(probePath); } catch { /* A failed cleanup is reported below by the explicit existence check. */ }
    }
  }

  try {
    await lstat(probePath);
    fail("storage_preflight_failed");
  } catch (error: unknown) {
    if (error instanceof SolanaReferenceCaseRunnerError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return canonicalDirectory;
    fail("storage_preflight_failed");
  }
}

function acquisitionState(
  result: SolanaReferenceCaseCaptureResult,
  stage: "market_acquisition" | "holder_acquisition",
): "complete" | "partial" | "unavailable" {
  const observation = result.referenceCase.capture.operationalTelemetry.stageObservations.find((item) => item.stage === stage);
  const disposition: SolanaTelemetryAcquisitionDisposition | null = observation?.acquisitionDisposition ?? null;
  if (disposition === "complete" || disposition === "partial" || disposition === "unavailable") return disposition;
  return "unavailable";
}

function safeFailureReason(error: unknown): SolanaReferenceCaseRunnerFailure {
  if (error instanceof SolanaReferenceCaseRunnerError) return error.reason;
  if (error instanceof SolanaReferenceCaseError) {
    if (error.reason === "unresolved_mint") return "unresolved_mint";
    return "capture_failed";
  }
  if (error instanceof SolanaTokenEvidenceAdmissionError) return "admission_rejected";
  if (error instanceof SolanaProviderRequestBudgetError) return "budget_rejected";
  if (error instanceof SolanaExecutionCancelledError) return "cancelled";
  return "capture_failed";
}

/** Validates all preflight conditions before constructing controllers or invoking capture. */
export async function runSolanaReferenceCaseRunner(
  argv: readonly string[],
  options: SolanaReferenceCaseRunnerOptions = {},
): Promise<number> {
  const writeStdout = options.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = options.writeStderr ?? ((line: string) => console.error(line));
  try {
    const parsed = parseSolanaReferenceCaseRunnerArguments(argv);
    // Reuse the public request parser, fixing history to not_requested.
    try {
      parseSolanaTokenEvidencePublicRequest({
        chain: "solana",
        assetAddress: parsed.mintAddress,
        historicalTransactions: { status: "not_requested" },
      });
    } catch {
      fail("invalid_mint");
    }

    const preflightStorage = options.storagePreflight ?? preflightSolanaReferenceCaseStorage;
    const canonicalStorageDirectory = await preflightStorage(parsed.storageDirectory);
    const environment = options.environment ?? process.env;
    if (typeof environment.HELIUS_API_KEY !== "string" || environment.HELIUS_API_KEY.trim() === "") {
      fail("missing_helius_configuration");
    }

    if ((options.platform ?? process.platform) === "win32") {
      // `icacls` can display ACLs, but reliable effective-access verification (including inheritance) is not portable here.
      writeStderr("Warning: Windows storage ACLs are not verified; manually verify user-only access before live capture.");
    }

    // Construct exactly one shared admission controller and one shared 22-unit budget for this invocation.
    const admissionFactory = options.createAdmissionController ?? createSolanaTokenEvidenceAdmissionController;
    const budgetFactory = options.createBudgetController ?? createSolanaProviderRequestBudgetController;
    const admissionPolicy = admissionFactory({ maxConcurrentExecutions: 1, initiallyEnabled: true });
    const providerRequestBudgetController = budgetFactory({ capacity: REQUEST_CAPACITY, initiallyEnabled: true });
    const capture = options.capture ?? captureSolanaReferenceCase;
    const captureDependencies: SolanaReferenceCaseCaptureDependencies = {
      admissionPolicy,
      providerRequestBudgetController,
      storageDirectory: canonicalStorageDirectory,
    };
    const result = await capture(parsed.mintAddress, captureDependencies);

    const attemptedRequests = result.referenceCase.capture.operationalTelemetry.counts.attemptedRequestCount;
    if (!Number.isSafeInteger(attemptedRequests) || attemptedRequests < 0 || attemptedRequests > REQUEST_CAPACITY) {
      fail("capture_failed");
    }
    const marketState = acquisitionState(result, "market_acquisition");
    const holderState = acquisitionState(result, "holder_acquisition");
    writeStdout(`Status: success\nMint: ${result.referenceCase.identity.mintAddress}\nCase file: ${result.filePath}\nAttempted provider requests: ${attemptedRequests}\nMarket acquisition: ${marketState}\nHolder evidence: ${holderState}`);
    return 0;
  } catch (error: unknown) {
    writeStderr(`Status: failed (${safeFailureReason(error)})`);
    return 1;
  }
}

if (require.main === module) {
  void runSolanaReferenceCaseRunner(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Status: failed (capture_failed)\n");
    process.exitCode = 1;
  });
}
