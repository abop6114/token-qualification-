const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const { inspect } = require("node:util");
const { checkServerIdentity } = require("node:tls");
const { parseDatabaseConfiguration: parse, createDatabaseRegistry, DatabaseError } = require("../dist/platform/database/database.js");

const SECRET = "secret-password-do-not-display";
const endpoint = `postgresql://app_runtime:${SECRET}@database.invalid:5432/uat`;
const environment = (overrides = {}) => ({ TA_APP_ENV: "uat", TA_DATABASE_URL: endpoint, ...overrides });
const safeError = (code) => (error) => {
  assert.ok(error instanceof DatabaseError);
  assert.equal(error.code, code);
  for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
    assert.ok(!rendered.includes(SECRET));
    assert.ok(!rendered.includes(endpoint));
    assert.ok(!rendered.includes("private-sql"));
  }
  assert.equal(error.cause, undefined);
  return true;
};

function fixture(overrides = {}) {
  const calls = { pools: 0, connects: 0, queries: [], releases: [], ends: 0 };
  const pool = new EventEmitter();
  const client = Object.assign(new EventEmitter(), {
    async query(text, values) { calls.queries.push([text, values]); if (overrides.query) return overrides.query(text, values); return { rows: [{ ok: true }], rowCount: 1 }; },
    release(destroy) { calls.releases.push(destroy); if (overrides.release) overrides.release(); },
  });
  pool.connect = async () => { calls.connects++; return overrides.connect ? overrides.connect(client) : client; };
  pool.end = async () => { calls.ends++; if (overrides.end) await overrides.end(); };
  const registry = createDatabaseRegistry((options) => { calls.pools++; calls.options = options; if (overrides.factory) overrides.factory(); return pool; });
  return { calls, pool, client, registry, adapter: registry.get(parse(environment())) };
}

