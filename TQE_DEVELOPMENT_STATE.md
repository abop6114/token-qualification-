# Token Qualification Engine — Development State

## 1. Purpose and authority

**Token Qualification Engine Project Context V1 remains the authoritative product and methodology baseline.** This document is an implementation-state handoff, not a replacement specification. It records the current checkpoint, established architectural decisions, and intentionally unresolved work. Repository code and tests are authoritative for exact behavior; this summary is not a substitute for inspecting them.

## 2. Current checkpoint

- Branch: `main`
- HEAD and `origin/main` are synchronized at `9bdbfaa` — `feat: add deterministic Solana not-excluded population evidence`
- The repository was clean at this checkpoint; this documentation refresh is the only intended working-tree change.
- Current validation at the checkpoint: `npm test` passed, including its TypeScript build: **443 tests passed, 0 failed**; the separate TypeScript build passed.
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

**Step 5A — deterministic address-role evidence** (`0f113e6 feat: add deterministic Solana address role evidence`): the `SolanaAddressRoleEvidence` sidecar records exact address correlations for `base_mint_authority_address`, `base_freeze_authority_address`, and `dexscreener_reported_pool_address`. It adds no provider calls, exclusions, or adjusted concentration, and does not mutate raw holder evidence. Successful mint resolution carries the requested canonical mint address so role evidence cannot combine a different mint resolution with holder or market evidence.

Step 5A records address equality only. DEX Screener `pairAddress` is normalized as `poolAddress`, but current evidence does not establish that it is a reserve vault, SPL token owner authority, LP balance, or economically excludable balance. A pool-address equality is only the narrow factual relationship represented by Step 5A.

**Step 5B-1 — versioned exclusion assessment** (`0e43876 feat: add deterministic Solana holder exclusion assessment`): `SolanaHolderExclusionAssessment` applies the fixed `solana-address-exclusion-policy-v1` to the Step 5A role evidence. It adds no provider/API calls. Its decisions are `exclude`, `retain`, and `unresolved`; evidence sufficiency is `sufficient`, `insufficient`, or `conflicting`. `retain` means only “not excluded by this policy.” It does not mean ordinary holder, investor, organic holder, independent holder, or economic owner. `unresolved` preserves role matches with insufficient evidence and conflicting evidence without treating either as a positive or negative holder classification.

No current Step 5B-1 rule emits `exclude`. Exact mint-authority equality, freeze-authority equality, and DEX pool-address equality each remain unresolved/insufficient. DEX conflicts remain unresolved/conflicting; unavailable or malformed evidence remains unresolved. Only a clean, validated no-match can produce `retain` / `sufficient` / `no_supported_exclusion_rule_matched`, meaning the current versioned policy found no supported exclusion rule in the examined evidence. Aggregate precedence is `exclude > unresolved > retain`.

Before assessment, Step 5B-1 validates chain and mint identity, exact positive-owner-authority subject-set correspondence, capture/enumeration/amount-coverage metadata, market-source discriminants and provenance, supplied-pool counts, and role-finding/source consistency. It also validates amount-coverage relationships. Malformed or contradictory evidence is rejected rather than converted into favorable policy output. DEX no-match validation applies only to the internally consistent supplied snapshot; it does not establish provider-wide or market-wide completeness.

Raw holder evidence remains first-class: raw balances and raw concentration are unchanged. Step 5B-1 is a sidecar assessment. Step 5B-2 now derives an auditable not-excluded population, but does not produce adjusted concentration.

**Step 5B-2 — not-excluded owner-authority population evidence** (`9bdbfaa feat: add deterministic Solana not-excluded population evidence`): `SolanaNotExcludedOwnerAuthorityPopulationEvidence` combines a validated `SolanaHolderSnapshotRecord` with its `SolanaHolderExclusionAssessment`. It binds assessment subjects to the exact snapshot population using exact `subjectAddress` and canonical `balanceRaw` matches, uniqueness/set correspondence, consistent shared snapshot metadata, and decision consistency. The snapshot's existing `snapshotId` remains the provenance identifier; the assessment itself does not introduce a snapshot ID or imply that independently supplied IDs matched.

The population semantics remain **observed positive Solana owner authorities**, not wallets, people, investors, or economic owners. Only an explicit `exclude` decision is removed. `retain` and `unresolved` are both included in the `notExcluded` population, without converting unresolved evidence into a positive classification. The current v1 assessment policy emits no `exclude`, so its not-excluded population currently equals the raw observed population. Exact BigInt partition reconciliation verifies the categories against the observed rows; it establishes only arithmetic consistency over those rows, not provider-wide or blockchain-wide completeness.

Partial amount coverage and supply inconsistency—including a negative supply difference—do not prevent exact partitioning of observed rows. Their original evidence states remain intact and are never upgraded. Empty observed populations are supported. This milestone adds no provider or AI calls, exclusions, adjusted concentration, or mutation of raw holder evidence.

These are evidence primitives, not completed holder-quality classifications, qualification scoring, or AI interpretation.

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

