import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};
const FILES = [
  ["/", "uat.html", "text/html; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/public-report.json", "public-report.json", "application/json; charset=utf-8"],
] as const;
const digest = (value: string) => createHash("sha256").update(value).digest();

export function parseUatPort(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error("UAT configuration invalid.");
  return Number(value);
}

/** Standalone synthetic host. No analysis, provider, or database dependencies. */
export async function createPublicReportUatServer(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<Server> {
  const username = environment.TA_UAT_USERNAME;
  const password = environment.TA_UAT_PASSWORD;
  if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)
    || !password || !/^[\x21-\x7e]{32,128}$/.test(password)) throw new Error("UAT configuration invalid.");
  const expected = digest(`${username}:${password}`);
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  try {
    for (const [route, file, contentType] of FILES) {
      const body = await readFile(resolve(__dirname, "../../src/dev/public-report-demo", file));
      if (!body.length) throw new Error();
      assets.set(route, { body, contentType });
    }
    const report = JSON.parse(assets.get("/public-report.json")!.body.toString("utf8"));
    if (report.schemaVersion !== "token-public-report-v1" || report.token?.chain !== "solana"
      || !Array.isArray(report.sections) || !Array.isArray(report.technicalDetails)) throw new Error();
  } catch { throw new Error("UAT assets unavailable."); }

  // One bounded counter per instance; forwarded headers cannot evade it.
  let windowStart = performance.now();
  let failures = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
    const reply = (status: number, body: string, extra: Record<string, string> = {}) => {
      response.writeHead(status, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", Connection: "close", ...extra });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    try {
      const now = performance.now();
      if (now - windowStart >= 60000) { windowStart = now; failures = 0; }
      if (failures >= 10) { reply(429, "Access temporarily limited.", { "Retry-After": String(Math.max(1, Math.ceil((60000 - (now - windowStart)) / 1000))) }); return; }
      const header = request.headers.authorization;
      let credential = "";
      let validEncoding = false;
      const count = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "authorization").length;
      if (count === 1 && typeof header === "string" && header.length <= 1024 && /^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) {
        const encoded = header.slice(6);
        const bytes = Buffer.from(encoded, "base64");
        validEncoding = bytes.toString("base64") === encoded;
        credential = bytes.toString("utf8");
      }
      const matches = timingSafeEqual(digest(credential), expected);
      if (!validEncoding || !matches) {
        failures++;
        reply(401, "Authentication required.", { "WWW-Authenticate": 'Basic realm="Token Anatomy UAT", charset="UTF-8"' });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { reply(405, "Method not allowed.", { Allow: "GET, HEAD" }); return; }
      const target = request.url ?? "";
      if (target.length > 2048 || !target.startsWith("/") || /[%\\#\u0000-\u0020]/.test(target)) { reply(400, "Invalid request."); return; }
      const asset = assets.get(target.split("?")[0]);
      if (!asset) { reply(404, "Not found."); return; }
      response.writeHead(200, { ...HEADERS, "Content-Type": asset.contentType, "Content-Length": asset.body.length });
      response.end(request.method === "HEAD" ? undefined : asset.body);
    } catch { reply(500, "Request unavailable."); }
  });
  server.keepAliveTimeout = 5000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}

if (require.main === module) {
  void (async () => {
    const port = parseUatPort(process.env.PORT);
    const server = await createPublicReportUatServer();
    server.on("error", () => { process.stderr.write("UAT server unavailable.\n"); process.exitCode = 1; });
    server.listen(port, "0.0.0.0", () => process.stdout.write("Protected synthetic UAT ready.\n"));
  })().catch(() => { process.stderr.write("UAT startup failed.\n"); process.exitCode = 1; });
}
