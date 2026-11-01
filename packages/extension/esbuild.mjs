import esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const codiconCssPath = require.resolve("@vscode/codicons/dist/codicon.css");
const codiconFontPath = join(dirname(codiconCssPath), "codicon.ttf");

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
};
const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/webview/main.ts"],
    outfile: "out/webview.js",
    platform: "browser",
    format: "iife",
  },
  {
    ...common,
    entryPoints: ["src/webview/preview.ts"],
    outfile: "out/preview-bootstrap.js",
    platform: "browser",
    format: "iife",
  },
];

await mkdir("out", { recursive: true });
const [codiconCss, webviewCss] = await Promise.all([
  readFile(codiconCssPath, "utf8"),
  readFile("src/webview/styles.css", "utf8"),
]);
await writeFile("out/webview.css", `${codiconCss}\n${webviewCss}`);
await cp(codiconFontPath, "out/codicon.ttf");
await cp("src/webview/shell.html", "out/shell.html");
const shell = await readFile("src/webview/shell.html", "utf8");
await writeFile("out/preview.html", shell
  .replaceAll("{{CSP}}", "default-src 'self'; style-src 'self' 'nonce-trace-preview'; script-src 'self' 'nonce-trace-preview';")
  .replaceAll("{{STYLE_URI}}", "./webview.css")
  .replaceAll("{{SCRIPT_URI}}", "./webview.js")
  .replaceAll("{{PRELUDE}}", '<script src="./preview-bootstrap.js"></script>')
  .replaceAll("{{NONCE}}", "trace-preview"));
if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Trace extension is watching for changes.");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
