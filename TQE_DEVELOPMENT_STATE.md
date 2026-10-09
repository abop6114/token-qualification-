# Token Qualification Engine — Development State

## 1. Purpose and authority

**Token Qualification Engine Project Context V1 remains the authoritative product and methodology baseline.** This document is an implementation-state handoff, not a replacement specification. It records the current checkpoint, established architectural decisions, and intentionally unresolved work. Repository code and tests are authoritative for exact behavior; this summary is not a substitute for inspecting them.

## 2. Current checkpoint

- Branch: `main`
- **Implementation checkpoint: `4938c64` — `feat: propagate partial Solana historical evidence`.** `HEAD` and `origin/main` are synchronized at this checkpoint.
- The repository was clean before this documentation refresh. The implementation checkpoint is `4938c64`; this documentation change is not part of that checkpoint.
- Current full-suite result at the implementation checkpoint: **525 tests passed, 0 failed**. `npm test` includes the TypeScript build.
- The project began as a Solana-first CLI/JSON prototype. Committed Base/Ethereum work is an evidence-feasibility extension; it is not EVM CLI/product integration.

## 3. Product objective

Given an exact token address, the product aims to produce decision-useful evidence materially better than a basic token dashboard. The intended analysis spans market structure, liquidity, ownership and concentration, economically meaningful participation, activity and momentum, and security/risk. It is not an opaque buy/sell signal. Evidence quality, uncertainty, freshness, and missing information must remain visible.

## 4. Core evidence architecture

The established conceptual pipeline is:

**Source data → Observed facts → Deterministic derived evidence → Qualification assessment → Interpretation**

Calculate objective metrics deterministically wherever practical. AI is primarily for interpreting and explaining already-calculated evidence. A higher layer must not rewrite lower-layer facts. Missing or unknown evidence is not zero, bad, or favorable.

## 5. Cross-chain evidence model

The design distinguishes:

- **U — universal economic question/evidence concept:** the economic question is shared across chains.
- **N — normalized/comparable evidence:** use only where semantics genuinely align.
- **C — chain-native acquisition, mechanics, identity, and derivation:** facts that remain specific to a chain.

The governing rule is: **“Standardize economic questions and evidence semantics, not blockchain mechanics.”** TQE remains multi-chain, with Solana as its first production-quality implementation. Solana holder structure aggregates token accounts by owner authority; EVM holder structure currently observes balance-bearing addresses. Solana owner authority ≠ EVM balance-bearing address ≠ person/economic owner. No global evidence interface should be introduced yet; chain-native contracts remain preferred until genuinely normalized semantics are demonstrated. Base/Ethereum production support does not currently require an architectural rewrite, and EVM feasibility components remain separate from normal CLI/product integration.

## 6. Implemented Solana capabilities

The committed Solana path includes:

- Solana public-key syntax validation and deterministic mint resolution through Helius account evidence.
- Classic SPL Token and Token-2022 mint-base parsing, including exact decimals/raw supply and initialized-mint validation. Token-2022 extension parsing is limited to structural mint/account disambiguation and known balance-affecting extension coverage.
- Base `mintAuthority` and `freezeAuthority` COption evidence. These are base-layout facts, not complete Token-2022 authority/security coverage.
- DEX Screener adapter and normalized per-pool market observations; deterministic primary-pool ordering; conservative base/quote metric orientation. Token age and lifecycle remain unknown unless directly supported.
- Helius token-account enumeration, account decoding, owner-authority aggregation, holder structure, supply-based top-1/5/10/20 concentration, and token-account state summary.
- Exact owner-authority balance distribution: min/max, nearest-rank quantiles, repeated exact-balance evidence, and cumulative ascending-balance profiles.
- Bounded historical authority selection, query planning, sequential execution, evidence assembly, provenance/completeness, descriptive time and amount profiles, and separate execution telemetry.
- One-transaction structural evidence normalization for `getTransaction`; this does not classify swaps, buys/sells, funding, or economic behavior.
- Immutable holder snapshots, two-snapshot comparison, and multi-snapshot observed persistence evidence. Absence-to-zero is gated by complete evidence; captures do not imply continuous ownership.
- Development-only Helius transfer-history and single-transaction feasibility probes remain separate from ordinary CLI behavior.

