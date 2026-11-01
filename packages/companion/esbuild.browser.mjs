import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const codiconCssPath = require.resolve("@vscode/codicons/dist/codicon.css");
const codiconFontPath = join(dirname(codiconCssPath), "codicon.ttf");

await mkdir("dist/browser", { recursive: true });
await Promise.all([
  esbuild.build({ entryPoints: ["src/browser/bridge.ts"], outfile: "dist/browser/bridge.js", platform: "browser", format: "iife", bundle: true, minify: true, sourcemap: false, logLevel: "info" }),
  esbuild.build({ entryPoints: ["src/browser/main.ts"], outfile: "dist/browser/app.js", platform: "browser", format: "iife", bundle: true, minify: true, sourcemap: false, logLevel: "info" }),
]);
const [codicons, styles, shell, bridgeBundle, appBundle] = await Promise.all([
  readFile(codiconCssPath, "utf8"),
  readFile("src/browser/styles.css", "utf8"),
  readFile("src/browser/shell.html", "utf8"),
  readFile("dist/browser/bridge.js"),
  readFile("dist/browser/app.js"),
]);
const appCss = `${codicons}\n${styles}`;
const assetVersion = createHash("sha256").update(bridgeBundle).update(appBundle).update(appCss).digest("hex").slice(0, 16);
await writeFile("dist/browser/app.css", appCss);
await writeFile("dist/browser/index.html", shell
  .replaceAll("{{CSP}}", "default-src 'none'; style-src 'self' 'nonce-{{NONCE}}'; script-src 'self' 'nonce-{{NONCE}}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'")
  .replaceAll("{{STYLE_URI}}", `/browser/app.css?v=${assetVersion}`)
  .replaceAll("{{SCRIPT_URI}}", `/browser/app.js?v=${assetVersion}`)
  .replaceAll("{{PRELUDE}}", `<script nonce="{{NONCE}}" src="/browser/bridge.js?v=${assetVersion}"></script>`));
await cp(codiconFontPath, "dist/browser/codicon.ttf");
