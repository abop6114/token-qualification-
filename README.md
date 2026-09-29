# Token Qualification Engine

The Token Qualification Engine is a public resource for early token and meme-coin screening. A user enters an exact contract or mint address and receives an evidence-based analysis of whether the token appears to have economically meaningful participation, credible structure, and usable liquidity, along with the risks and uncertainties that remain.

The project grew from manual token analyses that raised a central question: does apparent holder growth reflect independent participation, or activity such as dusting, rewards, transient wallets, bots, or coordinated distribution? The engine is intended to qualify participation and structure, rather than merely repeat headline market statistics.

## Product boundaries

The engine is a screening and analysis resource. It is not a buy/sell signal generator, an opaque recommendation engine, a substitute for independent investment judgment, or a simple tracker that republishes price, market capitalization, volume, and holder count. It must not assume that each address is an independent investor, that high volume is organic, or that a high holder count proves adoption. Uncertainty must remain visible rather than being hidden behind one score.

Qualification and momentum are separate outputs. Qualification describes whether token structure and participation appear credible enough to warrant attention. Momentum describes whether recent activity is accelerating, stable, or deteriorating. Strong momentum cannot override a material structural failure, and structural credibility alone does not establish attractive current trading conditions.

## Scope and chain direction

V1 starts with Solana to limit provider and normalization complexity. Input resolution must use the exact mint and avoid confusing tokens with similar names or symbols. The architecture should accommodate chain-specific provider adapters and normalized outputs, with EVM support as a later direction; it is not part of the initial Solana-only prototype.

Lifecycle is part of the analysis. Bonding-curve trading before graduation and DEX liquidity after graduation are different market structures. Graduation must not be treated as proof that a token is safe, organic, or good.

## Evidence and analysis method

The analysis pipeline is intended to:

1. Collect raw chain, token, pool, trade, holder, and wallet observations from external providers.
2. Normalize provider-specific observations into common token and wallet schemas.
3. Calculate reproducible metrics with deterministic code.
4. Apply explicit qualification gates, thresholds, and scoring rules.
5. Record data completeness, source agreement, freshness, sampling limits, and unresolved evidence.
6. Explain in plain English what the evidence supports and what remains uncertain.

AI interprets and summarizes normalized evidence. It is not the source of truth for holder counts, concentration, liquidity, transaction counts, or other objective facts. Those measurements and calculations belong in deterministic application logic. Missing or unavailable data is reported as unknown or low confidence; it is not silently converted into either a poor score or a favorable result.

## Holder-quality funnel

Raw holder count is progressively qualified. The report should show counts and conversion between the layers:

- **Raw holders:** all addresses with a non-zero token balance.
- **Qualified holders:** raw holders after excluding identifiable LP/pool addresses, contracts/programs, obvious system addresses, and other non-economic holders.
- **Active holders:** qualified holders with evidence of meaningful wallet or token activity rather than only a passive trivial balance.
- **Organic holders:** active or qualified holders whose acquisition and behavior are more consistent with independent economic participation than dusting, coordinated seeding, rewards-only receipt, or synthetic wallet creation.

The exact meaningful-balance thresholds and organic-holder heuristics remain to be calibrated. An address is not a person: wallet clustering and organic-holder labels are probabilistic analytical estimates, not identity determinations. Holder growth should be compared with transfer and trade growth, balance distributions, acquisition methods and timing, wallet history, and subsequent retention. These signals can weigh against or support a dusting hypothesis, but they do not prove organic adoption.

## Structural gate, qualification, and confidence

The planned model combines a structural pass/fail gate with scored qualification dimensions. A high composite score must never override a material structural failure. Qualification dimensions and current momentum are shown separately, with specific reasons and risk flags rather than a single opaque good/bad result.

Exact gate conditions, score ranges, weights, and thresholds are intentionally not frozen. They should be calibrated on a varied validation set of approximately 25–50 tokens, after comparing deterministic outputs with manual review and examining false positives and false negatives. Confidence accompanies major conclusions and reflects source coverage, freshness, provider agreement, full-wallet analysis versus sampling, and whether key exclusions such as LP and program addresses were resolved. Unknown is a valid result, not a synonym for bad.

## Analysis dimensions and risk indicators

The V1 metric inventory includes:

