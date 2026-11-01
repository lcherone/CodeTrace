import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixtures } from "./generate.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDestination = path.join(packageRoot, "generated");
const outputIndex = process.argv.indexOf("--output");
const destination = outputIndex >= 0 ? process.argv[outputIndex + 1] : defaultDestination;

if (!destination) {
  throw new Error("--output requires a destination path");
}

const manifest = await generateFixtures(destination);
console.log(`Generated ${manifest.repositories.length} Trace fixture repositories in ${path.resolve(destination)}`);
for (const repository of manifest.repositories) {
  console.log(`${repository.id}: ${repository.head}`);
}
