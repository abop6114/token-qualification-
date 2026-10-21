import { createHash, X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { Pool, type PoolConfig, type QueryResult } from "pg";

export type DatabaseErrorCode = "invalid_configuration" | "connection_failed" | "query_failed" | "release_failed" | "pool_unavailable" | "shutdown_failed";

/** Never retain a driver error, cause, endpoint, SQL, or parameters. */
export class DatabaseError extends Error {
  constructor(readonly code: DatabaseErrorCode) {
    super(`Database operation failed: ${code}.`);
    this.name = "DatabaseError";
  }
}

export interface DatabaseConfiguration {
  readonly environment: "local" | "uat" | "production";
  readonly maxConnections: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
}

const approved = new WeakMap<DatabaseConfiguration, { key: string; options: PoolConfig }>();

/** Call only at the server composition root, never with HTTP request data. */
export function parseDatabaseConfiguration(environment: Readonly<Record<string, string | undefined>>): DatabaseConfiguration {
  try {
    const setting = (key: string): string | undefined => {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (!descriptor) return undefined;
      if (!("value" in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== "string")) throw new Error();
      return descriptor.value;
    };
    const designation = setting("TA_APP_ENV");
    const supported = new Set(["TA_DATABASE_URL", "TA_DATABASE_POOL_MAX", "TA_DATABASE_CONNECTION_TIMEOUT_MS", "TA_DATABASE_IDLE_TIMEOUT_MS", "TA_DATABASE_CA_PEM"]);
    if (Object.keys(environment).some((key) => key.startsWith("TA_DATABASE_") && !supported.has(key) && setting(key) !== undefined)) throw new Error();
    if (designation !== "local" && designation !== "uat" && designation !== "production") throw new Error();
    const nodeEnvironment = setting("NODE_ENV");
    if (nodeEnvironment !== undefined && nodeEnvironment !== (designation === "local" ? "development" : "production")) throw new Error();
    // Reject ambient driver overrides rather than silently accepting a second configuration source.
    if (Object.keys(environment).some((key) => key.startsWith("PG") && setting(key) !== undefined)) throw new Error();
    if (setting("NODE_TLS_REJECT_UNAUTHORIZED") !== undefined && setting("NODE_TLS_REJECT_UNAUTHORIZED") !== "1") throw new Error();
    const raw = setting("TA_DATABASE_URL");
    if (!raw || raw.trim() !== raw || /[\s\u0000-\u001f\u007f]/.test(raw)) throw new Error();
    const endpoint = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(endpoint.protocol) || !endpoint.hostname || !endpoint.username || !endpoint.password
      || endpoint.search || endpoint.hash || raw.includes("?") || raw.includes("#")) throw new Error();
    // Restrict to DNS hosts: no socket paths, multi-host syntax, or IP literals.
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(endpoint.hostname)
      || endpoint.hostname.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))
      || /^[\d.]+$/.test(endpoint.hostname)) throw new Error();
    const decode = (value: string): string => {
      const result = decodeURIComponent(value);
      if (!result || /[\u0000-\u001f\u007f]/.test(result)) throw new Error();
      return result;
    };
    const user = decode(endpoint.username);
    const password = decode(endpoint.password);
    const database = decode(endpoint.pathname.slice(1));
    if (database.includes("/") || /^(postgres|supabase_admin|service_role)(\.|$)/i.test(user)) throw new Error();
    const port = endpoint.port ? Number(endpoint.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const integer = (name: string, fallback: number, min: number, max: number): number => {
      const value = setting(name);
      if (value === undefined) return fallback;
      if (!/^[1-9]\d*$/.test(value)) throw new Error();
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error();
      return number;
    };
    const configuration: DatabaseConfiguration = Object.freeze({
      environment: designation,
      maxConnections: integer("TA_DATABASE_POOL_MAX", 3, 1, 10),
      connectionTimeoutMillis: integer("TA_DATABASE_CONNECTION_TIMEOUT_MS", 5000, 100, 30000),
      idleTimeoutMillis: integer("TA_DATABASE_IDLE_TIMEOUT_MS", 10000, 1000, 60000),
    });
    const ca = setting("TA_DATABASE_CA_PEM");
    if (ca !== undefined) new X509Certificate(ca);
    const options: PoolConfig = {
      host: endpoint.hostname, port, user, password, database,
      max: configuration.maxConnections,
      connectionTimeoutMillis: configuration.connectionTimeoutMillis,
      idleTimeoutMillis: configuration.idleTimeoutMillis,
      ssl: { rejectUnauthorized: true, checkServerIdentity, ...(ca === undefined ? {} : { ca }) },
      application_name: `token-anatomy-${designation}`,
      options: "",
      statement_timeout: 30000,
      query_timeout: 30000,
      idle_in_transaction_session_timeout: 30000,
    };
    // A digest supports reuse without putting credentials into a registry key or public handle.
    const key = createHash("sha256").update(JSON.stringify([designation, options])).digest("hex");
    approved.set(configuration, { key, options });
    return configuration;
  } catch {
    throw new DatabaseError("invalid_configuration");
  }
}

