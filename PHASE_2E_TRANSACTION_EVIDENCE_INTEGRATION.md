# Phase 2E — Solana transaction evidence integration

## Purpose and scope

Phase 2E composes previously acquired Solana transaction evidence with the
existing deterministic Phase 2B, 2C, and 2D normalizers. It is a provider-free
integration layer: it does not acquire transactions or issue network requests.
For each eligible Phase 2A candidate, the implemented sequence is:

```text
Phase 2A normalized transaction
        ├── Phase 2B token balance-flow evidence ─┐
        └── Phase 2C token instruction evidence ─┴── Phase 2D reference reconciliation
```

The integration receives the Phase 2A execution result, the original
versioned historical query plan, and the historical sampling evidence from
which the signature selection was made. It preserves these sources and
composes only evidence already present in them.

## Public integration contract

The public function is
`integrateSolanaTransactionEvidence(input)`, exported by
`src/normalization/solanaTransactionEvidenceIntegration.ts`. Its input type is
`IntegrateSolanaTransactionEvidenceInput` in
`src/types/solanaTransactionEvidenceIntegration.ts`:

- `phase2A`: a `SolanaTransactionEnrichmentExecutionResult`;
- `plan`: the original `SolanaHistoricalQueryPlanVersioned`;
- `historicalEvidence`: the corresponding
  `SolanaBoundedHistoricalSamplingEvidence`.

The returned `SolanaTransactionEvidenceIntegrationEvidence` has schema
version `solana-transaction-evidence-integration-v1`, chain `solana`, the
original Phase 2A result retained as `phase2A`, an ordered `candidates` array,
and aggregate `coverage`. Each `candidateIndex` is the zero-based index into
`phase2A.evidence.candidates`; output candidate order is identical to that
source array. An integrated candidate contains `balanceFlow`,
`instructionEvidence`, and `reconciliation`. A `not_eligible` candidate
contains only its index, signature, and status; downstream evidence is not
fabricated for it.

Malformed or inconsistent inputs throw
`SolanaTransactionEvidenceIntegrationInputError`. Its reason is one of
`malformed_input`, `selection_mismatch`, `candidate_mismatch`, or
`telemetry_mismatch`.

## Validation and provenance

Before composing evidence, the normalizer revalidates the Phase 2A selection
against the supplied query plan and historical evidence using
`validateSolanaHistoricalTransactionSelection`. This regenerates the expected
selection from those inputs and compares it with the supplied selection. It
checks linkage and consistency; it is not a cryptographic signature or
independent cryptographic re-verification of a fingerprint.

The integration also checks Phase 2A schema and chain identity, mint and
source-fingerprint linkage, candidate count and order, unique signatures,
source observations, and matching candidate disposition. For selected
candidates it validates that `selectionPosition` equals the sequential
zero-based position among selected signatures, within the five-signature cap.
It checks acquisition/normalization state combinations, transaction signature
identity, and request provenance (Solana, Helius `getTransaction`, request
settings, requested signature, and a parseable fetch timestamp). It
reconciles the Phase 2A telemetry counts and execution-completeness state
against candidate outcomes.

Five is the maximum number of **selected signatures**, not the maximum total
candidate count. The total candidate array may be larger, subject to the
supplied plan's `maximumReturnedRecords` bound. Candidates beyond the selected
signature cap remain in source order as `not_selected` and must retain
`not_attempted` acquisition and normalization outcomes.

The integration does not repeat Phase 2A selection or acquisition. It retains
Phase 2A provenance as supplied and passes its selection and each eligible
candidate's transaction-request provenance to Phase 2B.

## Candidate eligibility

A candidate is eligible for downstream composition only when it is selected,
its Phase 2A acquisition status is `returned`, and its normalization status
is `available` with a normalized transaction whose first signature matches
the candidate signature.

Candidates are not eligible when they were not selected, returned a provider
null, timed out, had a provider or malformed-response error, used an unsupported
transaction version, had malformed transaction structure, or failed source
linkage. Such rows remain represented by their retained Phase 2A result and
receive no Phase 2B, 2C, or 2D output. A transaction whose execution evidence
reports failure remains eligible if its transaction was returned and
successfully normalized. Partial `structuralCompleteness` also does not by
itself prevent integration; each downstream contract reports its own coverage
and uncertainty.