### Phase 1A — bounded Solana holder acquisition

Solana holder acquisition is now bounded by these operational settings:

- Requested page size: **5,000** token accounts.
- Configured maximum: **20 pages**.
- **100,000 returned token-account records** is the maximum before provider termination is required to claim complete enumeration. This is an operational bound, not evidence that 100,000 records are sufficient to cover every token's holders.
- Per-request timeout: **30 seconds**.
- Retries: **zero**.
- There is not yet a total acquisition deadline.

Acquisition distinguishes `complete`, `partial`, and `unavailable`. Complete enumeration requires explicit provider pagination termination. If one or more pages have been accepted and acquisition then stops at a page cap, times out, or encounters a provider or malformed-response failure, the accepted prefix is retained as partial evidence. If failure occurs before any page is accepted, the result is unavailable. Page acceptance is transactional: a page and its observations enter evidence only after that page passes validation. Partial enumeration does not support a global supply-relative Top-N holder concentration claim.

### Phase 1B-1 — partial-aware immutable snapshots

V1 snapshot contracts remain preserved and reproducible. New captures can use immutable snapshot-record V2, which includes acquisition provenance and represents both complete and partial captures. V1 and V2 comparison/series evidence coexist. Balances remain exact observed values; absence from a partial enumeration is unknown, not zero. A partial intermediate capture cannot prove absence or persistence, and partial snapshots do not establish global holder totals.

### Phase 1B-2 — partial-aware Step 5 evidence

Parallel V2 contracts are implemented for address-role evidence, holder-exclusion assessment, the not-excluded owner-authority population, and not-excluded concentration. Existing V1 contracts and behavior are preserved. The policy remains `solana-address-exclusion-policy-v1`; no automatic exclusion rule was added.

Subjects are observed positive owner authorities. Authorities missing from a partial enumeration are not assessment subjects. Exact evidence for an observed row remains usable; a row-level sufficient `retain` decision can remain valid even when the overall candidate population is partial. Unresolved subjects remain included in the not-excluded population. Only explicit policy-authorized `exclude` decisions can be removed.

Concentration V2 preserves two distinct measures:

- **A — `notExcludedTopNCurrentMintSupplyShare`:** unavailable with `enumeration_incomplete` when enumeration is partial. Its numerator is not calculated from the partial frame and presented as a global numerator.
- **B — `notExcludedObservedPopulationTopNShare`:** may be numeric over a positive observed not-excluded denominator, but remains explicitly partial when source evidence is partial.

The documented deterministic partial-reason order is: (1) enumeration incomplete, (2) unsupported balance-affecting extension, (3) supply inconsistency. V1 contracts and raw concentration remain preserved.

### Phase 1B-3 — historical candidate-frame propagation

Historical selection remains over **raw observed positive owner authorities**; it was not switched to the Step 5B-2 not-excluded population. Selector V1 remains preserved. Selector V2 consumes validated snapshot-record V2. Query-plan V1 remains preserved; query-plan V2 consumes snapshot V2 and selector V2. Execution accepts V1 and V2 plans. Historical descriptive metrics remain `solana-historical-descriptive-metrics-v1`.

`observedCandidateFrameRank` is exact only within the observed candidate frame. It is not necessarily a global holder rank. With a partial source frame, rank zero must not be described as the token's largest holder.

Keep these three completeness dimensions separate: (1) source candidate-frame completeness, (2) selection completeness relative to the observed frame, and (3) selected-authority historical query completion. Successful completion of every selected query does not upgrade a partial source frame to complete.

