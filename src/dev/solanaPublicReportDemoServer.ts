import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateSolanaLivePublicReport } from "../application/solanaLivePublicReportService";
import type { SolanaLivePublicReportDependencies } from "../application/solanaLivePublicReportService";
import { createSolanaTokenEvidenceAdmissionController } from "../application/solanaTokenEvidenceAdmissionController";
import { createSolanaProviderRequestBudgetController } from "../application/solanaProviderRequestBudgetController";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const ASSETS = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/public-report.json": { file: "public-report.json", contentType: "application/json; charset=utf-8" },
} as const;
const MAX_BODY_BYTES = 1024;
const SAFE_LIVE_ERRORS: Record<string, { code: string; message: string }> = {
  invalid_request: { code: "invalid_request", message: "Provide a valid Solana chain and token address." },
  admission_rejected: { code: "admission_rejected", message: "Another analysis is active or analysis is unavailable." },
  budget_exhausted: { code: "budget_exhausted", message: "The local provider-request allowance is exhausted." },
  deadline_exceeded: { code: "deadline_exceeded", message: "The analysis exceeded its time limit. No completed report was returned." },
  cancelled: { code: "cancelled", message: "The analysis was cancelled. No completed report was returned." },
  evidence_unavailable: { code: "evidence_unavailable", message: "The requested address could not be verified as a Solana token mint." },
  report_unavailable: { code: "report_unavailable", message: "A report could not be prepared from the available evidence." },
};
const processAdmission = createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: 1, initiallyEnabled: true });
const processBudget = createSolanaProviderRequestBudgetController({ capacity: 220, initiallyEnabled: true });
const processDependencies: SolanaLivePublicReportDependencies = {
  admissionPolicy: processAdmission,
  providerRequestBudgetController: processBudget,
};

export interface SolanaPublicReportDemoServerOptions {
  /** Internal offline test seam; never configurable through HTTP input. */
  readonly generateLiveReport?: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly liveDependencies?: SolanaLivePublicReportDependencies;
}

function assetDirectory(): string {
  const sourceDirectory = resolve(process.cwd(), "src/dev/public-report-demo");
  if (existsSync(sourceDirectory)) return sourceDirectory;
  return resolve(__dirname, "../../src/dev/public-report-demo");
}

/** Loopback-only host for the synthetic demonstration and bounded local report workflow. */
export function createSolanaPublicReportDemoServer(options: SolanaPublicReportDemoServerOptions = {}): Server {
  return createServer(async (request, response) => {
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
    if (request.method === "POST" && path === "/api/report") {
      const host = request.headers.host ?? "";
      const origin = request.headers.origin;
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) || origin !== `http://${host}`) {
        response.writeHead(403, { "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "origin_rejected", message: "This local request was rejected." } }));
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        response.writeHead(415, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: { code: "content_type_required", message: "Send a JSON request." } }));
        return;
      }
      const declaredLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        response.writeHead(413, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: { code: "request_too_large", message: "The request is too large." } }));
        request.resume();
        return;
      }
      const controller = new AbortController();
      const onAborted = () => controller.abort();
      const onResponseClose = () => { if (!response.writableEnded) controller.abort(); };
      request.once("aborted", onAborted);
      response.once("close", onResponseClose);
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            response.writeHead(413, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: { code: "request_too_large", message: "The request is too large." } }));
            return;
          }
          chunks.push(buffer);
        }
        let input: unknown;
        try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch {
          response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: { code: "invalid_request", message: "The request is invalid." } }));
          return;
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)
          || Object.getPrototypeOf(input) !== Object.prototype
          || Object.keys(input).length !== 2 || !Object.hasOwn(input, "chain") || !Object.hasOwn(input, "assetAddress")
          || (input as { chain?: unknown }).chain !== "solana"
          || typeof (input as { assetAddress?: unknown }).assetAddress !== "string"
          || !isSolanaPublicKeySyntax((input as { assetAddress: string }).assetAddress)) {
          response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: { code: "invalid_request", message: "The request is invalid." } }));
          return;
        }
        const result = options.generateLiveReport
          ? await options.generateLiveReport(input, controller.signal)
          : await generateSolanaLivePublicReport(input, options.liveDependencies ?? processDependencies, controller.signal);
        if (controller.signal.aborted || response.destroyed) return;
        if (typeof result === "object" && result !== null && "valid" in result && result.valid === true && "report" in result) {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(JSON.stringify(result.report));
        } else {
          const error = typeof result === "object" && result !== null && "error" in result ? result.error : null;
          const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "report_unavailable";
          const safeError = SAFE_LIVE_ERRORS[code] ?? SAFE_LIVE_ERRORS.report_unavailable;
          response.writeHead(code === "invalid_request" ? 400 : code === "admission_rejected" || code === "budget_exhausted" ? 429 : 502,
            { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(JSON.stringify({ error: safeError }));
        }
      } catch {
        if (!response.destroyed) response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "report_unavailable", message: "A report could not be prepared." } }));
      } finally {
        request.removeListener("aborted", onAborted);
        response.removeListener("close", onResponseClose);
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD, POST", "Cache-Control": "no-store" }).end();
      return;
    }

    const asset = ASSETS[path as keyof typeof ASSETS];
    if (!asset) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }

    try {
      const body = await readFile(resolve(assetDirectory(), asset.file));
      response.writeHead(200, {
        "Content-Type": asset.contentType,
        "Content-Length": body.byteLength,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(500, { "Cache-Control": "no-store" }).end("Local demo asset unavailable.");
    }
  });
}

if (require.main === module) {
  const portText = process.env.TQE_DEMO_PORT ?? "4173";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("TQE_DEMO_PORT must be a valid TCP port.\n");
    process.exitCode = 1;
  } else {
    const server = createSolanaPublicReportDemoServer();
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`Token Qualification Engine demo: http://127.0.0.1:${port}\n`);
    });
  }
}