## Downstream composition

For every eligible normalized transaction, the integration calls the existing
deterministic functions in this order:

1. `normalizeSolanaTokenBalanceFlowEvidence` creates Phase 2B transaction-local
   token balance-flow evidence. It receives the Phase 2A historical selection
   and transaction request provenance.
2. `decodeSolanaTokenProgramInstructionEvidence` creates Phase 2C instruction
   observations from the same normalized transaction.
3. `normalizeSolanaReferenceReconciliation` compares the Phase 2B and Phase 2C
   references and execution evidence under Phase 2D's contract.

Phase 2B and Phase 2C consume the same normalized transaction object. Their
results remain separate evidence objects; Phase 2D reconciles references but
does not attribute a transaction-level balance delta to an individual
instruction. Each nested result retains its own provenance, status, and
coverage semantics.

These are observed and deterministically derived evidence, not economic
interpretations. Instruction presence, account references, and balance deltas
do not by themselves identify a trade or its economic effect.

## Coverage semantics

`coverage.candidateSet` reports `candidateCount`, `eligibleCount`, and
`ineligibleCount`, with status:

| Status | Meaning |
| --- | --- |
| `no_candidates` | The supplied Phase 2A selection contains no candidates. |
| `none_eligible` | Candidates exist, but none has eligible normalized transaction evidence. |
| `some_eligible` | At least one candidate is integrated and at least one is ineligible. |
| `all_eligible` | Every supplied candidate is integrated. |

`coverage.downstream` reports counts of integrated candidates whose Phase 2D
coverage is `complete_for_supplied_evidence`, `partial`, `unavailable`, or
`conflicting`. Its status is `not_applicable` when no candidate was
integrated. Otherwise, the precedence is `conflicting`, `partial`,
`unavailable`, then `complete_for_integrated_candidates`.

`complete_for_integrated_candidates` is relative only to the supplied,
integrated candidate evidence. It does not claim exhaustive transaction
history or complete on-chain activity. Phase 2A selection/execution coverage
and each Phase 2B–2D result retain their own meanings; the aggregate does not
upgrade nested evidence or treat ineligible candidates as successful empty
results.

## Limitations and prohibited inference

Phase 2E does not:

- classify a transaction as a buy, sell, swap, trade, or other economic event;
- causally attribute a transaction-level net balance change to an individual
  instruction;
- equate an account owner with beneficial ownership, a wallet, or a person;
- infer that zero net balance change means no activity;
- convert unavailable evidence to zero or to a favorable/adverse risk
  conclusion;
- add or alter token qualification scoring.

## Multi-chain architecture and operating cost

The integration is explicitly Solana-specific because it composes Solana
transaction, SPL instruction, and account-index evidence. The Token
Qualification Engine remains a multi-chain project: economic questions and
normalized evidence semantics can be shared where justified, while Solana
instruction and account-reference mechanics remain in the Solana evidence
layer. This implementation does not generalize Solana mechanics into universal
blockchain rules or implement Base/Ethereum transaction integration.

Because this composition layer makes no provider calls, it adds no transaction
acquisition requests or direct provider API charges. The existing project
budget constraints remain a normal development/early-beta target below
$200/month and a hard architectural envelope of $600/month; these are budget
constraints, not provider price guarantees. This document makes no measured
cost or performance claim.

## Testing and implementation checkpoint

The Phase 2E-2B regression suite covers successful multi-candidate composition
and deterministic ordering; more than five total candidates with only five
selected; sequential selected positions; ineligible Phase 2A outcomes; failed
transaction execution; partial and conflicting downstream evidence; empty
candidate input; malformed wrappers, identities, provenance, and source
linkage; telemetry and completeness reconciliation; unexpected downstream
errors; input non-mutation; and absence of fetch calls.

At implementation commit
`1199e182b0629fa1d2bc9101588ed3e8d9a0deb7`, the recorded Phase 2E-2B
validation results were 13 focused tests passing, 663 full-suite tests
passing, and a successful TypeScript build. These are historical checkpoint
results, not tests newly run for this documentation change.

Implementation paths:

- `src/types/solanaTransactionEvidenceIntegration.ts`
- `src/normalization/solanaTransactionEvidenceIntegration.ts`
- `tests/solanaTransactionEvidenceIntegration.test.cjs`