**Step 5A — deterministic address-role evidence** (`0f113e6 feat: add deterministic Solana address role evidence`): the `SolanaAddressRoleEvidence` sidecar records exact address correlations for `base_mint_authority_address`, `base_freeze_authority_address`, and `dexscreener_reported_pool_address`. It adds no provider calls, exclusions, or adjusted concentration, and does not mutate raw holder evidence. Successful mint resolution carries the requested canonical mint address so role evidence cannot combine a different mint resolution with holder or market evidence.

Step 5A records address equality only. DEX Screener `pairAddress` is normalized as `poolAddress`, but current evidence does not establish that it is a reserve vault, SPL token owner authority, LP balance, or economically excludable balance. A pool-address equality is only the narrow factual relationship represented by Step 5A.

**Step 5B-1 — versioned exclusion assessment** (`0e43876 feat: add deterministic Solana holder exclusion assessment`): `SolanaHolderExclusionAssessment` applies the fixed `solana-address-exclusion-policy-v1` to the Step 5A role evidence. It adds no provider/API calls. Its decisions are `exclude`, `retain`, and `unresolved`; evidence sufficiency is `sufficient`, `insufficient`, or `conflicting`. `retain` means only “not excluded by this policy.” It does not mean ordinary holder, investor, organic holder, independent holder, or economic owner. `unresolved` preserves role matches with insufficient evidence and conflicting evidence without treating either as a positive or negative holder classification.

No current Step 5B-1 rule emits `exclude`. Exact mint-authority equality, freeze-authority equality, and DEX pool-address equality each remain unresolved/insufficient. DEX conflicts remain unresolved/conflicting; unavailable or malformed evidence remains unresolved. Only a clean, validated no-match can produce `retain` / `sufficient` / `no_supported_exclusion_rule_matched`, meaning the current versioned policy found no supported exclusion rule in the examined evidence. Aggregate precedence is `exclude > unresolved > retain`.

Before assessment, Step 5B-1 validates chain and mint identity, exact positive-owner-authority subject-set correspondence, capture/enumeration/amount-coverage metadata, market-source discriminants and provenance, supplied-pool counts, and role-finding/source consistency. It also validates amount-coverage relationships. Malformed or contradictory evidence is rejected rather than converted into favorable policy output. DEX no-match validation applies only to the internally consistent supplied snapshot; it does not establish provider-wide or market-wide completeness.

Raw holder evidence remains first-class: raw balances and raw concentration are unchanged. Step 5B-1 is a sidecar assessment. Step 5B-2 derives an auditable not-excluded population, and Step 5B-3 adds separate deterministic concentration views over that population.

**Step 5B-2 — not-excluded owner-authority population evidence** (`9bdbfaa feat: add deterministic Solana not-excluded population evidence`): `SolanaNotExcludedOwnerAuthorityPopulationEvidence` combines a validated `SolanaHolderSnapshotRecord` with its `SolanaHolderExclusionAssessment`. It binds assessment subjects to the exact snapshot population using exact `subjectAddress` and canonical `balanceRaw` matches, uniqueness/set correspondence, consistent shared snapshot metadata, and decision consistency. The snapshot's existing `snapshotId` remains the provenance identifier; the assessment itself does not introduce a snapshot ID or imply that independently supplied IDs matched.

The population semantics remain **observed positive Solana owner authorities**, not wallets, people, investors, or economic owners. Only an explicit `exclude` decision is removed. `retain` and `unresolved` are both included in the `notExcluded` population, without converting unresolved evidence into a positive classification. The current v1 assessment policy emits no `exclude`, so its not-excluded population currently equals the raw observed population. Exact BigInt partition reconciliation verifies the categories against the observed rows; it establishes only arithmetic consistency over those rows, not provider-wide or blockchain-wide completeness.

Partial amount coverage and supply inconsistency—including a negative supply difference—do not prevent exact partitioning of observed rows. Their original evidence states remain intact and are never upgraded. Empty observed populations are supported. This milestone adds no provider or AI calls, exclusions, adjusted concentration, or mutation of raw holder evidence.

These are evidence primitives, not completed holder-quality classifications, qualification scoring, or AI interpretation.

