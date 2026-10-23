# Protected hosted token lookup

Separate private-pilot entry point: `node dist/hosted/tokenLookupServer.js`.
Build with `npm ci --include=dev && npm run build`; retain
`src/dev/public-report-demo` because assets are loaded relative to the compiled
module. Use the existing Node 24 runtime and `NODE_ENV=production`.
`PORT` is required (1–65535); the executable binds to `0.0.0.0`.

Configuration (never put real values in source or logs):

- `TA_LOOKUP_USERNAME`: 1–64 ASCII letters, digits, dots, underscores or hyphens.
- `TA_LOOKUP_PASSWORD`: 32–128 printable non-space ASCII characters.
- `TA_LOOKUP_ORIGIN`: exact canonical HTTPS origin, with no trailing slash,
  credentials, path, query or fragment. TLS termination must preserve Host.
- `TA_LOOKUP_ANALYSIS_ENABLED`: omitted or `false` disables analysis. Only
  literal `true` enables it; other values fail startup.
- `TA_LOOKUP_REQUEST_BUDGET`: positive safe integer; mandatory when enabled.
  Uses the existing provider-request budget, not dollars or provider credits.
  Capacity below the service's request reservation rejects without dispatch.

No provider credentials are needed for disabled mode or asset startup. A future
enabled pilot uses the existing provider configuration, provisioned separately.
The server never loads an environment file. The synthetic UAT entry point,
configuration, fixture and service remain unchanged.

All assets and responses require Basic authentication. Deploy only behind HTTPS;
this process does not terminate TLS. Exact Host is required for all authenticated
requests and exact Origin for POST `/api/report`. Forwarded headers cannot select
an origin. There is no CORS allowance. Request bodies are limited to 1024 bytes
and ten seconds; the existing service retains its 60-second analysis deadline,
concurrency-one admission, request budget and cancellation behavior. Browser
disconnects abort the request. Only the existing sanitized public report is sent.

Ten authentication failures temporarily block the whole instance for the remainder
of a 60-second window. This bounded mechanism can deny legitimate tester access;
shared Basic credentials do not provide individual user revocation. Both admission
and budget are instance-local; budgets reset on restart and multiply across
replicas. They are not durable spending limits or unrestricted-public abuse controls.

Default disabled mode shows a disclosure and rejects analysis before provider
dispatch; synthetic demonstration remains usable. No HTTP health bypass exists;
use TCP health checks. Auto-deployment must remain off. This milestone authorizes
neither service creation nor changes to the existing Render service.

Before a real pilot: separately approve credentials, budget capacity, exact origin,
single-instance operation, TLS/proxy verification and manual deployment. Before
unrestricted public use: approve durable cost controls and abuse protection.
Project Context V1 is required for new qualification claims or analytical policy;
this entry point changes neither. Validate offline with the hosted server, existing
live-service, browser, and synthetic UAT suites. Test keys/transports are fake.