Provider normalization and deterministic logic require regression tests before they are trusted. Adversarial tests should cover malformed, contradictory, partial, capped, and unavailable evidence—not only ordinary success fixtures. Normal review gates are `npm run build`, the full `npm test` suite, `git diff --check`, and whitespace checks for new files. At this checkpoint the verified full suite is **443 passing tests**; `npm test` also runs the TypeScript build.

## 12. Cost and operating constraints

Preserve Project Context V1 constraints: the normal development/early-beta operating target is **below $200/month** and the hard architectural operating envelope is **$600/month**. These are project budget constraints, not provider price guarantees.

Prefer progressive analysis, bounded queries and sampling, metric-specific caching/reuse, and per-provider usage/cost telemetry. Avoid unbounded per-wallet/signature fanout and unnecessary AI calls for objective facts. Public/beta precedes payment; actual cost and usage should inform later controls.

Targeted account or transaction investigation should remain bounded and belongs in later participation/forensic analysis where appropriate. Steps 5A, 5B-1, and 5B-2 added zero provider/API calls. Solana token-account enumeration currently continues until explicit provider pagination termination and has no configured page/record cap; this is a future cost/latency consideration for very large tokens, not a change authorized by the completed milestones.

## 13. Explicitly deferred / not implemented

The following are not current product conclusions or implemented classifications:

- Token-2022 extension-specific authority/control analysis; authority revocation/change history; multisig or control interpretation.
- Rules that actually emit balance exclusions and adjusted concentration. Step 5B-2 provides a not-excluded observed population; because current v1 policy emits no exclusions, it currently equals the raw observed population.
- DEX-specific pool/vault decoding; burn/unspendable, treasury/team/dev, custodial/exchange, vesting/escrow, and bridge classification.
- Dust thresholds; economically meaningful or qualified holder definitions; active, organic, or artificial-holder estimates.
- Funding relationships, common-funder analysis, wallet clustering, and wallet quality.
- EVM DEX market entry; EVM CLI integration; EVM proxy/admin/privileged-function and broader security analysis.
- Honeypot/tax behavior; deterministic swap/trade classification; buyer/seller direction or unique-trader metrics.
- Volume quality, liquidity stability, momentum, launch lifecycle inference, narrative/adoption evidence.
- Calibrated qualification gates, scoring, confidence conclusions, and AI interpretation.

Descriptive evidence already present must not be mislabeled as any of these later conclusions.

Cash Cat, Super Cat, and SANTA remain reference/validation cases only; they are not permanent production scoring benchmarks.

## 14. Next architectural boundary

**Step 5B-2 — not-excluded population evidence: IMPLEMENTED at `9bdbfaa`.** It consumes the immutable holder snapshot and Step 5B-1 assessment, validates exact subject/balance correspondence, and reports an auditable partition. It does not change raw evidence or calculate adjusted concentration.

**Step 5B-3 — adjusted concentration: NOT IMPLEMENTED; METHODOLOGY APPROVAL REQUIRED.** Before implementation, explicitly approve which descriptive question(s) the metrics answer. At minimum, these are distinct candidates and could coexist as separate metrics; neither is approved yet:

1. **Not-excluded Top-N balance / original current mint supply:** what fraction of current supply is represented by the observed not-excluded top group?
2. **Not-excluded Top-N balance / not-excluded observed balance total:** how concentrated is the observed not-excluded population internally?

The decision must specify denominator semantics, population, unresolved-subject treatment, evidence coverage, observation compatibility, and presentation. Do not choose or implement a denominator before that methodology approval, and do not assume any result changes qualification scoring.

The next boundary is therefore **Step 5B-3 methodology decision / reconnaissance only**. No implementation should begin until those semantics are approved. Later candidates may include bounded Solana Step 5B-3 implementation if approved, EVM evidence assembly/orchestration, and reconnaissance of EVM role/exclusion evidence; their sequence is not fixed here.

Future work remains subject to reconnaissance, evidence review, bounded implementation, and explicit methodology approval where required. This handoff records the next likely boundary, not authorization to change qualification methodology or scoring.

## 15. Development workflow

- Environment: Windows + PowerShell.
- Repository: `C:\Users\justi\Projects\token-qualification-`
- GitHub: `abop6114/token-qualification-`; primary branch: `main`.
- Secrets belong only in `.env`; never commit or display them.
- Development commonly pairs Codex implementation/review with ChatGPT architectural review. Work one bounded change at a time.
- Perform reconnaissance before architectural or provider changes; review each bounded change before commit and maintain one checkpoint at a time.
- Do not make silent methodology changes.
- Do not commit review scratch artifacts. Commit only after the explicit review gate.

## 16. Fresh-thread startup instruction

> Continue development of the Token Qualification Engine. Use Token Qualification Engine Project Context V1 as the authoritative product/methodology baseline, TQE_DEVELOPMENT_STATE.md as the current implementation handoff, and the repository code/tests as the authority for exact behavior. Review the handoff and recommend the next architectural step before writing code.