test("configuration is explicit, bounded, opaque, and requires verified TLS", () => {
  const config = parse(environment());
  assert.deepEqual(config, { environment: "uat", maxConnections: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  assert.ok(Object.isFrozen(config));
  assert.ok(!inspect(config).includes(SECRET));
  const { calls } = fixture();
  assert.equal(calls.options.connectionString, undefined);
  assert.equal(calls.options.ssl.rejectUnauthorized, true);
  assert.equal(calls.options.ssl.checkServerIdentity, checkServerIdentity);
  assert.equal(calls.options.host, "database.invalid");
  assert.equal(calls.options.max, 3);
  assert.equal(calls.options.connectionTimeoutMillis, 5000);
  assert.equal(calls.options.idleTimeoutMillis, 10000);
  assert.equal(calls.options.statement_timeout, 30000);
  for (const name of ["local", "uat", "production"]) assert.equal(parse(environment({ TA_APP_ENV: name })).environment, name);
  assert.equal(parse(environment({ TA_DATABASE_URL: endpoint.replace("postgresql:", "postgres:") })).maxConnections, 3);
});

test("rejects missing, malformed, privileged, and ambiguous configuration without echoing values", () => {
  for (const input of [undefined, null, {}, environment({ TA_APP_ENV: undefined }), environment({ TA_APP_ENV: "staging" }), environment({ NODE_ENV: "development" }),
    environment({ TA_DATABASE_URL: undefined }), environment({ TA_DATABASE_URL: "not-a-url" }),
    ...["https://app:pass@database.invalid/db", "postgres://database.invalid/db", "postgres://a:b@database.invalid/", "postgres://a:b@database.invalid/a/b", "postgres://a:b@127.0.0.1/db", "postgres://a:b@database.invalid:0/db", "postgres://a:%ZZ@database.invalid/db", "postgres://a:b@database.invalid/db\n", "postgres://postgres.x:b@database.invalid/db"].map((url) => environment({ TA_DATABASE_URL: url }))]) {
    assert.throws(() => parse(input), safeError("invalid_configuration"));
  }
  const input = environment();
  Object.defineProperty(input, "TA_DATABASE_URL", { get() { throw new Error(SECRET); } });
  assert.throws(() => parse(input), safeError("invalid_configuration"));
  assert.throws(() => fixture().registry.get({ environment: "uat" }), safeError("invalid_configuration"));
});

test("rejects invalid and unbounded pool sizes/timeouts; accepts boundaries", () => {
  const limits = { TA_DATABASE_POOL_MAX: [1, 10], TA_DATABASE_CONNECTION_TIMEOUT_MS: [100, 30000], TA_DATABASE_IDLE_TIMEOUT_MS: [1000, 60000] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    for (const value of ["", "0", "-1", "1.5", "Infinity", "NaN", " 3", "03", "1e3", String(min - 1), String(max + 1), 3]) assert.throws(() => parse(environment({ [key]: value })), safeError("invalid_configuration"));
    for (const value of [min, max]) assert.doesNotThrow(() => parse(environment({ [key]: String(value) })));
  }
});

test("rejects all URL options, TLS weakening, ambient PG options, and invalid CA", () => {
  for (const suffix of ["?sslmode=disable", "?sslmode=require", "?sslmode=verify-full", "?sslrootcert=secret", "?ssl=false", "?host=evil.invalid", "?", "#fragment"]) {
    assert.throws(() => parse(environment({ TA_DATABASE_URL: endpoint + suffix })), safeError("invalid_configuration"));
  }
  for (const override of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { PGSSLMODE: "disable" }, { PGPASSWORD: SECRET }, { TA_DATABASE_TLS: "false" }, { TA_DATABASE_REJECT_UNAUTHORIZED: "false" }, { TA_DATABASE_CA_PEM: SECRET }]) {
    assert.throws(() => parse(environment(override)), safeError("invalid_configuration"));
  }
});

test("supports an explicit trust certificate and retains hostname verification", () => {
  const ca = require("node:tls").rootCertificates[0];
  let options;
  const registry = createDatabaseRegistry((config) => { options = config; return fixture().pool; });
  registry.get(parse(environment({ TA_DATABASE_CA_PEM: ca })));
  assert.equal(options.ssl.ca, ca);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.ok(options.ssl.checkServerIdentity("database.invalid", { subjectaltname: "DNS:other.invalid" }) instanceof Error);
});

test("reuses equivalent configurations and constructs without connecting or executing SQL", () => {
  const { registry, adapter, calls } = fixture();
  assert.equal(registry.get(parse(environment())), adapter);
  assert.equal(registry.get(parse(environment({ TA_DATABASE_POOL_MAX: "3" }))), adapter);
  assert.equal(calls.pools, 1);
  assert.equal(calls.connects, 0);
  assert.deepEqual(calls.queries, []);
  assert.notEqual(registry.get(parse(environment({ TA_DATABASE_POOL_MAX: "2" }))), adapter);
  assert.notEqual(registry.get(parse(environment({ TA_DATABASE_URL: endpoint.replace(SECRET, "rotated") }))), adapter);
});

test("acquires explicitly, forwards parameterized values, and releases on success", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.query("SELECT $1", ["synthetic"]);
  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.equal(calls.connects, 1);
  assert.deepEqual(calls.queries, [["SELECT $1", ["synthetic"]]]);
  assert.deepEqual(calls.releases, [false]);
});

test("sanitizes construction/acquisition errors without retries", async () => {
  assert.throws(() => fixture({ factory() { throw new Error(endpoint); } }), safeError("connection_failed"));
  const { adapter, calls } = fixture({ connect() { throw new Error(endpoint); } });
  await assert.rejects(adapter.query("private-sql"), safeError("connection_failed"));
  assert.equal(calls.connects, 1);
  assert.deepEqual(calls.releases, []);
});

test("sanitizes query errors and destroys the failed client", async () => {
  const { adapter, calls } = fixture({ query() { throw new Error(`${endpoint} private-sql`); } });
  await assert.rejects(adapter.query("private-sql"), safeError("query_failed"));
  assert.deepEqual(calls.releases, [true]);
  assert.equal(calls.connects, 1);
});

