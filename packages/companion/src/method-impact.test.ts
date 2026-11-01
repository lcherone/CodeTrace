import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { MethodImpactService } from "./method-impact.js";
import { GraphService } from "./graph.js";
import { parseComposer } from "./composer.js";
import { parsePhp } from "./php.js";
import { resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

const exec = promisify(execFile);
test("cross-repository method impact keeps locked contracts separate from proposed revisions through an intermediate package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-method-impact-")); const store = new TraceStore(":memory:");
  try {
    const heads: Record<string, string> = {};
    const create = async (id: string, source: string, dependencies: Array<{ name: string; version: string; source: { reference: string } }> = []) => {
      const directory = path.join(root, id); await mkdir(path.join(directory, "src"), { recursive: true });
      await exec("git", ["init", "-b", "main", directory]);
      await exec("git", ["-C", directory, "config", "user.name", "Trace"]); await exec("git", ["-C", directory, "config", "user.email", "trace@example.test"]);
      store.upsertRepository({ id, root: directory, remoteUrl: `https://github.com/example/${id}.git` });
      return publish(id, source, dependencies);
    };
    const publish = async (id: string, source: string, dependencies: Array<{ name: string; version: string; source: { reference: string } }> = []) => {
      const directory = path.join(root, id);
      const composer = JSON.stringify({ name: `company/${id}`, config: { platform: { php: "8.2.0" } }, autoload: { "psr-4": { [`${id}\\`]: "src/" } }, require: Object.fromEntries(dependencies.map((item) => [item.name, item.version])) }, null, 2);
      const lock = JSON.stringify({ packages: dependencies }, null, 2);
      await writeFile(path.join(directory, "src/A.php"), source); await writeFile(path.join(directory, "composer.json"), composer); await writeFile(path.join(directory, "composer.lock"), lock);
      await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "-c", "commit.gpgsign=false", "commit", "-m", "Contract revision"]);
      const commit = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim(); heads[id] = commit;
      const generation = store.beginGeneration(id, commit, "main", false, 1);
      const symbols = symbolsFromFiles(id, generation, commit, [parsePhp(source, "src/A.php")]);
      const parsed = parseComposer(id, generation, "", composer, lock);
      store.publishGeneration(generation, id, commit, symbols, resolveRelationships(id, generation, commit, symbols), [parsed.pkg], parsed.dependencies);
      return commit;
    };
    const old = await create("core", "<?php namespace core; class A { public function method(): string { return 'old'; } } interface Contract { public function method(): string; } trait Shared { public function method(): string { return 'old'; } }");
    const target = await publish("core", "<?php namespace core; class A { public function method(): bool { return true; } } interface Contract { public function method(): bool; } trait Shared { public function method(): bool { return true; } }");
    const dep = (id: string, reference: string, version: string) => ({ name: `company/${id}`, version, source: { reference } });
    const framework = await create("framework", "<?php namespace framework; class A extends \\core\\A {}", [dep("core", old, "1.0.0")]);
    for (const [id, declaration, reference] of [
      ["reporting", "public function method(): string { return 'report'; }", old],
      ["warehouse", "", old],
      ["storefront", "public function method(): bool { return parent::method(); }", target],
      ["broken", "public function method(): string { return 'broken'; }", target],
    ] as const) await create(id, `<?php namespace ${id}; class A extends \\framework\\A { ${declaration} }`, [dep("framework", framework, "1.0.0"), dep("core", reference, reference === old ? "1.0.0" : "2.0.0")]);
    await create("installer", "<?php namespace installer; class A {}", [dep("core", old, "1.0.0")]);
    await create("interfaceapp", "<?php namespace interfaceapp; class A implements \\core\\Contract { public function method(): string { return 'old'; } }", [dep("core", old, "1.0.0")]);
    await create("traitapp", "<?php namespace traitapp; class A { use \\core\\Shared; }", [dep("core", old, "1.0.0")]);
    await create("partial", "<?php namespace partial; class A extends \\core\\A implements \\MissingContract { public function method(): string { return 'old'; } }", [dep("core", old, "1.0.0")]);
    // Consumers retain the older intermediate package even after its indexed HEAD changes ancestry.
    await publish("framework", "<?php namespace framework; class A extends \\Unrelated\\Base {}", [dep("core", target, "2.0.0")]);
    const graphs = new GraphService(store);
    const graph = graphs.overview({ repositoryPath: path.join(root, "reporting"), relativePath: "src/A.php", revision: { repositoryId: "reporting", commit: heads.reporting!, dirty: false }, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 }, selectedText: "reporting\\A" });
    const engine = new MethodImpactService(store, graphs); const stages: number[] = [];
    const result = await engine.analyze({ queryId: graph.queryId, itemId: graph.focusNodeId, methodName: "method", targetRef: target, includeHistory: true }, undefined, (partial) => stages.push(partial.rows.length));
    assert.equal(result.origin.commit, old); assert.equal(result.target.commit, target); assert.equal(result.complete, true); assert.ok(stages.length > 3);
    const report = result.rows.find((row) => row.repositoryId === "reporting")!;
    assert.equal(report.current.state, "no-signature-incompatibility"); assert.equal(report.target.state, "incompatible"); assert.equal(report.group, "changes-required"); assert.equal(report.callsParent, false);
    assert.deepEqual(report.inheritancePath.map((item) => item.name), ["reporting\\A", "framework\\A", "core\\A"]);
    assert.equal(report.installedCommit, old); assert.match(report.currentSignature!, /string/); assert.match(report.targetSignature!, /bool/);
    assert.equal(result.rows.find((row) => row.repositoryId === "warehouse")?.relationship, "inherits");
    assert.equal(result.rows.find((row) => row.repositoryId === "warehouse")?.target.state, "review");
    assert.ok(result.rows.find((row) => row.repositoryId === "warehouse")?.relationshipHistory?.some((event) => event.category === "introduction"));
    assert.equal(result.rows.find((row) => row.repositoryId === "storefront")?.target.state, "no-signature-incompatibility");
    assert.equal(result.rows.find((row) => row.repositoryId === "broken")?.current.state, "incompatible");
    assert.equal(result.rows.find((row) => row.repositoryId === "installer")?.current.state, "unknown");
    assert.equal(result.rows.find((row) => row.repositoryId === "partial")?.current.state, "unknown");
    assert.equal(result.rows.find((row) => row.repositoryId === "partial")?.target.state, "incompatible");
    assert.ok(result.graph.edges.some((edge) => edge.type === "calls-parent")); assert.ok(result.graph.edges.some((edge) => edge.type === "inherits"));
    assert.ok(result.graph.edges.some((edge) => edge.type === "signature-incompatible"));
    const requires = result.graph.edges.find((edge) => edge.id === "installed:reporting")!;
    assert.equal(requires.evidence[0]?.repositoryId, "reporting"); assert.ok(requires.evidence.some((item) => item.path === "composer.lock"));
    assert.ok(result.origin.history?.introduction); assert.ok(result.target.history?.signature); assert.ok(report.history?.introduction);
    const preview = await engine.analyze({ queryId: graph.queryId, itemId: graph.focusNodeId, methodName: "method", localSignature: "public function method(): bool" });
    assert.equal(preview.target.kind, "local-preview"); assert.equal(preview.target.links[0]?.githubUrl, undefined); assert.equal(preview.rows.find((row) => row.repositoryId === "reporting")?.target.state, "incompatible");
    const dirty = graphs.overview({ repositoryPath: path.join(root, "reporting"), relativePath: "src/A.php", revision: { repositoryId: "reporting", commit: heads.reporting!, dirty: true }, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 }, selectedText: "reporting\\A" });
    const baseline = await engine.analyze({ queryId: dirty.queryId, itemId: dirty.focusNodeId, methodName: "method" });
    assert.ok(baseline.limitations.some((item) => item.includes("committed baseline")));
    assert.ok(baseline.rows.find((row) => row.repositoryId === "reporting")?.links.filter((item) => item.path === "src/A.php").every((item) => !item.githubUrl && item.vscodeUrl));
    assert.ok(baseline.graph.nodes.some((node) => node.occurrence?.revision.repositoryId === "reporting" && node.occurrence.revision.dirty && node.metadata.indexedBaseline));
    const unavailable = await engine.analyze({ queryId: graph.queryId, itemId: graph.focusNodeId, methodName: "method", targetRef: "does-not-exist" });
    assert.equal(unavailable.target.kind, "unavailable"); assert.equal(unavailable.rows.find((row) => row.repositoryId === "reporting")?.target.state, "unknown");
    for (const id of ["interfaceapp", "traitapp"]) {
      const selected = graphs.overview({ repositoryPath: path.join(root, id), relativePath: "src/A.php", revision: { repositoryId: id, commit: heads[id]!, dirty: false }, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 }, selectedText: `${id}\\A` });
      const impact = await engine.analyze({ queryId: selected.queryId, itemId: selected.focusNodeId, methodName: "method", targetRef: target });
      const row = impact.rows.find((item) => item.repositoryId === id)!;
      assert.equal(row.current.state, "no-signature-incompatibility");
      assert.equal(row.target.state, id === "interfaceapp" ? "incompatible" : "review");
      assert.match(row.currentSignature!, /string/);
      assert.ok(impact.graph.edges.some((edge) => edge.type === (id === "interfaceapp" ? "implements-method" : "uses-trait")));
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