**Step 5B-3 — not-excluded owner-authority concentration evidence** (`20ee0e5 feat: add deterministic Solana not-excluded concentration evidence`): `SolanaNotExcludedOwnerAuthorityConcentrationEvidence` consumes Step 5B-2 evidence only and makes no provider calls. Its pipeline is:

`SolanaHolderSnapshotRecord` / holder evidence → `SolanaAddressRoleEvidence` → `SolanaHolderExclusionAssessment` → `SolanaNotExcludedOwnerAuthorityPopulationEvidence` → `SolanaNotExcludedOwnerAuthorityConcentrationEvidence`.

It reports two distinct Top-N views after ranking the not-excluded population anew by descending exact raw balance, with canonical address as the tie-break. Both use Top 1, 5, 10, and 20, `BigInt` arithmetic, and six-decimal half-up percentage rounding. Results are deterministic and provider-free.

- **`notExcludedTopNCurrentMintSupplyShare` (Metric A):** numerator is the post-exclusion, reranked Top-N not-excluded observed balance; denominator is original current mint supply. Percentages are available only with complete enumeration, complete amount coverage, positive supply, and no supply inconsistency. Holder pages and mint supply are not proven atomically aligned, which remains explicit in provenance. A valid empty not-excluded population with positive, consistent supply can produce exact zero shares.
- **`notExcludedObservedPopulationTopNShare` (Metric B):** numerator is the same reranked Top-N balance; denominator is the total observed not-excluded balance. It describes concentration within that observed population. With a positive denominator, numeric percentages remain available with `completeness: "partial"` when source amount coverage is partial or supply is inconsistent. Partial reasons reflect validated Step 5B-2 evidence; unsupported extensions and supply inconsistency may both be present. A zero observed not-excluded denominator makes this view unavailable, not zero.

The current v1 exclusion policy cannot emit `exclude`, so **`notExcluded = raw`** under this policy. Metric A can therefore numerically equal raw supply-denominated concentration when equivalent availability gates are met; Metric B generally differs because its denominator is observed not-excluded balance rather than mint supply. This is a current-policy identity relationship, not a permanent scoring or methodology assumption. Step 5B-3 preserves raw concentration and does not change the exclusion policy.

The Step 5B-3 contract is intentionally Solana-specific. It introduces neither an EVM equivalent nor a global normalized concentration interface.

These remain descriptive evidence primitives, not holder-quality classifications, qualification scoring, or AI interpretation.

## 7. Implemented EVM feasibility capabilities

**Step 1 — Alchemy RPC contract evidence:** explicit Base/Ethereum chain routing, normalized EVM contract address, selected observation block, contract-code fact, and independent `totalSupply`, decimals, name, and symbol outcomes. Calls are pinned to the selected block where applicable; facts retain their own unavailable/error/malformed states.

**Step 2 — bounded GoldRush holder evidence:** explicit chain and observation block, bounded pagination, normalized exact raw balances, page/count telemetry, provenance, and complete/partial/unavailable/malformed states.

**Step 3 — EVM holder structure:** deterministic raw address-level ranking and positive-balance totals/numerators, with exact supply reconciliation and supply-denominated concentration available only under a conservative same-observation/completeness gate.

**Step 4 — EVM address balance distribution:** positive balance-bearing address population; exact min/max; nearest-rank p25/p50/p75/p90/p99; distinct and repeated balances; a capped deterministic repeated-group listing with uncapped aggregate counts; and cumulative 10/25/50/75/90/99/100 profiles. Integer arithmetic uses `BigInt`; shares use six-decimal half-up rounding. GoldRush coverage and provenance are preserved.

GoldRush `provider_complete` means the provider pagination terminated according to its contract. It does **not** mean blockchain-complete ownership. EVM evidence is not wired into the normal CLI/product path. There is no EVM role evidence, exclusion assessment, not-excluded population, or EVM market adapter; proxy/security analysis and other product layers also remain unimplemented. No production parity is implied.

