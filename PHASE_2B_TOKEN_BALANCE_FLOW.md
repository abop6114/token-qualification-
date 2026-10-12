# Phase 2B — Solana token balance-flow evidence

## Purpose and boundary

Phase 2B adds the deterministic, transaction-local evidence contract
`solana-token-balance-flow-evidence-v1`. Its input is an existing
`SolanaTransactionEvidence`; callers may optionally supply Phase 2A selection
and transaction-request context for provenance linkage. The implementation is
the Solana-specific normalizer in
`src/normalization/solanaTokenBalanceFlowEvidence.ts`, with public types in
`src/types/solanaTokenBalanceFlowEvidence.ts`.

The normalizer performs no provider requests. It does not change Phase 2A
signature selection, acquisition, or provider behavior. The output is
versioned and Solana-specific; it is not a global cross-chain flow schema.

## Pair identity and observations

Each pair is keyed by the transaction-local tuple `(accountIndex, mint)`. The
normalizer pairs explicitly reported pre- and post-token-balance observations
using that identity. It retains the source provider-array indexes on each pair
and preserves unpaired observations in `unmatchedObservations`; indexes and
rows are not silently discarded or filled with inferred zero balances.

For each pair, the output keeps `preOwner` and `postOwner` independently, as
well as token-account address evidence. Owner values are descriptive fields,
not proof of identity or economic ownership. When the token-account address
is unresolved but the account-index/mint pair is otherwise valid, an exact
index-scoped delta can remain available; the result is marked partial through
`unresolved_account_address`.

Only an exact provider non-negative integer-string amount representation can
be used as a raw amount. The normalizer revalidates the amount evidence
tuple and calculates:

`rawDelta = postRawAmount - preRawAmount`

using `BigInt`. The signed result is serialized as a decimal string. Numeric,
decimal-string, missing, null, malformed, and UI-only representations do not
produce exact deltas. Both sides must have available, equal decimals. Missing
or malformed decimals prevent the delta; differing decimals are a conflict.

This is a token-account balance delta for one transaction. By itself it is
not evidence of a token transfer, swap or trade, buy or sell, wallet-level net
flow, economic-owner-level flow, or organic or artificial activity. A positive
or negative delta does not establish any of those interpretations.

## Deterministic validation and conflict handling

The normalizer validates the transaction signature and token-balance side
shapes before deriving pairs. It does not use unrelated instruction
completeness to determine balance-flow completeness.

Pair identity and evidence are handled deterministically:

- Duplicate `(accountIndex, mint)` keys on either side are reported as
  `duplicate_pair_key`; they are not collapsed.
- Multiple mints at one account index on the same side are reported as
  `account_index_multiple_mints`; those index pairs are excluded.
- A pre/post mint difference at the same index remains unmatched on both
  sides; it is not zero-filled or treated as a matched pair.
- Address, amount-evidence, and decimals contradictions are pair-local where
  possible. They withhold that pair's delta without necessarily withholding
  unaffected pairs.
- Transaction-wide canonical account-space contradictions—including a
  noncanonical order marker, noncontiguous account indexes, duplicate
  addresses, source ordering inconsistent with static/writable/readonly
  order, or loaded addresses in a non-complete account space—produce the
  `account_space_conflicting` reason and prevent available raw deltas.
- Balance-side structural contradictions produce
  `balance_side_conflicting` and prevent available raw deltas.

The normalizer does not infer token-program behavior from these observations
and performs no Token-2022 extension interpretation.

## Status and completeness semantics

The public status values are exactly:

| Status | Implemented meaning |
| --- | --- |
| `complete` | The explicitly reported pre/post token-balance arrays were reconciled under this normalizer's identity and exactness rules. It does not establish that every on-chain token activity was observed. |
| `partial` | The reported observations support only partial reconciliation, for example because rows are unmatched, a token-account address is unresolved, or required exact pair evidence is unavailable. |
| `unavailable` | Execution state is unknown, or at least one required token-balance side is unavailable. |
| `conflicting` | Execution, account-space, balance-side, or pair evidence contains a contradiction that prevents a consistent result. |
| `not_applicable` | The transaction is explicitly confirmed failed. No available raw delta is emitted. |

Status precedence in the implementation is: confirmed failure (`not_applicable`),
contradictory execution (`conflicting`), unavailable execution (`unavailable`),
unavailable required balance side (`unavailable`), detected conflicts
(`conflicting`), partial evidence (`partial`), then `complete`.

