# Internal PostgreSQL adapter

TA-INFRA-C adds an isolated adapter only. No analysis path, HTTP route, database,
schema, Auth integration, or deployment uses it. Remote connectivity requires
separate owner authorization. Never pass browser input as configuration or SQL.

## Configuration

Call `parseDatabaseConfiguration` with application-owned environment settings at
the server composition root, then `getDatabaseAdapter` with that approved handle.
Importing the module does not construct a pool. Pool construction does not connect
or execute SQL; an explicit `query` acquires a connection.

| Setting | Contract |
| --- | --- |
| `TA_APP_ENV` | Required: `local`, `uat`, or `production` |
| `TA_DATABASE_URL` | Required PostgreSQL URL with explicit username, password, DNS host, and database; optional port |
| `TA_DATABASE_POOL_MAX` | Default 3; integer 1–10 |
| `TA_DATABASE_CONNECTION_TIMEOUT_MS` | Default 5000; integer 100–30000 |
| `TA_DATABASE_IDLE_TIMEOUT_MS` | Default 10000; integer 1000–60000 |
| `TA_DATABASE_CA_PEM` | Optional PEM trust certificate; otherwise Node's trusted CA roots |

URL query parameters/fragments, IP literals, socket paths, and known administrator
usernames are rejected. Use the exact approved session-pooler DNS endpoint; never
derive it from a project name. URL-encode credential components as needed.
Unknown `TA_DATABASE_*` settings are rejected to prevent ignored security options.
Ambient `PG*` settings are rejected. If `NODE_ENV` is supplied it must be
`development` for local or `production` for UAT/production. A supplied
`NODE_TLS_REJECT_UNAUTHORIZED` must be `1`. Environment configuration must remain
immutable during the process lifetime; restart to apply changes.

TLS always verifies the certificate chain and hostname. There is no plaintext
mode, insecure local exception, or custom hostname-verification override. A custom
CA must be obtained through the approved provider setup and its endpoint trust
validated in the separately authorized connection checkpoint. URL TLS options
are never passed to pg. Configuration handles expose only non-secret settings;
endpoint credentials remain private to the module and pool.

## Lifecycle and failures

The production module registry returns one adapter/pool for equivalent validated
configuration. `createDatabaseRegistry` is an injected test seam, not a per-request
production factory. Pools are scoped to one Node process/module instance; workers
or replicas each have their own pool. Include deployment overlap in capacity sizing.

`query(text, values)` is an internal, single-query API. Use parameterized values.
It acquires and releases explicitly; failed queries destroy their client. It is
not a multi-query transaction API: do not issue separate BEGIN/COMMIT calls through
it. A dedicated transaction helper would require a later reviewed change.
Statement, driver-query, and idle-in-transaction timeouts are fixed at 30 seconds.
No automatic retries, migrations, or reconnection loops are added.

Driver details, SQL, credentials, and original causes never appear in adapter
errors. Errors expose only stable categories. Idle pool errors fail the adapter
closed. `shutdown` prevents new work and delegates draining to pg; repeated calls
share the same result. A closed or faulted adapter is not silently recreated.
Restart after a fault. For credential rotation, drain the old adapter and restart
with owner-provided replacement credentials before revoking the old role access.
No process signal handlers are installed; the future host must call shutdown.
Shutdown relies on pg settling outstanding work; there is no forced-kill timer.

## Future roles and migration requirements

- Runtime: dedicated login, only required schema usage and table operations; no
  schema ownership, DDL, superuser, role administration, or BYPASSRLS.
- Schema owner: separate non-login ownership role. Migration credentials may
  assume this role under explicit approval; runtime credentials may not.
- Migration: separate owner-controlled credential, never part of the running app.
  Reviewed version-controlled migrations, synthetic local tests, explicit approval
  of the UAT target, controlled application, and schema/privilege verification.
- RLS: explicit policies for user-owned data. Direct SQL does not inherit a
  Supabase browser identity. Future user context must be verified server-side and
  scoped to a transaction with cross-user denial tests. Do not bypass RLS to make
  connectivity succeed. Keep the Data API disabled unless separately justified.
- Recovery: disposable synthetic UAT may be rebuilt from approved migrations and
  fixtures. Valuable data requires tested backup/restore coverage before changes.
  Production has separate credentials, migration authorization, and recovery steps.

Role-name rejection is only a guardrail: the adapter cannot inspect actual grants
offline or prove that a custom role is least-privileged. No migration files or SQL
schema definitions are included in this checkpoint.
