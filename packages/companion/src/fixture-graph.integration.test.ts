import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { TemporalGraphComparisonRequestSchema, type GraphResponse, type Selection } from "@trace/contracts";
import { GraphService } from "./graph.js";
import { HistoryService } from "./history.js";
import { IndexCoordinator } from "./indexer.js";
import type { IndexedSymbol } from "./model.js";
import { TraceStore } from "./store.js";
import { TemporalGraphService, temporalEdgeIdentity } from "./temporal.js";

const exec = promisify(execFile);

interface FixtureRepository {
  id: string;
  path: string;
  packageName: string;
  head: string;
  commits: Record<string, string>;
  tags: Record<string, string>;
}

interface FixtureManifest {
  repositories: FixtureRepository[];
  expectations: {
    packageName: string;
    olderConsumerReference: string;
    newerConsumerReference: string;
    revertedCommit: string;
    examples: {
      nativeTypeMethod: string;
      phpDocTypeMethod: string;
      interfaceContract: string;
      trait: string;
      lateStaticMethod: string;
      inheritedWithoutOverride: string;
      overrideWithoutParentCall: string;
      overrideCallingParent: string;
      directCaller: string;
      impactCaller: string;
      dynamicCaller: string;
      unresolvedCaller: string;
    };
    historyCategories: string[];
    receiverInference: {
      repositoryId: string;
      commit: string;
      path: string;
      targetMethod: string;
      cases: Array<{
        id: string;
        caller: string;
        expression: string;
        methodName?: string;
        status: "resolved" | "ambiguous" | "unresolved" | "dynamic";
        candidateTypes: string[];
        resolutionMethod: string;
        confidence: "confirmed" | "possible" | "unresolved";
        expectedCallTargets: string[];
        limitations: string[];
      }>;
    };
    historicalComparison: {
      protocolVersion: "1.0";
      mode: "impact";
      before: { revisions: Record<string, string>; selection: Selection; packageReferences: Record<string, Record<string, string>> };
      after: { revisions: Record<string, string>; selection: Selection; packageReferences: Record<string, Record<string, string>> };
      expectedRelationships: {
        added: Array<{ identity: string }>;
        removed: Array<{ identity: string }>;
        changed: Array<{ identity: string; changedFields: string[] }>;
      };
    };
    historyEvidence: {
      lineage: {
        commit: string;
        events: Array<{ category: "move" | "rename"; fromPath: string; toPath: string; fromSymbol: string; toSymbol: string; confidence: "confirmed" | "possible"; evidence: Array<{ resolutionMethod: string; confidence: "confirmed" | "possible" }> }>;
      };
    };
  };
}

const edgeTypes = (graph: GraphResponse): Set<string> => new Set(graph.edges.map((edge) => edge.type));

