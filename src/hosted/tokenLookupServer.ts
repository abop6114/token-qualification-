import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { generateSolanaLivePublicReport } from "../application/solanaLivePublicReportService";
import { createSolanaTokenEvidenceAdmissionController } from "../application/solanaTokenEvidenceAdmissionController";
import { createSolanaProviderRequestBudgetController } from "../application/solanaProviderRequestBudgetController";
import { isSolanaPublicKeySyntax } from "../validation/solanaAddress";

const HEADERS = {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};
const FILES = [["/", "hosted.html", "text/html; charset=utf-8"], ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"], ["/public-report.json", "public-report.json", "application/json; charset=utf-8"]] as const;
const digest = (value: string) => createHash("sha256").update(value).digest();
const invalid = () => new Error("Hosted lookup configuration invalid.");

export function parseHostedLookupPort(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw invalid();
  return Number(value);
}

/** Separate private-pilot host. Construction never acquires evidence. */
export async function createHostedTokenLookupServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  // Trusted offline transport seam; not configurable by requests or environment.
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Server> {
  const username = environment.TA_LOOKUP_USERNAME, password = environment.TA_LOOKUP_PASSWORD;
  if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username) || !password || !/^[\x21-\x7e]{32,128}$/.test(password)) throw invalid();
  let origin: URL;
  try { origin = new URL(environment.TA_LOOKUP_ORIGIN ?? ""); } catch { throw invalid(); }
  if (origin.protocol !== "https:" || origin.origin !== environment.TA_LOOKUP_ORIGIN || origin.username || origin.password) throw invalid();
  const flag = environment.TA_LOOKUP_ANALYSIS_ENABLED;
  if (flag !== undefined && flag !== "false" && flag !== "true") throw invalid();
  const enabled = flag === "true";
  const capacityText = environment.TA_LOOKUP_REQUEST_BUDGET;
  if (capacityText !== undefined && (!/^[1-9]\d*$/.test(capacityText) || !Number.isSafeInteger(Number(capacityText)))) throw invalid();
  if (enabled && capacityText === undefined) throw invalid();
  const admissionPolicy = createSolanaTokenEvidenceAdmissionController({ maxConcurrentExecutions: 1, initiallyEnabled: enabled });
  const providerRequestBudgetController = createSolanaProviderRequestBudgetController({ capacity: Number(capacityText ?? "1"), initiallyEnabled: enabled });
  const expected = digest(`${username}:${password}`);
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  try {
    for (const [route, file, contentType] of FILES) {
      let body = await readFile(resolve(__dirname, "../../src/dev/public-report-demo", file));
      if (!body.length) throw new Error();
      if (route === "/") body = Buffer.from(body.toString("utf8").replace("<!-- availability -->", enabled
        ? "Protected pilot · Analysis enabled" : "Protected pilot · Analysis disabled; synthetic demonstration available"));
      assets.set(route, { body, contentType });
    }
  } catch { throw new Error("Hosted lookup assets unavailable."); }
  let failures = 0, windowStart = performance.now();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    const single = (name: string) => request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length === 1;
    const reply = (status: number, body: string, extra: Record<string, string> = {}) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", Connection: "close", ...extra });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const error = (status: number, code: string) => reply(status, JSON.stringify({ error: { code, message: "The lookup request could not be completed." } }), { "Content-Type": "application/json; charset=utf-8" });
    try {
      const now = performance.now();
      if (now - windowStart >= 60000) { failures = 0; windowStart = now; }
      if (failures >= 10) { reply(429, "Access temporarily limited.", { "Retry-After": "60" }); return; }
      const header = request.headers.authorization;
      let credential = "", canonical = false;
      if (single("authorization") && typeof header === "string" && header.length <= 1024 && /^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) {
        const encoded = header.slice(6), bytes = Buffer.from(encoded, "base64");
        canonical = bytes.toString("base64") === encoded; credential = bytes.toString("utf8");
      }
      const matches = timingSafeEqual(digest(credential), expected);
      if (!canonical || !matches) { failures++; reply(401, "Authentication required.", { "WWW-Authenticate": 'Basic realm="Token Anatomy pilot", charset="UTF-8"' }); return; }
      // The TLS proxy must preserve Host. Forwarded headers are never trusted.
      if (!single("host") || request.headers.host !== origin.host) { error(403, "origin_rejected"); return; }
      const target = request.url ?? "";
      if (target.length > 2048 || !target.startsWith("/") || /[%\\#\u0000-\u0020]/.test(target)) { error(400, "invalid_request"); return; }
      if (target === "/api/report" && request.method === "POST") {
        if (!single("origin") || request.headers.origin !== origin.origin) { error(403, "origin_rejected"); return; }
        if (!enabled) { error(503, "admission_rejected"); return; }
        if (!single("content-type") || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) { error(415, "invalid_request"); return; }
        if (Number(request.headers["content-length"] ?? 0) > 1024) { error(413, "invalid_request"); return; }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const close = () => { if (!response.writableEnded) abort(); };
        request.once("aborted", abort); response.once("close", close);
        // Explicit body deadline, independent of Node's periodic timeout sweep.
        const bodyTimer = setTimeout(() => { abort(); error(408, "deadline_exceeded"); request.destroy(); }, 10000);
        try {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk); bytes += buffer.length;
            if (bytes > 1024) { error(413, "invalid_request"); return; }
            chunks.push(buffer);
          }
          clearTimeout(bodyTimer);
          if (controller.signal.aborted) return;
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { error(400, "invalid_request"); return; }
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2
            || input.chain !== "solana" || typeof input.assetAddress !== "string" || !isSolanaPublicKeySyntax(input.assetAddress)) { error(400, "invalid_request"); return; }
          const result = await generateSolanaLivePublicReport(input, { admissionPolicy, providerRequestBudgetController, fetchImpl: options.fetchImpl }, controller.signal);
          if (controller.signal.aborted) return;
          if (result.valid) reply(200, JSON.stringify(result.report), { "Content-Type": "application/json; charset=utf-8" });
          else error(result.error.code === "invalid_request" ? 400 : ["admission_rejected", "budget_exhausted"].includes(result.error.code) ? 429 : 502, result.error.code);
        } finally { clearTimeout(bodyTimer); request.removeListener("aborted", abort); response.removeListener("close", close); }
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { reply(405, "Method not allowed.", { Allow: "GET, HEAD" }); return; }
      const asset = assets.get(target);
      if (!asset) { reply(404, "Not found."); return; }
      reply(200, asset.body.toString("utf8"), { "Content-Type": asset.contentType });
    } catch { error(500, "report_unavailable"); }
  });
  server.keepAliveTimeout = 5000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

if (require.main === module) {
  void (async () => {
    const port = parseHostedLookupPort(process.env.PORT);
    const server = await createHostedTokenLookupServer();
    server.on("error", () => { process.stderr.write("Hosted lookup server unavailable.\n"); process.exitCode = 1; });
    server.listen(port, "0.0.0.0", () => process.stdout.write("Protected lookup ready.\n"));
  })().catch(() => { process.stderr.write("Hosted lookup startup failed.\n"); process.exitCode = 1; });
}