## 8. Provider strategy

Current adapters are Helius for Solana RPC/indexed evidence, DEX Screener for market observations, Alchemy for deterministic EVM RPC evidence, and GoldRush for bounded indexed EVM token-holder evidence. Adapters are replaceable implementation choices, not permanent methodology commitments.

Prior feasibility work reported successful small controlled GoldRush holder enumeration and operational limitations for very large populations such as USDC. The current tracked repository does not contain the underlying live-response artifact, so treat this as a reported feasibility observation—not a general provider guarantee, completeness claim, or verified cost statement.

## 9. Evidence semantics to preserve

- Token quantities stay exact as canonical decimal strings and `BigInt`; do not pass raw balances through unsafe JavaScript `Number` conversions.
- Ordering and tie-breaking are deterministic.
- Preserve source, method, observation point, freshness, and pagination provenance.
- Never upgrade source coverage or completeness in a derived layer.
- Missing evidence is distinct from numeric zero.
- Successful empty results are distinct from unavailable, malformed, or failed results.
- Provider-reported holder count, retained records, positive-balance population, and economic-owner concepts are separate quantities.
- Pagination completeness is not blockchain-wide ownership completeness.
- Do not silently exclude LP, pool, contract, treasury, team, or other addresses.
- Do not reconcile sources without explicit compatibility evidence or invent a tolerance for block/supply mismatches.
- Solana token accounts/authorities and EVM balance-bearing addresses must retain their chain-native semantics.

## 10. Architectural watch items

These are non-blocking design observations, not requests for immediate refactoring:

- Names such as `OwnerAuthorityBalanceSnapshot` and `OwnerAuthorityBalanceDistribution` encode Solana owner-authority and capture-context semantics. Do not treat them as chain-neutral merely because some calculations resemble EVM address-level calculations.
- `NormalizedMarketSnapshot` is shaped for Solana, Base, and Ethereum, but its `mintAddress` terminology is Solana-specific when consumed for EVM contracts. Do not refactor it now without a concrete contract need.
- Solana holder enumeration's current `complete` type/state must not become a global assertion about holder completeness across chains or providers.
- Normalize a metric across chains only when its population, denominator, observation point, provenance, and coverage have genuinely comparable meanings.

## 11. Validation and testing posture

Provider normalization and deterministic logic require regression tests before they are trusted. Adversarial tests should cover malformed, contradictory, partial, capped, and unavailable evidence—not only ordinary success fixtures. Normal review gates are `npm run build`, the full `npm test` suite, `git diff --check`, and whitespace checks for new files. At implementation checkpoint `4938c64`, the verified full suite is **525 passing tests**; `npm test` also runs the TypeScript build.

## 12. Cost and operating constraints

Preserve Project Context V1 constraints: the normal development/early-beta operating target is **below $200/month** and the hard architectural operating envelope is **$600/month**. These are project budget constraints, not provider price guarantees.

Prefer progressive analysis, bounded queries and sampling, metric-specific caching/reuse, and per-provider usage/cost telemetry. Avoid unbounded per-wallet/signature fanout and unnecessary AI calls for objective facts. Public/beta precedes payment; actual cost and usage should inform later controls.

Targeted account or transaction investigation should remain bounded and belongs in later participation/forensic analysis where appropriate. Steps 5A, 5B-1, 5B-2, and 5B-3 added zero provider/API calls. Phase 1A/1B added no provider or data source, did not increase historical selection or per-authority page/record caps, and does not query additional historical authorities merely because holder enumeration is partial. Partial evidence changes provenance and interpretation, not historical query fanout. Solana token-account acquisition can still be relatively expensive, but is now explicitly bounded by the 20-page guardrail; the bound does not establish provider-wide or blockchain-wide completeness by itself.

## 13. Public presentation boundary