test("generated PHP fixtures expose supported graph modes, metadata, and history", async (context) => {
  const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "trace-fixture-graph-"));
  const fixtureRoot = path.join(temporary, "generated");
  const store = new TraceStore(":memory:");
  const scanner = new IndexCoordinator(store, {
    repositoryConcurrency: 2,
    analysisConcurrency: 4,
    watchFileSystem: false,
    discoverComposerPackages: false,
  });

  try {
    await exec("npm", ["run", "build", "-w", "@trace/fixtures"], { cwd: workspaceRoot });
    await exec(process.execPath, [path.join(workspaceRoot, "packages/fixtures/dist/cli.js"), "--output", fixtureRoot], { cwd: workspaceRoot });
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "fixture-manifest.json"), "utf8")) as FixtureManifest;

    for (const repository of manifest.repositories) store.upsertRepository({ id: repository.id, root: repository.path });
    for (const repository of manifest.repositories) {
      const state = await scanner.index({ id: repository.id, root: repository.path });
      assert.equal(state.state, "ready", `${repository.id} should index successfully`);
      assert.equal(state.indexedCommit, repository.head);
    }

    const graph = new GraphService(store);
    const repository = (id: string): FixtureRepository => {
      const found = manifest.repositories.find((item) => item.id === id);
      assert.ok(found, `fixture repository ${id} exists`);
      return found;
    };
    const symbol = (fqn: string, repositoryId?: string): IndexedSymbol => {
      const found = store.activeSymbols().find((item) => item.fqn === fqn && (!repositoryId || item.repositoryId === repositoryId));
      assert.ok(found, `indexed symbol ${fqn}${repositoryId ? ` in ${repositoryId}` : ""} exists`);
      return found;
    };
    const selection = (item: IndexedSymbol): Selection => ({
      repositoryPath: repository(item.repositoryId).path,
      relativePath: item.path,
      revision: { repositoryId: item.repositoryId, commit: item.commit, dirty: false },
      range: item.range,
      selectedText: item.memberName ?? item.fqn,
    });

    const storeTotal = symbol("Client\\Store\\Order::calculateTotal", "client-store");
    const sharedTotal = symbol("Company\\Commerce\\BaseOrder::calculateTotal", "company-commerce");
    const sharedClass = symbol("Company\\Commerce\\BaseOrder", "company-commerce");

    await context.test("origin resolves the exact package contract and parent call", () => {
      const result = graph.trace(selection(storeTotal), "origin");
      assert.ok(edgeTypes(result).has("overrides"));
      assert.ok(edgeTypes(result).has("calls-parent"));
      assert.ok(result.nodes.some((node) => node.label === "Company\\Commerce\\BaseOrder::calculateTotal"));
      assert.ok(result.edges.every((edge) => edge.evidence.length > 0));
      const focus = result.nodes.find((node) => node.id === result.focusNodeId);
      assert.ok(Array.isArray(focus?.metadata.contractSources));
    });

    await context.test("inheritance exposes class, interface, trait, declaration, and override relationships", () => {
      const result = graph.trace(selection(sharedClass), "inheritance");
      const types = edgeTypes(result);
      for (const expected of ["declares", "extends", "implements", "uses-trait", "overrides"]) {
        assert.ok(types.has(expected), `inheritance should expose ${expected}`);
      }
      assert.ok(result.nodes.some((node) => node.label === "Company\\Commerce\\StandardOrder"));
      assert.ok(result.nodes.some((node) => node.label === "Company\\Commerce\\Contracts\\PricedOrder"));
      assert.ok(result.nodes.some((node) => node.label === "Company\\Commerce\\Support\\PricingMath"));
    });

    await context.test("callers includes confirmed typed calls and excludes ambiguous dynamic dispatch", () => {
      const result = graph.trace(selection(storeTotal), "callers");
      assert.ok(result.edges.some((edge) => edge.type === "calls" && edge.confidence === "confirmed"));
      assert.ok(result.edges.some((edge) => edge.type === "calls-parent" && edge.confidence === "confirmed"));
      assert.ok(result.nodes.some((node) => node.label === "Client\\Store\\CheckoutService::total"));
      const caller = result.nodes.find((node) => node.label === "Client\\Store\\CheckoutService::total");
      const receiverAnalysis = caller?.metadata.receiverAnalysis as Array<{ expression: string; candidateTypes: string[]; resolutionMethod: string; confidence: string }> | undefined;
      assert.ok(receiverAnalysis?.some((item) => item.expression === "$order" && item.candidateTypes.includes("Client\\Store\\Order") && item.resolutionMethod === "native-parameter" && item.confidence === "confirmed"));
      assert.equal(result.edges.some((edge) => edge.evidence.some((evidence) => evidence.detail.includes("dynamic"))), false);
    });

    await context.test("generated receiver inference cases expose evidence and only statically justified call targets", () => {
      const receiverFixture = manifest.expectations.receiverInference;
      for (const expected of receiverFixture.cases) {
        const caller = symbol(expected.caller, receiverFixture.repositoryId);
        const result = graph.trace(selection(caller), "callers");
        const focus = result.nodes.find((node) => node.id === result.focusNodeId);
        const analyses = focus?.metadata.receiverAnalysis as Array<{
          status: string;
          expression: string;
          methodName?: string;
          candidateTypes: string[];
          resolutionMethod: string;
          confidence: string;
          limitations: string[];
        }> | undefined;
        const analysis = analyses?.find((item) => item.expression === expected.expression && item.methodName === expected.methodName);
        assert.ok(analysis, `${expected.id} exposes receiver analysis`);
        assert.equal(analysis.status, expected.status, `${expected.id} status`);
        assert.deepEqual(analysis.candidateTypes, expected.candidateTypes, `${expected.id} candidates`);
        assert.equal(analysis.resolutionMethod, expected.resolutionMethod, `${expected.id} resolution method`);
        assert.equal(analysis.confidence, expected.confidence, `${expected.id} confidence`);
        for (const limitation of expected.limitations) assert.ok(analysis.limitations.includes(limitation), `${expected.id} limitation: ${limitation}`);

        const targetById = new Map(result.nodes.map((node) => [node.id, node.label]));
        const callTargets = new Set(result.edges.filter((edge) => edge.type === "calls" && edge.source === caller.id).map((edge) => targetById.get(edge.target)));
        for (const target of expected.expectedCallTargets) assert.ok(callTargets.has(target), `${expected.id} calls ${target}`);
        if (!expected.expectedCallTargets.length) assert.equal(callTargets.has(receiverFixture.targetMethod), false, `${expected.id} does not invent ${receiverFixture.targetMethod}`);
      }
    });

    await context.test("consumers distinguish confirmed use from dependency-only installation and exact revisions", () => {
      const result = graph.trace(selection(storeTotal), "consumers");
      assert.equal(result.nodes.find((node) => node.id === "project:client-store")?.metadata.symbolUsage, "confirmed");
      assert.equal(result.nodes.find((node) => node.id === "project:client-reporting")?.metadata.symbolUsage, "dependency-only");
      assert.ok(result.nodes.some((node) => node.kind === "package-revision" && node.metadata.resolvedSourceCommit === undefined && node.metadata.resolvedDistReference === manifest.expectations.newerConsumerReference && node.metadata.indexedRevision === manifest.expectations.newerConsumerReference && node.metadata.symbolAnalysis === "available"));
      assert.ok(result.nodes.some((node) => node.kind === "package-revision" && node.metadata.resolvedSourceCommit === manifest.expectations.olderConsumerReference && node.metadata.symbolAnalysis === "unavailable-for-exact-revision"));
      assert.ok(result.edges.some((edge) => edge.source === "project:client-reporting" && edge.type === "requires" && edge.confidence === "dependency-only"));
    });

    await context.test("impact combines lineage, callers, and consumer package evidence", () => {
      const result = graph.trace(selection(storeTotal), "impact");
      const types = edgeTypes(result);
      for (const expected of ["overrides", "calls-parent", "calls", "requires"]) assert.ok(types.has(expected), `impact should expose ${expected}`);
      assert.ok(result.nodes.some((node) => node.kind === "project"));
      assert.ok(result.nodes.some((node) => node.kind === "package-revision"));
      for (const edge of result.edges.filter((item) => item.confidence === "unresolved")) {
        assert.ok(edge.evidence.some((evidence) => evidence.limitations.length > 0));
      }
    });

    await context.test("package origin reaches interface contract and trait evidence", () => {
      const result = graph.trace(selection(sharedTotal), "origin");
      assert.ok(edgeTypes(result).has("implements-method"));
      assert.ok(edgeTypes(result).has("uses-trait"));
      const focus = result.nodes.find((node) => node.id === result.focusNodeId);
      const contracts = focus?.metadata.contractSources as Array<Record<string, unknown>> | undefined;
      assert.ok(contracts?.some((item) => item.relationship === "implements-method"));
    });

    await context.test("generated native pricing method exposes interface, parameter, return, trait, and comment metadata", () => {
      const nativePrice = symbol(manifest.expectations.examples.nativeTypeMethod, "company-commerce");
      const result = graph.trace(selection(nativePrice), "origin");
      const types = edgeTypes(result);
      for (const expected of ["implements-method", "parameter-type", "return-type", "uses-trait"]) {
        assert.ok(types.has(expected), `native pricing origin should expose ${expected}`);
      }
      const focus = result.nodes.find((node) => node.id === result.focusNodeId);
      assert.equal(focus?.metadata.description, "Price an order using an explicit context.");
      assert.match(String(focus?.metadata.documentationDetails), /native types, interface provenance/);
      const parameters = focus?.metadata.parameters as Array<Record<string, unknown>>;
      assert.equal(parameters[0]?.declaredType, "PriceContext");
      assert.equal(parameters[0]?.description, "Rules and currency for the calculation.");
      const returned = focus?.metadata.returnType as Record<string, unknown>;
      assert.equal(returned.declaredType, "Money");
      assert.equal(returned.description, "The final payable amount.");
      assert.ok(result.nodes.some((node) => node.label === manifest.expectations.examples.interfaceContract));
      assert.ok(result.nodes.some((node) => node.label === manifest.expectations.examples.trait));
    });

    await context.test("generated PHPDoc types remain possible evidence with runtime limitations", () => {
      const phpDocMethod = symbol(manifest.expectations.examples.phpDocTypeMethod, "company-commerce");
      const result = graph.trace(selection(phpDocMethod), "origin");
      for (const relationshipType of ["parameter-type", "return-type"] as const) {
        const edge = result.edges.find((item) => item.type === relationshipType);
        assert.equal(edge?.confidence, "possible");
        assert.ok(edge?.evidence.some((evidence) => evidence.limitations.some((limitation) => limitation.includes("not enforced"))));
      }
      const focus = result.nodes.find((node) => node.id === result.focusNodeId);
      const parameters = focus?.metadata.parameters as Array<Record<string, unknown>>;
      assert.equal(parameters[0]?.typeSource, "phpdoc");
      assert.equal(parameters[0]?.description, "Legacy pricing input.");
      const returned = focus?.metadata.returnType as Record<string, unknown>;
      assert.equal(returned.typeSource, "phpdoc");
      assert.equal(returned.description, "Legacy monetary output.");
      assert.equal(focus?.metadata.description, "Copy an externally supplied pricing result.");
    });

    await context.test("generated late-static method exposes possible runtime binding", () => {
      const lateStatic = symbol(manifest.expectations.examples.lateStaticMethod, "company-commerce");
      const result = graph.trace(selection(lateStatic), "origin");
      const edge = result.edges.find((item) => item.type === "late-static-binding");
      assert.equal(edge?.confidence, "possible");
      assert.ok(edge?.evidence.some((evidence) => evidence.limitations.some((limitation) => limitation.includes("runtime called class"))));
      const focus = result.nodes.find((node) => node.id === result.focusNodeId);
      assert.ok((focus?.metadata.lateStaticBindings as unknown[]).length > 0);
      assert.equal((focus?.metadata.returnType as Record<string, unknown>).lateStatic, true);
    });

    await context.test("temporal comparison matches the generated three-repository historical scenario", async () => {
      const scenario = manifest.expectations.historicalComparison;
      const request = TemporalGraphComparisonRequestSchema.parse({ protocolVersion: scenario.protocolVersion, mode: scenario.mode, before: scenario.before, after: scenario.after });
      const result = await new TemporalGraphService(store, graph).compare(request);
      assert.equal(result.basis.policy, "explicit-revisions-only");
      assert.deepEqual(new Map(result.before.freshness.repositories.map((item) => [item.repositoryId, item.commit])), new Map(Object.entries(scenario.before.revisions)));
      assert.deepEqual(new Map(result.after.freshness.repositories.map((item) => [item.repositoryId, item.commit])), new Map(Object.entries(scenario.after.revisions)));
      for (const node of result.before.nodes) if (node.occurrence) assert.equal(node.occurrence.revision.commit, scenario.before.revisions[node.occurrence.revision.repositoryId]);
      for (const node of result.after.nodes) if (node.occurrence) assert.equal(node.occurrence.revision.commit, scenario.after.revisions[node.occurrence.revision.repositoryId]);
      const added = new Set(result.changes.edges.added.map((edge) => temporalEdgeIdentity(edge, result.after)));
      const removed = new Set(result.changes.edges.removed.map((edge) => temporalEdgeIdentity(edge, result.before)));
      for (const expected of scenario.expectedRelationships.added) assert.ok(added.has(expected.identity), `added temporal edge ${expected.identity}`);
      for (const expected of scenario.expectedRelationships.removed) assert.ok(removed.has(expected.identity), `removed temporal edge ${expected.identity}`);
      for (const expected of scenario.expectedRelationships.changed) {
        const changed = result.changes.edges.changed.find((item) => item.identity === expected.identity);
        assert.deepEqual(changed?.changedFields, expected.changedFields);
      }
      assert.notEqual(scenario.after.revisions["client-reporting"], repository("client-reporting").head, "fixture intentionally compares a historical reporting revision rather than HEAD");
    });

    await context.test("history classifies every category actually encoded by the generated fixture", async () => {
      const shared = repository("company-commerce");
      const events = await new HistoryService(store).analyze(shared.path, sharedTotal);
      const categories = new Set<string>(events.map((event) => event.category));
      assert.deepEqual(manifest.expectations.historyCategories, ["introduction", "implementation", "documentation", "formatting", "signature"]);
      for (const expected of manifest.expectations.historyCategories) {
        assert.ok(categories.has(expected), `fixture history should expose ${expected}`);
      }
      assert.equal(events[0]?.commit, shared.commits.introduction);
      assert.equal(events.some((event) => event.commit === shared.commits.unrelated), false);
      assert.ok(events.some((event) => event.commit === manifest.expectations.revertedCommit));
      assert.ok(events.every((event) => event.afterSource));

      const result = graph.trace(selection(sharedTotal), "history");
      assert.deepEqual(new Set(result.history.map((event) => event.id)), new Set(events.map((event) => event.id)));
      assert.equal(result.nodes.length, 1);
      assert.equal(result.edges.length, 0, "history is exposed as timeline events, not graph edges, by the current companion");
    });

    await context.test("history follows the generated trait file move and method rename evidence", async () => {
      const shared = repository("company-commerce");
      const traitMethod = symbol("Company\\Commerce\\Support\\PricingMath::discountedSubtotal", "company-commerce");
      const events = await new HistoryService(store).analyze(shared.path, traitMethod);
      const expected = manifest.expectations.historyEvidence.lineage;
      for (const expectedEvent of expected.events) {
        const event = events.find((candidate) => candidate.commit === expected.commit && candidate.category === expectedEvent.category);
        assert.ok(event?.lineage, `${expectedEvent.category} lineage is emitted`);
        assert.deepEqual({ fromPath: event.lineage.fromPath, toPath: event.lineage.toPath, fromSymbol: event.lineage.fromSymbol, toSymbol: event.lineage.toSymbol, confidence: event.lineage.confidence }, { fromPath: expectedEvent.fromPath, toPath: expectedEvent.toPath, fromSymbol: expectedEvent.fromSymbol, toSymbol: expectedEvent.toSymbol, confidence: expectedEvent.confidence });
        assert.deepEqual(event.lineage.evidence.map((evidence) => ({ resolutionMethod: evidence.resolutionMethod, confidence: evidence.confidence })), expectedEvent.evidence.map((evidence) => ({ resolutionMethod: evidence.resolutionMethod, confidence: evidence.confidence })));
      }
    });
  } finally {
    await scanner.close();
    store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