test("active client events settle safely across query-promise orderings", async (t) => {
  for (const timing of ["event-only", "event-then-reject", "reject-then-event", "resolve-then-event", "synchronous-event"]) {
    await t.test(timing, { timeout: 2000 }, async () => {
      let resolveQuery, rejectQuery, started;
      const pending = new Promise((resolve, reject) => { resolveQuery = resolve; rejectQuery = reject; });
      const entered = new Promise((resolve) => { started = resolve; });
      const raw = new Error(`${endpoint} private-sql`);
      const { adapter, calls, client } = fixture({ query() {
        assert.equal(client.listenerCount("error"), 1);
        if (timing === "synchronous-event") client.emit("error", raw);
        started();
        return pending;
      } });
      const query = adapter.query("private-sql");
      const rejected = assert.rejects(query, safeError("query_failed"));
      await entered;
      if (timing === "reject-then-event") rejectQuery(raw);
      if (timing === "resolve-then-event") resolveQuery({ rows: [] });
      if (timing !== "synchronous-event") client.emit("error", raw);
      if (timing === "event-then-reject") rejectQuery(raw);
      await rejected;
      assert.deepEqual(calls.releases, [true]);
      assert.equal(client.listenerCount("error"), 0);
      assert.equal(calls.connects, 1);
      // A later rejection must remain observed by the race, with no second disposal.
      rejectQuery(raw);
      await new Promise(setImmediate);
      assert.deepEqual(calls.releases, [true]);
      await adapter.shutdown();
    });
  }
});

test("client failure unblocks shutdown even when its query never settles", { timeout: 2000 }, async () => {
  let started, drained;
  const entered = new Promise((resolve) => { started = resolve; });
  const released = new Promise((resolve) => { drained = resolve; });
  const { adapter, client, calls } = fixture({
    query() { started(); return new Promise(() => {}); },
    release: () => drained(),
    end: () => released,
  });
  const query = adapter.query("private-sql");
  const rejected = assert.rejects(query, safeError("query_failed"));
  await entered;
  const closing = adapter.shutdown();
  assert.equal(adapter.shutdown(), closing);
  await assert.rejects(adapter.query("SELECT 2"), safeError("pool_unavailable"));
  client.emit("error", new Error(`${endpoint} private-sql`));
  await rejected;
  await closing;
  assert.deepEqual(calls.releases, [true]);
  assert.equal(calls.ends, 1);
  assert.equal(client.listenerCount("error"), 0);
});

test("successful repeated queries clean up their listeners and release normally", async () => {
  const { adapter, client, calls } = fixture({ query() {
    assert.equal(client.listenerCount("error"), 1);
    return { rows: [{ ok: true }] };
  } });
  for (let i = 0; i < 25; i++) {
    assert.deepEqual((await adapter.query("SELECT 1")).rows, [{ ok: true }]);
    assert.equal(client.listenerCount("error"), 0);
  }
  assert.deepEqual(calls.releases, Array(25).fill(false));
  await adapter.shutdown();
});

test("release hands error ownership back to the pool before removing the scoped listener", async () => {
  const idle = () => pool.emit("error", new Error(SECRET));
  const { adapter, client, pool, calls } = fixture({ release() {
    assert.equal(client.listenerCount("error"), 1);
    client.on("error", idle); // Model pg-pool's synchronous release handoff.
  } });
  await adapter.query("SELECT 1");
  assert.deepEqual(client.listeners("error"), [idle]);
  client.emit("error", new Error(endpoint));
  await assert.rejects(adapter.query("SELECT 2"), safeError("pool_unavailable"));
  assert.deepEqual(calls.releases, [false]);
  await adapter.shutdown();
});

