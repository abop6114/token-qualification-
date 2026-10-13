# Phase 2D — Solana Reference Reconciliation V1

## Purpose and scope

Solana Reference Reconciliation V1 deterministically compares existing Phase 2B token balance-flow evidence with Phase 2C token instruction evidence. It reports reference relationships and source coverage only. It does not attribute a balance delta to an individual instruction.

The evidence is descriptive: a decoded instruction is an observed instruction record, and a Phase 2B pair is a transaction-level balance observation. Their reference overlap does not establish that the instruction caused the observed balance change.

## Multi-chain architecture

The reconciliation is Solana-specific because it uses Solana transaction account indexes and SPL instruction roles. Those mechanics remain in the Solana evidence layer; this schema adds no Solana account-index assumptions to global qualification contracts. Base, Ethereum, and other chains remain future architectural targets and require their own chain-specific evidence handling.

## Inputs, identity, and provenance

The normalizer consumes:

- `SolanaTokenBalanceFlowEvidence`, schema `solana-token-balance-flow-evidence-v1` (Phase 2B).
- `SolanaTokenProgramInstructionEvidence`, schema `solana-token-program-instruction-evidence-v1` (Phase 2C).

Both inputs are validated before reconciliation, including their supported schema, Solana chain identity, transaction-signature syntax, and structurally required fields. A malformed source throws `SolanaReferenceReconciliationInputError`; it is not converted into a reconciliation result.

When valid source signatures differ, the result has `transactionIdentity.status: "conflicting"`, `executionComparison.status: "not_comparable_identity_mismatch"`, no instruction relationships, no mint comparisons, and `coverage.status: "conflicting"`. Matching signatures produce `transactionIdentity.status: "matched"`.

Output preserves both source schema versions in `sourceSchemas` and source availability/completeness separately in `sourceCoverage`. `instructionSourceIndex` indexes the supplied Phase 2C `instructions` array. `candidatePairIndexes` index the supplied Phase 2B `pairs` array in source order. Instruction `location` preserves the Phase 2C outer/inner location; no source rows are reordered to manufacture a relationship.

## Public API

The exported function is:

```ts
normalizeSolanaReferenceReconciliation(
  balanceFlowInput: SolanaTokenBalanceFlowEvidence,
  instructionEvidenceInput: SolanaTokenProgramInstructionEvidence,
): SolanaReferenceReconciliationEvidence
```

The output schema version is `solana-reference-reconciliation-v1` (`SOLANA_REFERENCE_RECONCILIATION_SCHEMA_VERSION`). Public types are defined in `src/types/solanaReferenceReconciliation.ts`; implementation and runtime input validation are in `src/normalization/solanaReferenceReconciliation.ts`; regression coverage is in `tests/solanaReferenceReconciliation.test.cjs`.

## Account-reference relationships

For each supplied instruction, `instructionRelationships` preserves its source index, location, decode status, supported variant where present, and relationships for decoded `source` and `destination` account roles. Mint references are handled separately below. The statuses mean:

- `index_address_agreement`: the resolved instruction reference and a supplied Phase 2B pair share the canonical account index and report the same token-account address.
- `index_overlap_address_unverified`: the index overlaps, but the Phase 2B pair does not provide a usable token-account address for comparison.
- `index_address_contradiction`: the index overlaps but the reported addresses disagree, or Phase 2B has an applicable account-address conflict.
- `instruction_reference_unresolved`: Phase 2C did not resolve the instruction account address. Any `candidatePairIndexes` are contextual same-index candidates only; they do not assert a match or ambiguity.
- `no_pair_in_supplied_evidence`: comparable Phase 2B evidence was supplied, but no pair uses that account index. This describes only the supplied evidence.
- `ambiguous_account_index`: a resolved reference overlaps multiple pairs, or the supplied evidence identifies multiple mints at that index. Candidate indexes are retained; no pair or mint is selected arbitrarily.
- `not_comparable`: a transaction-wide conflict or unavailable/not-applicable Phase 2B evidence prevents an index comparison.

Partial Phase 2C account space does not invalidate individually resolved references. A Phase 2C transaction-wide account-space conflict prevents index joins. Pair-local Phase 2B conflicts do not suppress unrelated valid relationships; the overall coverage can still be partial.

## Mint-reference comparisons

