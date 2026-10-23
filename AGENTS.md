# Token Qualification Engine / Token Anatomy — Codex Instructions

## Authoritative project context

Use **Token Qualification Engine Project Context V1** as the authoritative project baseline.

Preserve accepted architecture, qualification methodology, scoring, security boundaries, and report contracts unless the owner explicitly approves a material change.

If the authoritative document is unavailable, report that limitation rather than inventing requirements.

## Product objective

Build an evidence-based cryptocurrency Token Qualification Engine.

The application evaluates market characteristics, liquidity, holder distribution, ownership concentration, wallet quality, organic versus artificial growth, trading activity, momentum, security, and associated risks.

Calculate objective metrics deterministically in application code. Use AI primarily to interpret and explain calculated evidence.

Prioritize Solana initially while retaining future extensibility for Base and Ethereum.

Cash Cat, Super Cat, and SANTA are validation cases, not permanent scoring benchmarks.

## Engineering workflow

Work milestone-first.

For an authorized milestone:

1. Verify the Git baseline and approved scope.
2. Inspect relevant code and tests.
3. Implement the approved change.
4. Run focused tests, build, and relevant regression tests.
5. Correct defects within the approved scope.
6. Review the final diff for security and correctness.
7. Return one concise completion report.

Do not stop for routine implementation decisions that remain within the approved scope.

Stop for material security, methodology, architecture, spending, credential, or authorization conflicts.

## Security and correctness

Preserve:

- Existing D10 report-redaction and public-output contracts.
- Safe browser rendering and sanitized errors.
- Deterministic calculations in code.
- Existing provider and database trust boundaries.
- Least-privilege runtime identities.
- Explicit separation between synthetic UAT and live analysis.
- Secret-free repository files and logs.

Never weaken authentication, TLS verification, or report redaction to make a test pass.

## Infrastructure and costs

Target initial operating costs below $200/month.

Preserve an architectural infrastructure ceiling of $600/month.

Prefer existing providers and the simplest practical implementation.

Avoid new paid services, frameworks, dependencies, or infrastructure layers without a clear requirement.

## Git and deployment boundaries

Do not stage, commit, push, deploy, provision credentials, change DNS, or modify remote database state unless authorized for that action.

Routine local source changes and offline tests may proceed within an approved milestone.

Preserve unrelated work and existing untracked artifacts.

Never force-push or perform destructive cleanup without explicit authorization.

## Reporting

Use concise milestone reports containing:

- Change summary.
- Exact file manifest.
- Build and test results.
- Material risks or limitations.
- Git state.
- Next owner decision, if required.

Do not generate lengthy reports for routine successful work.

Prioritize material blockers over speculative edge cases.

## Development priorities

Favor working product functionality over unnecessary infrastructure investigation.

Complete protected UAT hosting, validate the existing report interface, and continue qualification-engine development.

Do not introduce accounts, subscriptions, report persistence, or live-provider integration into synthetic-only UAT without separate approval.