Completeness applies only to explicit array observations. Two explicitly
available empty arrays can yield `complete` with no pairs; that does not prove
zero token activity. A missing, null, or otherwise unavailable side is not an
empty array. If one required side is unavailable, the transaction result stays
`unavailable`, no pair delta is emitted, and observations from the available
side are retained as unmatched with reason `balance_side_unavailable`.

Unmatched observations are not assigned a zero balance. Non-exact amounts,
missing or inconsistent decimals, duplicate pair keys, and same-side
multiple-mint contradictions do not become favorable or silently resolved
evidence. Isolated pair-local conflicts need not invalidate other pairs.
Optional owner unavailability alone does not prevent exact arithmetic or
complete reconciliation.

## Reason codes and conflict records

`reasonCodes` are emitted in the fixed order declared by `REASON_ORDER` in the
normalizer. They include transaction execution, balance-side, account-space,
pair-identity, unmatched-observation, amount, decimals, and address outcomes.
The `conflicts` array records pair/index-local duplicate, multi-mint,
address, decimals, and amount conflicts with source row indexes. A
transaction-wide account-space conflict is surfaced through status,
`reasonCodes`, and the affected pair deltas' unavailable reason; it has no
single pair identity to place in the row-scoped `conflicts` records.

## Optional Phase 2A provenance linkage

When supplied, `phase2A` retains the selected source fingerprint,
historical-plan version, requested time window, source coverage, selection
position, source-observation references, and transaction request provenance
supported by the input types. The normalizer checks the fingerprint's
`sha256:` shape and checks that linked references use the same supplied
fingerprint. It also validates the selected signature and request linkage.

These are structural consistency and linkage checks. Phase 2B does **not**
independently recompute the Phase 2A fingerprint and makes no claim of
cryptographic re-verification. Omitting linkage context yields `phase2A: null`.

No provider request is added, and Phase 2B does not alter Phase 2A selection.

## U/N/C architecture reconciliation

Under the project's U/N/C classification, the Phase 2B schema and normalizer
are **C — chain-specific mechanics**. They depend on Solana transaction
metadata, SPL-style pre/post token-balance arrays, account indexes, loaded
address resolution, and mint identity.

Future normalized evidence about economic activity may be **N — normalized
but chain-derived evidence** only after its semantics are shown to align. The
universal questions about concentration, activity quality, and organic
participation are **U**, but Phase 2B does not directly answer them. No
global flow schema is introduced or specified here. This preserves the rule
to standardize economic questions and evidence semantics, not blockchain
mechanics.

Downstream interpretation must preserve the source, coverage, uncertainty,
and conflict states. It must not promote these transaction-local deltas into
transfer/trade labels, buyer/seller conclusions, wallet quality, clustering,
economic ownership, or qualification scores without additional supporting
evidence and an approved methodology.

## Limitations and deferred work

Phase 2B does not establish:

- transfer, swap, or trade classification;
- buy/sell direction or counterparty identity;
- wallet-level or economic-owner-level net flow;
- wallet quality, organic/artificial participation, or holder quality;
- market momentum or token-level aggregate flow;
- security or risk-scoring conclusions.

These are deferred; they must not be inferred from a token-account balance
delta alone.

## Implementation and test traceability

- Types: `src/types/solanaTokenBalanceFlowEvidence.ts`
- Normalization: `src/normalization/solanaTokenBalanceFlowEvidence.ts`
- Upstream transaction evidence: `src/types/solanaTransactionEvidence.ts` and
  `src/normalization/solanaTransactionEvidence.ts`
- Phase 2A linkage types and selection: `src/types/solanaHistoricalTransactionSelection.ts`
  and `src/normalization/solanaHistoricalTransactionSelection.ts`
- Regression tests: `tests/solanaTokenBalanceFlowEvidence.test.cjs`

The Phase 2B implementation checkpoint recorded **585 passing tests**. This
documentation-only checkpoint did not rerun the suite; the figure is a
checkpoint baseline, not a test result from this documentation change.

## Findings and open questions

No discrepancy was identified between the Phase 2B behavior documented here
and the committed normalizer/type contract inspected for this checkpoint.
The main integration boundary remains explicit: future economic or
cross-chain interpretation must retain Solana-specific provenance and must
not equate token-account deltas with transfers, wallet flows, or economic
ownership.
