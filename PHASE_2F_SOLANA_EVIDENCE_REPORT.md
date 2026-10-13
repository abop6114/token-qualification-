# Phase 2F — Solana Token Evidence Report Service

## Purpose and scope

Phase 2F adds the first callable application-level consumer of TQE's existing Solana evidence pipeline. The report service assembles evidence for one Solana mint; it does not score, recommend, qualify, or interpret evidence with AI.

The service is internal. It is not connected to the CLI, an HTTP endpoint, or a public user interface.

## Entry point and request

The callable entry point is `generateSolanaTokenEvidenceReport`, implemented in `src/application/solanaTokenEvidenceReport.ts`. Its request type is `GenerateSolanaTokenEvidenceReportRequest` in `src/types/solanaTokenEvidenceReport.ts`:

```ts
interface GenerateSolanaTokenEvidenceReportRequest {
  chain: "solana";
  assetAddress: string;
  historicalTransactions: SolanaHistoricalReportRequest;
}
```

`assetAddress` must be syntactically valid Solana public-key text. The historical choice is required; omitting it is an invalid request. A requested window uses the existing inclusive-start/exclusive-end Unix-seconds type and must contain nonnegative safe integers with the exclusive end greater than the start. Request validation occurs before provider calls. The request does not accept caller-selected caps, timeouts, or provider URLs.

History not requested:

```ts
await generateSolanaTokenEvidenceReport({
  chain: "solana",
  assetAddress: mintAddress,
  historicalTransactions: { status: "not_requested" },
});
```

History requested:

```ts
await generateSolanaTokenEvidenceReport({
  chain: "solana",
  assetAddress: mintAddress,
  historicalTransactions: {
    status: "requested",
    requestedWindow: {
      fromUnixSecondsInclusive: start,
      toUnixSecondsExclusive: end,
    },
  },
});
```

These examples use the production provider defaults and require their existing configuration. Offline tests inject provider/acquisition functions; the examples do not imply that a call can succeed without configured providers.

## Report contract

The internal report schema is `solana-token-evidence-report-v1`, with these top-level fields:

- `schemaVersion`
- `chain`
- `assetAddress`
- `generatedAt`
- `mint`
- `market`
- `holders`
- `historicalTransactions`

`generatedAt` is the report assembly timestamp. It does not establish atomic acquisition or same-slot consistency across sections.

## Section statuses

Sections use `present`, `unavailable`, or `not_attempted`. Only `historicalTransactions` may also use `not_requested`.

Section status is distinct from the coverage and availability states nested in existing evidence. A `present` section can contain partial, unavailable, or conflicting nested evidence. For example, an accepted prefix of holder pages can yield a present holder section whose enumeration remains partial. Confirmed account absence and a confirmed existing account that is not a supported mint are determinate mint evidence, so they are represented as `present`; dependent sections are `not_attempted` because mint resolution did not succeed.

## Evidence sections

### Mint

The service uses the existing Helius account provider and deterministic mint normalizer. It preserves classic SPL Token and Token-2022 base mint results. Resolved mint evidence includes the existing Token-2022 mint-extension inventory result (which is `not_applicable` for a classic SPL mint). Confirmed account-not-found and existing-non-mint results remain distinct from provider unavailability.

### Market

For a resolved mint, the service acquires DEX Screener observations and passes them to the existing market snapshot normalizer. The report preserves eligible pools, deterministic primary-pool selection, per-metric availability, and provenance. A valid empty response is present market evidence with no returned pools; it is not a provider failure.

### Holders

For a resolved mint, the service uses the existing bounded Helius token-account acquisition, then the existing normalizers to assemble holder structure, owner-authority balance distribution, and an immutable V2 holder snapshot. Complete and partial enumeration states and acquisition provenance are preserved. Raw provider pages and opaque pagination cursors are not included in the report. An owner authority is not verified beneficial ownership or a person.

Expected holder acquisition failures are returned by the provider boundary as `status: "unavailable"` when no page was accepted; accepted pages followed by a failure remain partial evidence. The service does not convert unavailable data into zero holders. Unexpected thrown errors propagate.

### Historical transactions

Historical processing is opt-in. When requested and a holder snapshot is present, the service reuses, in order:

1. V2 historical authority selection.
2. V2 historical query planning.
3. Bounded historical query execution.
4. Deterministic descriptive metrics.
5. Historical transaction candidate selection.
6. Phase 2A transaction enrichment for selected signatures.
7. Phase 2E integration of Phase 2A, 2B, 2C, and 2D evidence.

The service preserves the existing typed outputs and coverage rather than flattening them. A partial holder snapshot may be used where the existing V2 selection/planning contracts permit it, and that partial source state remains visible. If holder evidence is unavailable, requested history is `not_attempted`; it depends on holder evidence, not market success.

Transaction-level balance deltas and instruction evidence do not establish a trade, swap, buy, or sell. They do not assign a transaction-level delta causally to an individual instruction, identify a beneficial owner, or prove economic ownership.

## Acquisition limits

The implementation fixes these service-level bounds:

| Boundary | Limit |
| --- | ---: |
| Token-account enumeration | 20 pages |
| Token accounts per page | 5,000 |
| Token-account request timeout | 30 seconds per request |
| Historical authorities selected | 1 |
| Historical pages per authority | 2 |
| Historical records per authority | 150 |
| Historical page request limit | 100 records |
| Historical request timeout | 30 seconds per request |
| Transaction enrichments | 5 unique signatures |
| Transaction enrichment timeout | 30 seconds per request |
| Mint account request timeout | 30 seconds |
| DEX Screener request timeout | 30 seconds |

Historical pages and transaction enrichments execute sequentially. Existing provider acquisition does not add retries or concurrency. At the configured bounds, a full path has at most 1 mint-account request, 1 market request, 20 token-account page requests, 2 historical page requests, and 5 transaction requests: 29 requests total. This is a request-count bound, not a provider-credit estimate or cost guarantee; actual credits and monthly cost have not been measured by this phase.

## Failure behavior

- Invalid request data fails with `SolanaTokenEvidenceReportRequestError` before provider calls.
- Mint provider unavailability marks mint unavailable and dependent sections not attempted.
- Confirmed missing-account and non-mint outcomes are not provider failures.
- After mint resolution, market and holder acquisitions are independent. A typed expected failure in one does not erase evidence from the other.
- Holder expected acquisition failures use the provider's returned unavailable result; unexpected thrown errors are not relabeled as provider failures.
- History requires usable holder evidence, but does not require market success.
- The service exposes typed error categories and fixed reasons, not API keys, authenticated URLs, raw provider bodies, or arbitrary exception messages.

## Cost and operational boundaries

Project Context V1 sets the normal development/early-beta operating target below **$200/month** and the hard architectural operating envelope at **$600/month**. These are project budget constraints, not provider price guarantees.

Phase 2F has no live cost benchmark or verified provider-credit measurement. It adds no provider, paid dependency, AI call, or database. Caching, scheduling, background execution, and production deployment have not been added. The request bounds constrain this service's fanout; they do not demonstrate a monthly operating cost.

## Limitations and next steps

Phase 2F does not provide a public endpoint or UI, qualification assessment or scoring, or AI interpretation. Historical evidence is bounded to the selected authorities, requested interval, caps, and provider results; it is not lifetime or provider-wide history. Holder authorities are not verified economic owners. Base and Ethereum report-service support has not been implemented. Production performance, load, and cost have not been validated.

Further application integration or analysis may be considered in later approved phases; this document does not declare production readiness or pre-approve subsequent functionality.