- **Identity and lifecycle:** exact token identity and chain, age, pool age, bonding or graduation status, and migration where relevant.
- **Market context and tradability:** market capitalization/FDV as scale context, liquidity, volume, liquidity stability, and trading friction. Market capitalization alone is not a qualification metric.
- **Holder quality and retention:** raw, qualified, active, and estimated organic holders; holder growth relative to transfers and trades; meaningful balances; and peak-to-current retention when history is available.
- **Distribution and related wallets:** adjusted Top 1/5/10/20 concentration, largest ordinary wallets after exclusions, wallet-size distribution, dust patterns, clustering, and common funding relationships.
- **Trading participation and volume quality:** unique buyers and sellers where supported, participation breadth, transaction cadence, repeat activity, wallet loops, volume relative to liquidity, and possible wash-like patterns.
- **Security and control:** mint/freeze authority, ownership controls, token-program characteristics, and known security warnings.
- **Momentum and adoption context:** price, volume, holder participation, and liquidity trends, alongside observable narrative or venue/community attention. Attention is not proof of adoption.
- **Risk flags and confidence:** concrete material concerns, coverage gaps, sampling, freshness, and unresolved evidence.

## Progressive analysis and caching

Analysis should progress from a fast market and structure pass to participation and holder analysis, escalating to deeper wallet forensics only where justified. Full wallet analysis can require hundreds or thousands of provider calls, so every lookup should not trigger a new forensic run.

Caching is metric-specific: frequently changing market data can refresh more often, while wallet clustering or security facts can remain cached longer. Repeated public searches should reuse recent analysis. Proposed cache intervals are starting hypotheses to tune using observed cost and volatility, not fixed requirements. Sampling and progressive escalation help control both latency and provider usage.

## Initial architecture direction

Build an analysis engine as a CLI/JSON prototype before investing heavily in a user interface. Start with exact Solana mint resolution, a fast market/lifecycle collection pass, and normalized schemas; then add participation and holder analysis, followed by deeper wallet forensics as warranted. Use replaceable provider adapters and separate collection, normalization, deterministic analysis, qualification, confidence, interpretation, caching, and telemetry responsibilities.

The project context proposes a repository organized around `app/` for future analysis/report/API surfaces and `src/` areas for providers, normalization, analysis, qualification, interpretation, cache, telemetry, and shared types, with tests, fixtures, reference cases, and methodology/provider/decision documentation. EVM provider support is a later extension. The public UI follows prototype validation and calibration rather than preceding them.

## Cost and operating constraints

The normal development and early-beta operating target is **below $200/month**. The hard architectural operating envelope is **$600/month**. These are project budget constraints, not provider price guarantees.

Measure provider and AI usage per analysis; cache and reuse token and wallet intelligence; rate-limit anonymous users; queue or progressively escalate expensive forensic work; and set monthly budget alerts with hard circuit-breaker behavior. Prefer deterministic code for objective calculations, lower-cost AI for routine explanation/classification, and more expensive reasoning only for ambiguous cases. Per-analysis telemetry should eventually record provider calls/credits, AI tokens, compute time, marginal cost, analysis tier, wallets sampled or analyzed, cache status, and reuse by later users.

The initial posture is public/beta rather than paid access. Controls such as bot protection, CAPTCHA where appropriate, per-IP/account quotas, queues, cache reuse, and budget-based throttling are candidates for limiting expensive behavior. Development, APIs, hosting, source code, and billing are to remain separated from work-related resources and under personal accounts.

## Current development status

The source project context is a working V1 methodology and development brief. It does not describe a completed prototype or calibrated scoring model. The immediate development direction is a Solana-only CLI/JSON prototype. Exact thresholds, organic-holder heuristics, final structural-gate conditions, score ranges and weights, provider selection/fallbacks, and several product decisions remain open. Historical Cash Cat, Super Cat, and SANTA observations are reference cases only and must be rerun before figures are presented as current market data.

## Initial development roadmap

1. Set up the personal development environment and keep project resources and billing separate from work-related accounts.
2. Build a Solana-only CLI/JSON prototype with exact mint resolution, fast market/lifecycle collection, and normalized schemas.
3. Implement adjusted concentration, holder distribution, and the initial dusting/organic-participation heuristics with confidence labels.
4. Add participation and holder analysis, then progressive wallet forensics; instrument provider/API usage and marginal cost from the first working prototype.
5. Rerun Cash Cat, Super Cat, and SANTA as reference cases without treating historical snapshots as current.
6. Build and review a 25–50 token validation set spanning varied ages, liquidity, holder distributions, and outcomes. Compare automated output with manual review, investigate classification errors, and only then calibrate thresholds and weights.
7. Stabilize the qualification report and public UI after validation; keep momentum separate, explain evidence and uncertainty, and expose specific risk flags.

Further open questions include meaningful-balance definitions, wallet-history requirements, treatment of rewards and airdrops, evidence needed to flag related wallets, public exposure and persistence of detailed reports, when accounts or Supabase are needed, and whether a paid/supporter tier is useful after actual usage and cost data exist.

