# Token Qualification Engine — Development State

## 1. Purpose and authority

**Token Qualification Engine Project Context V1 remains the authoritative product and methodology baseline.** This document is an implementation-state handoff, not a replacement specification. It records the current checkpoint, established architectural decisions, and intentionally unresolved work. Repository code and tests are authoritative for exact behavior; this summary is not a substitute for inspecting them.

## 2. Current checkpoint

- Branch: `main`
- HEAD and `origin/main`: `0e43876` — `feat: add deterministic Solana holder exclusion assessment`
- The repository is clean at this checkpoint.
- Current validation: `npm test` passed, including its TypeScript build: **422 tests passed, 0 failed**; the separate TypeScript build passed.
- The project began as a Solana-first CLI/JSON prototype. Committed Base/Ethereum work is an evidence-feasibility extension; it is not EVM CLI/product integration.

## 3. Product objective

Given an exact token address, the product aims to produce decision-useful evidence materially better than a basic token dashboard. The intended analysis spans market structure, liquidity, ownership and concentration, economically meaningful participation, activity and momentum, and security/risk. It is not an opaque buy/sell signal. Evidence quality, uncertainty, freshness, and missing information must remain visible.

## 4. Core evidence architecture

The established conceptual pipeline is:

**Source data → Observed facts → Deterministic derived evidence → Qualification assessment → Interpretation**

Calculate objective metrics deterministically wherever practical. AI is primarily for interpreting and explaining already-calculated evidence. A higher layer must not rewrite lower-layer facts. Missing or unknown evidence is not zero, bad, or favorable.

## 5. Cross-chain evidence model

The design distinguishes:

- **U — universal economic evidence:** the economic question is shared across chains.
- **N — normalized-but-chain-derived evidence:** normalized meaning with chain-native acquisition or derivation.
- **C — chain-specific evidence:** mechanics and facts that remain specific to a chain.

The governing rule is: **“Standardize economic questions and evidence semantics, not blockchain mechanics.”** Solana holder structure aggregates token accounts by owner authority; EVM holder structure currently observes balance-bearing addresses. Neither population automatically represents wallets, people, identity, or economic owners.

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

Raw holder evidence remains first-class: raw balances and raw concentration are unchanged. Step 5B-1 is a sidecar assessment; there is no adjusted population or adjusted concentration yet.

These are evidence primitives, not completed holder-quality classifications, qualification scoring, or AI interpretation.

## 7. Implemented EVM feasibility capabilities

**Step 1 — Alchemy RPC contract evidence:** explicit Base/Ethereum chain routing, normalized EVM contract address, selected observation block, contract-code fact, and independent `totalSupply`, decimals, name, and symbol outcomes. Calls are pinned to the selected block where applicable; facts retain their own unavailable/error/malformed states.

**Step 2 — bounded GoldRush holder evidence:** explicit chain and observation block, bounded pagination, normalized exact raw balances, page/count telemetry, provenance, and complete/partial/unavailable/malformed states.

**Step 3 — EVM holder structure:** deterministic raw address-level ranking and positive-balance totals/numerators, with exact supply reconciliation and supply-denominated concentration available only under a conservative same-observation/completeness gate.

**Step 4 — EVM address balance distribution:** positive balance-bearing address population; exact min/max; nearest-rank p25/p50/p75/p90/p99; distinct and repeated balances; a capped deterministic repeated-group listing with uncapped aggregate counts; and cumulative 10/25/50/75/90/99/100 profiles. Integer arithmetic uses `BigInt`; shares use six-decimal half-up rounding. GoldRush coverage and provenance are preserved.

GoldRush `provider_complete` means the provider pagination terminated according to its contract. It does **not** mean blockchain-complete ownership. EVM evidence is not wired into the normal CLI, and EVM DEX market entry, proxy/security analysis, and other product layers remain unimplemented.

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

## 10. Validation and testing posture

