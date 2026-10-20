import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION,
  type PublicReportReviewRegistryV1,
} from "../types/publicReportReviewRegistry";

/**
 * Application-owned source selection. Public request data never chooses this directory or the
 * registry. No case is enabled by default; an approved record must be added through a reviewed
 * application configuration change before this reader can return any case bytes.
 */
export interface SolanaPublicReportCompositionConfiguration {
  readonly registry: PublicReportReviewRegistryV1;
  readCaseArtifactJson(caseId: string): Promise<string | null>;
  readAnalystNoteJson(caseId: string): Promise<string | null>;
}

const VALIDATION_WORKSPACE = path.resolve(
  homedir(),
  "Documents",
  "TokenQualificationEngine",
  "validation-workspace",
);
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EMPTY_REGISTRY: PublicReportReviewRegistryV1 = Object.freeze({
  schemaVersion: PUBLIC_REPORT_REVIEW_REGISTRY_SCHEMA_VERSION,
  records: Object.freeze([]),
});

async function readOptionalJson(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Fixed local lookup; caseId is validated by the service and never interpreted as a path. */
export function getSolanaPublicReportCompositionConfiguration(): SolanaPublicReportCompositionConfiguration {
  const fixedCasePath = (caseId: string, suffix: string): string => {
    if (!CASE_ID.test(caseId)) throw new Error("invalid_case_id");
    return path.join(VALIDATION_WORKSPACE, `${caseId}${suffix}`);
  };
  return Object.freeze({
    registry: EMPTY_REGISTRY,
    readCaseArtifactJson: (caseId: string) => readOptionalJson(fixedCasePath(caseId, ".json")),
    readAnalystNoteJson: (caseId: string) => readOptionalJson(fixedCasePath(caseId, ".analyst-note-v1.json")),
  });
}
