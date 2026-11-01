import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
  // Bundle the ESM source so esbuild can discard the browser graph contracts
  // that the extension no longer uses.
  alias: { "@trace/contracts": resolve("../contracts/src/index.ts") },
};
const builds = [{
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
}];

await rm("out", { recursive: true, force: true });
await mkdir("out", { recursive: true });
if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Trace extension is watching for changes.");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