Provider normalization and deterministic logic require regression tests before they are trusted. Adversarial tests should cover malformed, contradictory, partial, capped, and unavailable evidence—not only ordinary success fixtures. Normal review gates are `npm run build`, the full `npm test` suite, `git diff --check`, and whitespace checks for new files. At this checkpoint the verified full suite is **422 passing tests**; `npm test` also runs the TypeScript build.

## 11. Cost and operating constraints

Preserve Project Context V1 constraints: the normal development/early-beta operating target is **below $200/month** and the hard architectural operating envelope is **$600/month**. These are project budget constraints, not provider price guarantees.

Prefer progressive analysis, bounded queries and sampling, metric-specific caching/reuse, and per-provider usage/cost telemetry. Avoid unbounded per-wallet/signature fanout and unnecessary AI calls for objective facts. Public/beta precedes payment; actual cost and usage should inform later controls.

Targeted account or transaction investigation should remain bounded and belongs in later participation/forensic analysis where appropriate. Step 5A and Step 5B-1 added zero provider/API calls.

## 12. Explicitly deferred / not implemented

The following are not current product conclusions or implemented classifications:

- Token-2022 extension-specific authority/control analysis; authority revocation/change history; multisig or control interpretation.
- Actual balance exclusions; adjusted holder population; adjusted concentration.
- DEX-specific pool/vault decoding; burn/unspendable, treasury/team/dev, custodial/exchange, vesting/escrow, and bridge classification.
- Dust thresholds; economically meaningful or qualified holder definitions; active, organic, or artificial-holder estimates.
- Funding relationships, common-funder analysis, wallet clustering, and wallet quality.
- EVM DEX market entry; EVM CLI integration; EVM proxy/admin/privileged-function and broader security analysis.
- Honeypot/tax behavior; deterministic swap/trade classification; buyer/seller direction or unique-trader metrics.
- Volume quality, liquidity stability, momentum, launch lifecycle inference, narrative/adoption evidence.
- Calibrated qualification gates, scoring, confidence conclusions, and AI interpretation.

Descriptive evidence already present must not be mislabeled as any of these later conclusions.

Cash Cat, Super Cat, and SANTA remain reference/validation cases only; they are not permanent production scoring benchmarks.

## 13. Next architectural boundary

**Step 5B-2 — adjusted ownership/population view: NOT IMPLEMENTED and NOT YET METHODOLOGICALLY FINALIZED.** The likely boundary consumes raw holder evidence plus the Step 5B-1 assessment, binds each `subjectAddress` and exact `balanceRaw` to the holder snapshot it consumes, and reports auditable totals by decision reconciled against raw evidence. Unresolved subjects remain preserved unless a later explicit, approved policy says otherwise. This step must not silently introduce exclusions or adjusted concentration.

**Step 5B-3 — adjusted concentration: DEFERRED.** Denominator semantics require explicit methodology approval. At least two different questions remain possible: retained Top-N balances divided by original current mint supply, or retained Top-N balances divided by retained balance total. Do not select between them in implementation planning without approval, and do not assume adjusted concentration will affect qualification scoring.

Future work remains subject to reconnaissance, evidence review, bounded implementation, and explicit methodology approval where required. This handoff records the next likely boundary, not authorization to change qualification methodology or scoring.

## 14. Development workflow

- Environment: Windows + PowerShell.
- Repository: `C:\Users\justi\Projects\token-qualification-`
- GitHub: `abop6114/token-qualification-`; primary branch: `main`.
- Secrets belong only in `.env`; never commit or display them.
- Development commonly pairs Codex implementation/review with ChatGPT architectural review. Work one bounded change at a time.
- Perform reconnaissance before architectural or provider changes; review each bounded change before commit and maintain one checkpoint at a time.
- Do not make silent methodology changes.
- Do not commit review scratch artifacts. Commit only after the explicit review gate.

## 15. Fresh-thread startup instruction

> Continue development of the Token Qualification Engine. Use Token Qualification Engine Project Context V1 as the authoritative product/methodology baseline, TQE_DEVELOPMENT_STATE.md as the current implementation handoff, and the repository code/tests as the authority for exact behavior. Review the handoff and recommend the next architectural step before writing code.