Only an explicit, resolved Phase 2C account with role `mint_reference` produces a `mintReferenceComparisons` entry. Its statuses are:

- `reported_mint_string_match`: one or more supplied Phase 2B pairs report the referenced mint; all matching pair indexes are returned.
- `reported_mint_string_mismatch`: comparable supplied pairs exist, but none reports that mint string. An unmatched mint string does **not** independently establish a conflict.
- `no_pair_with_reported_mint_in_supplied_evidence`: the supplied comparable Phase 2B pair list is empty.
- `not_comparable`: source coverage or a transaction-wide conflict prevents comparison.

Mint comparisons remain separate from source/destination token-account relationships. No mint is inferred for unchecked `Transfer` instructions.

## Execution comparison

`executionComparison` compares Phase 2B transaction execution evidence with the execution linkage carried by Phase 2C:

- `confirmed_compatible_success`: both sources report success.
- `confirmed_compatible_failure`: both report failure and their reported error values agree structurally.
- `one_or_both_unavailable`: either source lacks definitive execution evidence. Two unavailable states are not agreement.
- `contradictory_definitive_evidence`: one source reports success and the other failure.
- `malformed_or_contradictory_source_evidence`: a source marks execution linkage contradictory, or failure evidence is malformed or inconsistent.
- `not_comparable_identity_mismatch`: valid source signatures differ.

Instruction presence or decoding does not establish that the instruction executed. Execution comparison is transaction-level and does not attribute effects to individual instructions.

## Coverage semantics

`sourceCoverage` retains Phase 2B `balanceFlowStatus` and the Phase 2C outer, inner, processing, and account-space coverage independently. Reconciliation `coverage.status` summarizes what can be reconciled from those supplied inputs:

- `complete_for_supplied_evidence`: identities match; Phase 2B is complete; outer and inner instruction collections are available; instruction processing is complete for supplied entries; account space is consistent; execution is compatible; and no reconciliation reason remains. “Complete” is limited to the supplied evidence and does not mean all on-chain activity was collected.
- `partial`: comparable evidence exists, but a source is partial, a collection or processing is incomplete, account space is partial, or a reference/instruction issue limits the supplied reconciliation.
- `unavailable`: Phase 2B pairs cannot be compared because balance-flow evidence is unavailable or not applicable, or both Phase 2C instruction collections are unavailable.
- `conflicting`: source identities disagree, canonical account space or other transaction-wide flow evidence conflicts, or definitive execution evidence contradicts.

These cases remain distinct:

- Available empty Phase 2B pairs can establish `no_pair_in_supplied_evidence`; this is not the same as unavailable evidence.
- Phase 2B `unavailable` and `not_applicable` produce `not_comparable` account relationships, not successful empty matches.
- A Phase 2B pair-local conflict can coexist with unrelated valid joins, while reconciliation coverage remains partial.
- Partial canonical Phase 2C account space permits comparisons for individually resolved references, but overall coverage remains partial.
- Conflicting canonical Phase 2C account space prevents index joins and makes coverage conflicting.
- Unsupported or malformed instruction entries remain represented by their source decode status and contribute `unsupported_or_malformed_instruction`; they are not silently treated as absent activity.

`coverage.reasonCodes` uses deterministic ordering defined by the implementation. It identifies relevant source and reconciliation limitations; it does not assign a qualification or risk judgment.

## Explicit limitations

This layer does not:

- infer a trade, swap, buy, or sell;
- causally attribute a Phase 2B balance delta to an individual Phase 2C instruction;
- infer economic ownership, wallets, or people from token-account addresses or references;
- convert missing observations into zero;
- claim complete on-chain activity or complete transaction history.

The output is deterministic evidence for later assessment. It is not itself a qualification decision, and it does not replace or redefine the distinction between objective evidence, qualification assessment, and later AI interpretation.

## Validation checkpoint

At the implementation checkpoint commit `14dd46a5b9cbd49e682f1452e200b78738649efb`, the recorded results were 41 focused tests passing, 650 full-suite tests passing, and a passing TypeScript build. These are historical checkpoint results, not tests newly run for this documentation change.

## Future boundaries

Any future numerical attribution between instructions and balance changes requires additional execution-linked evidence and separate approval. Phase 2D authorizes no scoring or qualification-methodology changes.