export interface DatabaseClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}
export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export type DatabasePoolFactory = (options: PoolConfig) => DatabasePool;
export interface DatabaseAdapter {
  /** Internal single-query API; SQL must never come from browser input. */
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  shutdown(): Promise<void>;
}

/** Isolated registry seam for offline tests. Production uses getDatabaseAdapter below. */
export function createDatabaseRegistry(factory: DatabasePoolFactory) {
  const adapters = new Map<string, DatabaseAdapter>();
  return Object.freeze({
    get(configuration: DatabaseConfiguration): DatabaseAdapter {
      const entry = approved.get(configuration);
      if (!entry) throw new DatabaseError("invalid_configuration");
      const existing = adapters.get(entry.key);
      if (existing) return existing;
      let pool: DatabasePool;
      let unavailable = false;
      let closing: Promise<void> | undefined;
      try {
        pool = factory({ ...entry.options, ssl: { ...entry.options.ssl as object } });
        // An idle-client error must neither leak driver details nor become an unhandled event.
        pool.on("error", () => { unavailable = true; });
      } catch {
        throw new DatabaseError("connection_failed");
      }
      const adapter: DatabaseAdapter = Object.freeze({
        async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
          if (unavailable) throw new DatabaseError("pool_unavailable");
          let client: DatabaseClient;
          try { client = await pool.connect(); }
          catch { throw new DatabaseError("connection_failed"); }
          let failed = false;
          let signalFailure!: () => void;
          // Resolve a signal rather than retaining or rejecting with the driver error.
          const clientFailure = new Promise<void>((resolve) => { signalFailure = resolve; });
          const onClientError = () => { failed = true; signalFailure(); };
          client.on("error", onClientError);
          try {
            if (unavailable) { failed = true; throw new DatabaseError("pool_unavailable"); }
            try {
              const result = await Promise.race([
                client.query(text, values === undefined ? undefined : [...values]),
                clientFailure.then(() => { throw new DatabaseError("query_failed"); }),
              ]);
              if (failed) throw new DatabaseError("query_failed");
              return result;
            }
            catch { failed = true; throw new DatabaseError("query_failed"); }
          } finally {
            try { client.release(failed); }
            catch { throw new DatabaseError("release_failed"); }
            // pg-pool restores its error listener synchronously inside release, including destroy.
            finally { client.removeListener("error", onClientError); }
          }
        },
        shutdown(): Promise<void> {
          unavailable = true;
          closing ??= Promise.resolve().then(() => pool.end()).catch(() => { throw new DatabaseError("shutdown_failed"); });
          return closing;
        },
      });
      adapters.set(entry.key, adapter);
      return adapter;
    },
  });
}

// Pool construction is lazy and opens no socket. Importing this module creates no pools.
const processRegistry = createDatabaseRegistry((options) => {
  if (Object.keys(process.env).some((key) => key.startsWith("PG") && process.env[key] !== undefined)
    || (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1")) {
    throw new DatabaseError("invalid_configuration");
  }
  return new Pool(options);
});
export const getDatabaseAdapter = processRegistry.get;
