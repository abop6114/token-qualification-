import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ASSETS = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/public-report.json": { file: "public-report.json", contentType: "application/json; charset=utf-8" },
} as const;

function assetDirectory(): string {
  const sourceDirectory = resolve(process.cwd(), "src/dev/public-report-demo");
  if (existsSync(sourceDirectory)) return sourceDirectory;
  return resolve(__dirname, "../../src/dev/public-report-demo");
}

/** A loopback-only static host for the sanitized synthetic public report prototype. */
export function createSolanaPublicReportDemoServer(): Server {
  return createServer(async (request, response) => {
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }).end();
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
