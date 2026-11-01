import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("./out/", import.meta.url).pathname;
const port = Number.parseInt(process.env.TRACE_PREVIEW_PORT ?? "4174", 10);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  const requested = pathname === "/" ? "preview.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const path = join(root, safe);
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  response.setHeader("Content-Type", mime[extname(path)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  createReadStream(path).on("error", () => response.writeHead(404).end("Not found")).pipe(response);
});
server.listen(port, "127.0.0.1", () => console.log(`Trace webview preview: http://127.0.0.1:${port}`));