Raw token-account lists, owner-authority candidate lists, provider pages, pagination cursors, and raw historical transaction payloads are internal deterministic evidence. Future public presentation should expose derived or aggregate evidence with appropriate coverage and confidence, rather than dumping raw address or provider data. A partial observed count must not be presented as an exact total-holder count. Exact user-facing wording remains deferred.

## 14. Explicitly deferred / not implemented

The following are not current product conclusions or implemented classifications:

- Token-2022 extension-specific authority/control analysis; authority revocation/change history; multisig or control interpretation.
- Rules that actually emit balance exclusions and adjusted concentration. Step 5B-2 provides a not-excluded observed population; because current v1 policy emits no exclusions, it currently equals the raw observed population.
- A retain-only concentration view remains deferred; Step 5B-3 provides the two not-excluded views and does not add a separate retain-only metric.
- EVM equivalent not-excluded concentration evidence and a global normalized concentration interface remain deferred; no Step 5B-3 contract or cross-chain concentration equivalence is implied.
- An assessment content fingerprint/ID remains deferred; the holder snapshot ID identifies the source capture, not the exclusion assessment content.
- The raw holder snapshot producer/validator partial-coverage compatibility discrepancy remains separate technical debt; Steps 5B-2 and 5B-3 do not resolve it.
- DEX-specific pool/vault decoding; burn/unspendable, treasury/team/dev, custodial/exchange, vesting/escrow, and bridge classification.
- Dust thresholds; economically meaningful or qualified holder definitions; active, organic, or artificial-holder estimates.
- Funding relationships, common-funder analysis, wallet clustering, and wallet quality.
- EVM DEX market entry; EVM CLI integration; EVM proxy/admin/privileged-function and broader security analysis.
- Honeypot/tax behavior; deterministic swap/trade classification; buyer/seller direction or unique-trader metrics.
- Volume quality, liquidity stability, momentum, launch lifecycle inference, narrative/adoption evidence.
- Calibrated qualification gates, scoring, confidence conclusions, and AI interpretation.

Descriptive evidence already present must not be mislabeled as any of these later conclusions.

Cash Cat, Super Cat, and SANTA remain reference/validation cases only; they are not permanent production scoring benchmarks.

## 15. Next architectural boundary

**Step 5B-2 — not-excluded population evidence: IMPLEMENTED.** It consumes the immutable holder snapshot and Step 5B-1 assessment, validates exact subject/balance correspondence, and reports an auditable partition. It does not change raw evidence or calculate concentration.

**Step 5B-3 — not-excluded concentration evidence: IMPLEMENTED at `20ee0e5`.** It consumes Step 5B-2 evidence and reports separate current-mint-supply and observed-not-excluded-population Top-N views under the availability and completeness semantics recorded above. It makes no provider calls, does not mutate raw concentration, and does not change the exclusion policy.

Bounded partial-evidence propagation is complete through the currently implemented Solana holder and historical evidence path. Select the next major implementation priority only after reviewing the updated capability gaps and project objectives; this handoff does not invent or approve a new phase. The existence of concentration evidence does not authorize scoring or qualification integration. Future work remains subject to reconnaissance, evidence review, bounded implementation, and explicit methodology approval where required.

## 16. Development workflow

- Environment: Windows + PowerShell.
- Repository: `C:\Users\justi\Projects\token-qualification-`
- GitHub: `abop6114/token-qualification-`; primary branch: `main`.
- Secrets belong only in `.env`; never commit or display them.
- Development commonly pairs Codex implementation/review with ChatGPT architectural review. Work one bounded change at a time.
- Perform reconnaissance before architectural or provider changes; review each bounded change before commit and maintain one checkpoint at a time.
- Do not make silent methodology changes.
- Do not commit review scratch artifacts. Commit only after the explicit review gate.

## 17. Fresh-thread startup instruction

> Continue development of the Token Qualification Engine. Use Token Qualification Engine Project Context V1 as the authoritative product/methodology baseline, TQE_DEVELOPMENT_STATE.md as the current implementation handoff, and the repository code/tests as the authority for exact behavior. Review the handoff and recommend the next architectural step before writing code.
