import type {
  SolanaCompiledInstructionEvidence,
  SolanaInstructionCollection,
  SolanaInnerInstructionCollection,
  SolanaTransactionAccountReference,
  SolanaTransactionExecutionEvidence,
} from "./solanaTransactionEvidence";

export const SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION =
  "solana-token-program-instruction-evidence-v1" as const;

export type SolanaTokenProgramIdentity = "spl-token" | "token-2022";

export type SolanaSupportedTokenInstructionVariant =
  | "transfer"
  | "transfer_checked"
  | "mint_to"
  | "mint_to_checked"
  | "burn"
  | "burn_checked";

export type SolanaTokenInstructionAccountRole =
  | "source"
  | "destination"
  | "mint_reference"
  | "authority_or_multisig"
  | "additional_signer_reference"
  | "unknown_account_reference";

export interface SolanaTokenInstructionAccountEvidence {
  role: SolanaTokenInstructionAccountRole;
  rolePosition: number;
  reference: SolanaTransactionAccountReference;
}

export interface SolanaTokenInstructionLocation {
  instructionSet: "outer" | "inner";
  outerInstructionIndex: number;
  innerGroupPosition: number | null;
  innerInstructionIndex: number | null;
}

export type SolanaTokenInstructionExecutionLinkage =
  | { status: "available"; evidence: SolanaTransactionExecutionEvidence }
  | { status: "contradictory"; reason: "malformed_execution_evidence" };

export type SolanaTokenInstructionDecodeResult =
  | {
      decodeStatus: "decoded_supported" | "account_reference_unresolved";
      variant: SolanaSupportedTokenInstructionVariant;
      tag: number;
      rawAmount: string;
      decimals: number | null;
      trailingByteCount: number;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "account_reference_unresolved" | null;
    }
  | {
      decodeStatus: "unsupported_variant";
      variant: null;
      tag: number;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "variant_not_supported";
    }
  | {
      decodeStatus: "malformed_payload";
      variant: null;
      tag: number | null;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "empty_data" | "truncated_payload" | "malformed_base58_data";
    }
  | {
      decodeStatus: "source_instruction_unavailable";
      variant: null;
      tag: null;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: [];
      reason: "malformed_compiled_instruction";
    }
  | {
      decodeStatus: "unresolved_program";
      variant: null;
      tag: null;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "program_reference_unresolved";
    }
  | {
      decodeStatus: "unsupported_program";
      variant: null;
      tag: null;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "program_not_supported";
    }
  | {
      decodeStatus: "account_space_conflicting";
      variant: null;
      tag: null;
      rawAmount: null;
      decimals: null;
      trailingByteCount: null;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "transaction_account_space_conflicting";
    }
  | {
      decodeStatus: "malformed_account_list";
      variant: null;
      tag: number;
      rawAmount: null;
      decimals: null;
      trailingByteCount: number;
      accounts: SolanaTokenInstructionAccountEvidence[];
      reason: "required_account_missing" | "too_many_additional_signers";
    };

export interface SolanaTokenProgramInstructionRecord {
  location: SolanaTokenInstructionLocation;
  sourcePosition: number;
  sourceInstruction: SolanaCompiledInstructionEvidence | null;
  sourceInstructionReason: "malformed_compiled_instruction" | null;
  sourceProgram: SolanaTransactionAccountReference | null;
  programIdentity: SolanaTokenProgramIdentity | "unsupported" | "unresolved" | "unavailable";
  /** Original Base58 instruction data when the normalized source entry contains it. */
  dataBase58: string | null;
  decode: SolanaTokenInstructionDecodeResult;
}

export interface SolanaInstructionCollectionCoverage {
  status: SolanaInstructionCollection["status"] | SolanaInnerInstructionCollection["status"];
  reason: string | null;
  reportedCount: number | null;
  suppliedEntryCount: number;
  processedEntryCount: number;
}

export interface SolanaTokenInstructionCoverage {
  outer: SolanaInstructionCollectionCoverage;
  inner: SolanaInstructionCollectionCoverage;
  processing: "complete_for_supplied_instruction_entries" | "partial";
  accountSpace: "consistent" | "partial" | "conflicting";
  reasonCodes: Array<
    | "outer_instructions_unavailable"
    | "outer_instructions_partial"
    | "inner_instructions_unavailable"
    | "inner_instructions_partial"
    | "account_space_partial"
    | "account_space_conflicting"
    | "execution_evidence_contradictory"
  >;
}

/** Solana instruction observations only; no transfer-effect or economic classification is implied. */
export interface SolanaTokenProgramInstructionEvidence {
  schemaVersion: typeof SOLANA_TOKEN_PROGRAM_INSTRUCTION_EVIDENCE_SCHEMA_VERSION;
  chain: "solana";
  transactionSignature: string;
  transactionExecution: SolanaTokenInstructionExecutionLinkage;
  coverage: SolanaTokenInstructionCoverage;
  instructions: SolanaTokenProgramInstructionRecord[];
}