test("active client error cannot crash an offline subprocess or expose raw driver details", () => {
  const script = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    require('node:net').Socket.prototype.connect = () => { throw new Error('network forbidden'); };
    require('node:tls').connect = () => { throw new Error('network forbidden'); };
    const db = require('./dist/platform/database/database.js');
    const raw = 'synthetic-driver-detail private-sql';
    const client = new EventEmitter();
    let releases = 0;
    client.query = () => {
      setImmediate(() => client.emit('error', new Error(raw)));
      return new Promise(() => {});
    };
    client.release = (destroy) => { assert.equal(destroy, true); releases++; };
    const pool = new EventEmitter();
    pool.connect = async () => client;
    pool.end = async () => { assert.equal(releases, 1); };
    const adapter = db.createDatabaseRegistry(() => pool).get(db.parseDatabaseConfiguration(${JSON.stringify(environment())}));
    const watchdog = setTimeout(() => { process.exitCode = 2; }, 1500);
    (async () => {
      await assert.rejects(adapter.query('private-sql'), error => {
        assert.equal(error.code, 'query_failed');
        for (const value of [String(error), JSON.stringify(error), require('node:util').inspect(error)]) {
          assert.ok(!value.includes(raw));
          assert.ok(!value.includes('private-sql'));
        }
        return true;
      });
      await adapter.shutdown();
      assert.equal(client.listenerCount('error'), 0);
      clearTimeout(watchdog);
      console.log('offline-event-handled');
    })().catch(() => { clearTimeout(watchdog); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, "offline active-client subprocess must succeed");
  assert.equal(result.stdout.trim(), "offline-event-handled");
  assert.equal(result.stderr, "");
});

test("sanitizes release and shutdown failures", async () => {
  const { adapter, calls } = fixture({ release() { throw new Error(endpoint); }, end() { throw new Error(endpoint); } });
  await assert.rejects(adapter.query("SELECT 1"), safeError("release_failed"));
  await assert.rejects(adapter.shutdown(), safeError("shutdown_failed"));
  await assert.rejects(adapter.shutdown(), safeError("shutdown_failed"));
  assert.equal(calls.ends, 1);
});

test("idle pool errors fail closed without exposing driver details", async () => {
  const { adapter, calls, pool } = fixture();
  pool.emit("error", new Error(endpoint));
  await assert.rejects(adapter.query("SELECT 1"), safeError("pool_unavailable"));
  assert.equal(calls.connects, 0);
  await adapter.shutdown();
});

test("shutdown is idempotent, drains active work, and prevents new acquisition", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { adapter, calls, registry } = fixture({ query: () => pending, end: () => pending.then(() => undefined) });
  const query = adapter.query("SELECT 1");
  await Promise.resolve();
  const closing = adapter.shutdown();
  assert.equal(adapter.shutdown(), closing);
  await assert.rejects(adapter.query("SELECT 2"), safeError("pool_unavailable"));
  finish({ rows: [] });
  await query;
  await closing;
  assert.deepEqual(calls.releases, [false]);
  assert.equal(calls.ends, 1);
  assert.equal(registry.get(parse(environment())), adapter);
});

test("client acquired during shutdown is released without executing SQL", async () => {
  let acquired;
  const { adapter, calls, client } = fixture({ connect: () => new Promise((resolve) => { acquired = resolve; }) });
  const query = adapter.query("SELECT 1");
  const closing = adapter.shutdown();
  acquired(client);
  await assert.rejects(query, safeError("pool_unavailable"));
  await closing;
  assert.deepEqual(calls.releases, [true]);
  assert.deepEqual(calls.queries, []);
});

test("real pg construction and shutdown open no sockets, and process registry reuses pools", () => {
  const script = `
    const net = require('node:net'); const tls = require('node:tls');
    let attempts = 0;
    net.Socket.prototype.connect = () => { attempts++; throw new Error('network forbidden'); };
    tls.connect = () => { attempts++; throw new Error('network forbidden'); };
    const assert = require('node:assert/strict');
    const db = require('./dist/platform/database/database.js');
    const env = ${JSON.stringify(environment())};
    const adapter = db.getDatabaseAdapter(db.parseDatabaseConfiguration(env));
    assert.equal(adapter, db.getDatabaseAdapter(db.parseDatabaseConfiguration(env)));
    adapter.shutdown().then(() => { assert.equal(attempts, 0); }, () => { process.exitCode = 1; });
  `;
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG") && key !== "NODE_TLS_REJECT_UNAUTHORIZED"));
  const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), env: cleanEnvironment, encoding: "utf8" });
  assert.equal(result.status, 0, "offline construction subprocess must succeed");
});

test("existing application source does not import the database module", () => {
  const root = path.resolve(__dirname, "../src");
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (file === path.join(root, "platform")) continue;
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith(".ts")) assert.doesNotMatch(readFileSync(file, "utf8"), /platform\/database/);
    }
  }
  visit(root);
});
