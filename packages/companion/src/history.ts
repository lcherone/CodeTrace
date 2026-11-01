import { createHash } from "node:crypto";
import type { ActiveBehaviour, Evidence, HistoryEvent, InclusionState } from "@trace/contracts";
import { GitRepository } from "./git.js";
import type { IndexedSymbol, ParsedMethod, ParsedType } from "./model.js";
import { parsePhp } from "./php.js";
import { TraceStore } from "./store.js";

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const methodSymbol = (method: ParsedMethod) => `${method.classFqn}::${method.name}`;
const structuralContract = (method: ParsedMethod) => JSON.stringify({
  visibility: method.visibility, static: method.static, abstract: method.abstract,
  parameters: (method.parameters ?? []).map((parameter) => ({ byReference: parameter.byReference, variadic: parameter.variadic, type: parameter.type ?? parameter.docType })),
  returnType: method.returnType ?? method.docReturnType,
});
const typeRelationshipContract = (type: ParsedType) => JSON.stringify({ parent: type.parent, interfaces: type.interfaces, traits: type.traits });
const typeSignatureContract = (type: ParsedType) => JSON.stringify({
  kind: type.kind, abstract: type.abstract,
  methods: type.methods.map((method) => ({ name: method.name, signature: method.signature, visibility: method.visibility, static: method.static, abstract: method.abstract })),
});
const typeImplementationContract = (type: ParsedType) => JSON.stringify(type.methods.map((method) => ({ name: method.name, fingerprint: method.implementationFingerprint })));
const typeDocumentationContract = (type: ParsedType) => JSON.stringify({ description: type.description, details: type.documentationDetails, methods: type.methods.map((method) => ({ name: method.name, fingerprint: method.documentationFingerprint })) });
const sourceForType = (source: string, type: ParsedType): string => source.split("\n").slice(Math.max(0, type.range.startLine - 1), type.range.endLine).join("\n");

export class HistoryService {
  private readonly patchIds = new Map<string, string | undefined>();
  private readonly patchShapes = new Map<string, { forward: string; reverse: string }>();
  constructor(private readonly store: TraceStore) {}

  async analyze(repositoryRoot: string, symbol: IndexedSymbol, signal?: AbortSignal, maxCommits = 1000): Promise<HistoryEvent[]> {
    if (symbol.kind !== "method") return this.analyzeType(repositoryRoot, symbol, signal, maxCommits);
    return this.analyzeMethod(repositoryRoot, symbol, signal, maxCommits);
  }

  private async analyzeMethod(repositoryRoot: string, symbol: IndexedSymbol, signal?: AbortSignal, maxCommits = 1000): Promise<HistoryEvent[]> {
    if (symbol.kind !== "method" || !symbol.classFqn || !symbol.memberName) throw new Error("History currently requires a method symbol");
    const git = new GitRepository(repositoryRoot);
    const allCommits = await git.commitsForPath(symbol.path, maxCommits + 1, symbol.commit);
    const truncated = allCommits.length > maxCommits;
    const commits = allCommits.slice(0, maxCommits);
    type Observation = { meta: Awaited<ReturnType<GitRepository["commitsForPath"]>>[number]; path: string; method: ParsedMethod; moveFrom?: string; renameFrom?: string };
    const newestFirst: Observation[] = [];
    let trackedPath = symbol.path; let trackedClass = symbol.classFqn; let trackedMethod = symbol.memberName;
    for (const meta of commits) {
      if (signal?.aborted) throw new DOMException("History cancelled", "AbortError");
      const source = await git.show(meta.commit, trackedPath);
      let method: ParsedMethod | undefined; let renamedFrom: string | undefined;
      if (source) {
        try {
          const parsed = parsePhp(source, trackedPath);
          method = parsed.types.find((item) => item.fqn.toLowerCase() === trackedClass.toLowerCase())?.methods.find((item) => item.name.toLowerCase() === trackedMethod.toLowerCase());
          const newer = newestFirst.at(-1)?.method;
          if (!method && newer) {
            const candidates = parsed.types.flatMap((type) => type.methods).filter((candidate) => candidate.implementationFingerprint === newer.implementationFingerprint && structuralContract(candidate) === structuralContract(newer));
            const candidate = candidates.length === 1 ? candidates[0] : undefined;
            if (candidate) { method = candidate; renamedFrom = methodSymbol(candidate); }
          }
        } catch { /* A historical parse failure is represented as a gap, never a fabricated event. */ }
      }
      if (!method) continue;
      const observation: Observation = { meta, path: trackedPath, method };
      if (renamedFrom) {
        const newer = newestFirst.at(-1);
        if (newer) newer.renameFrom = renamedFrom;
        trackedClass = method.classFqn; trackedMethod = method.name;
      }
      const rename = (await git.changesAt(meta.commit)).find((change) => change.previousPath && change.path === trackedPath);
      if (rename?.previousPath) { observation.moveFrom = rename.previousPath; trackedPath = rename.previousPath; }
      newestFirst.push(observation);
    }
    const observations = newestFirst.reverse();
    const events: HistoryEvent[] = [];
    let previous: ParsedMethod | undefined;
    for (const observation of observations) {
      const current = observation.method;
      const commonLimitations = [...(truncated ? [`History traversal was bounded to ${maxCommits} commits`] : [])];
      if (observation.moveFrom) events.push({
        id: `history:${sha(`${symbol.id}:${observation.meta.commit}:move`)}`, symbolId: symbol.id, commit: observation.meta.commit,
        ...(observation.meta.parents[0] ? { parentCommit: observation.meta.parents[0] } : {}), category: "move", summary: `Move ${observation.moveFrom} to ${observation.path}`,
        authorName: observation.meta.authorName, authorEmail: observation.meta.authorEmail, authoredAt: observation.meta.authoredAt,
        ...(previous?.source ? { beforeSource: previous.source } : {}), afterSource: current.source,
        lineage: { fromPath: observation.moveFrom, toPath: observation.path, fromSymbol: observation.renameFrom ?? methodSymbol(current), toSymbol: methodSymbol(current), confidence: observation.renameFrom ? "possible" : "confirmed", evidence: [
          { repositoryId: symbol.repositoryId, commit: observation.meta.commit, path: observation.path, range: current.range, resolutionMethod: "git-rename-diff", confidence: "confirmed", detail: `Git rename detection maps ${observation.moveFrom} to ${observation.path}`, limitations: [] },
          ...(observation.renameFrom ? [{ repositoryId: symbol.repositoryId, commit: observation.meta.commit, path: observation.path, range: current.range, resolutionMethod: "syntax-fingerprint-and-git-change", confidence: "possible" as const, detail: "A unique method preserved its syntax-aware implementation fingerprint and structural contract across the moved file", limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"] }] : []),
        ], limitations: [...commonLimitations, ...(observation.renameFrom ? ["The file move is confirmed; method identity across the rename remains possible"] : [])] },
        limitations: commonLimitations,
      });
      if (observation.renameFrom) events.push({
        id: `history:${sha(`${symbol.id}:${observation.meta.commit}:rename`)}`, symbolId: symbol.id, commit: observation.meta.commit,
        ...(observation.meta.parents[0] ? { parentCommit: observation.meta.parents[0] } : {}), category: "rename", summary: `Rename ${observation.renameFrom} to ${methodSymbol(current)}`,
        authorName: observation.meta.authorName, authorEmail: observation.meta.authorEmail, authoredAt: observation.meta.authoredAt,
        ...(previous?.source ? { beforeSource: previous.source } : {}), afterSource: current.source,
        lineage: { fromPath: observation.moveFrom ?? observation.path, toPath: observation.path, fromSymbol: observation.renameFrom, toSymbol: methodSymbol(current), confidence: "possible", evidence: [{ repositoryId: symbol.repositoryId, commit: observation.meta.commit, path: observation.path, range: current.range, resolutionMethod: "syntax-fingerprint-and-git-change", confidence: "possible", detail: "A unique method preserved its syntax-aware implementation fingerprint and structural contract in a Git-changed file", limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"] }], limitations: [...commonLimitations, "Static equivalence establishes continuity but cannot prove the author's naming intent"] },
        limitations: commonLimitations,
      });
      let category: HistoryEvent["category"] | undefined;
      let summary = observation.meta.summary;
      if (!previous) { category = "introduction"; summary = `Earliest observed ${current.name}`; }
      else if (current.signatureFingerprint !== previous.signatureFingerprint) category = "signature";
      else if (current.implementationFingerprint !== previous.implementationFingerprint) category = "implementation";
      else if (current.documentationFingerprint !== previous.documentationFingerprint) category = "documentation";
      else if (current.source !== previous.source) category = "formatting";
      else if (JSON.stringify(current.calls) !== JSON.stringify(previous.calls)) category = "relationship";
      if (category) {
        const event: HistoryEvent = {
          id: `history:${sha(`${symbol.id}:${observation.meta.commit}:${category}`)}`,
          symbolId: symbol.id,
          commit: observation.meta.commit,
          ...(observation.meta.parents[0] ? { parentCommit: observation.meta.parents[0] } : {}),
          category,
          summary,
          authorName: observation.meta.authorName,
          authorEmail: observation.meta.authorEmail,
          authoredAt: observation.meta.authoredAt,
          ...(previous?.source ? { beforeSource: previous.source } : {}),
          afterSource: current.source,
          limitations: [...(commits.length < 2 ? ["History may be incomplete if this repository is shallow"] : []), ...commonLimitations],
        };
        events.push(event);
      }
      previous = current;
    }
    this.store.replaceHistory(symbol.repositoryId, symbol.id, events);
    return events;
  }

  private async analyzeType(repositoryRoot: string, symbol: IndexedSymbol, signal?: AbortSignal, maxCommits = 1000): Promise<HistoryEvent[]> {
    if (!["class", "interface", "trait"].includes(symbol.kind)) throw new Error("History requires a class, interface, trait, or method symbol");
    const git = new GitRepository(repositoryRoot);
    const allCommits = await git.commitsForPath(symbol.path, maxCommits + 1, symbol.commit);
    const truncated = allCommits.length > maxCommits;
    const commits = allCommits.slice(0, maxCommits);
    type Observation = { meta: Awaited<ReturnType<GitRepository["commitsForPath"]>>[number]; type: ParsedType; source: string };
    const newestFirst: Observation[] = [];
    for (const meta of commits) {
      signal?.throwIfAborted();
      const source = await git.show(meta.commit, symbol.path);
      if (!source) continue;
      try {
        const type = parsePhp(source, symbol.path).types.find((candidate) => candidate.fqn.toLowerCase() === symbol.fqn.toLowerCase());
        if (type) newestFirst.push({ meta, type, source: sourceForType(source, type) });
      } catch { /* Historical parse gaps stay gaps instead of becoming fabricated events. */ }
    }
    const events: HistoryEvent[] = [];
    let previous: Observation | undefined;
    for (const observation of newestFirst.reverse()) {
      signal?.throwIfAborted();
      let category: HistoryEvent["category"] | undefined;
      let summary = observation.meta.summary;
      if (!previous) { category = "introduction"; summary = `Earliest observed ${observation.type.shortName}`; }
      else if (typeRelationshipContract(observation.type) !== typeRelationshipContract(previous.type)) category = "relationship";
      else if (typeSignatureContract(observation.type) !== typeSignatureContract(previous.type)) category = "signature";
      else if (typeImplementationContract(observation.type) !== typeImplementationContract(previous.type)) category = "implementation";
      else if (typeDocumentationContract(observation.type) !== typeDocumentationContract(previous.type)) category = "documentation";
      else if (observation.source !== previous.source) category = "formatting";
      if (category) events.push({
        id: `history:${sha(`${symbol.id}:${observation.meta.commit}:${category}`)}`,
        symbolId: symbol.id,
        commit: observation.meta.commit,
        ...(observation.meta.parents[0] ? { parentCommit: observation.meta.parents[0] } : {}),
        category,
        summary,
        authorName: observation.meta.authorName,
        authorEmail: observation.meta.authorEmail,
        authoredAt: observation.meta.authoredAt,
        ...(previous ? { beforeSource: previous.source } : {}),
        afterSource: observation.source,
        limitations: [
          ...(commits.length < 2 ? ["History may be incomplete if this repository is shallow"] : []),
          ...(truncated ? [`History traversal was bounded to ${maxCommits} commits`] : []),
        ],
      });
      previous = observation;
    }
    this.store.replaceHistory(symbol.repositoryId, symbol.id, events);
    return events;
  }

  async inclusion(repositoryRoot: string, commit: string, revisions: string[]): Promise<Array<{ revision: string; status: "contains" | "does-not-contain" | "unknown" }>> {
    const git = new GitRepository(repositoryRoot);
    return Promise.all(revisions.map(async (revision) => {
      try { return { revision, status: await git.contains(commit, revision) ? "contains" as const : "does-not-contain" as const }; }
      catch { return { revision, status: "unknown" as const }; }
    }));
  }

  async assessInclusion(repositoryRoot: string, selectedCommit: string, basisCommit: string, options: { signal?: AbortSignal; maxCommits?: number; repositoryId?: string } = {}): Promise<{
    state: InclusionState; activeBehaviour: ActiveBehaviour; basisCommit: string; equivalentCommit?: string; revertCommit?: string; lastMatchingCommit?: string; evidence: Evidence[]; limitations: string[];
  }> {
    const git = new GitRepository(repositoryRoot);
    const signal = options.signal; const maxCommits = options.maxCommits ?? 2000; const evidenceRepositoryId = options.repositoryId ?? "source";
    const [original, basis] = await Promise.all([git.resolveCommit(selectedCommit), git.resolveCommit(basisCommit)]);
    if (!original || !basis) return { state: "unknown", activeBehaviour: "unknown", basisCommit, evidence: [], limitations: ["The selected change or exact target revision is unavailable"] };
    signal?.throwIfAborted();
    const originalIncluded = await git.contains(original, basis);
    try {
    const patchKey = `${repositoryRoot}\0${original}`;
    let applyPatch = this.patchIds.get(patchKey); if (!this.patchIds.has(patchKey)) { applyPatch = await git.patchId(original); this.patchIds.set(patchKey, applyPatch); }
    let originalShape = this.patchShapes.get(patchKey); if (!originalShape) { originalShape = await git.patchShape(original); this.patchShapes.set(patchKey, originalShape); }
    const selectedChanges = await git.changesAt(original);
    const changedPaths = [...new Set(selectedChanges.flatMap((change) => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))];
    const revisions = await git.commitsTouching(basis, changedPaths, maxCommits + 1); const bounded = revisions.length > maxCommits; const candidates = revisions.slice(0, maxCommits);
    const matches: Array<{ commit: string; kind: "apply" | "reverse" }> = [];
    if (applyPatch) for (const candidate of candidates) {
      signal?.throwIfAborted();
      const key = `${repositoryRoot}\0${candidate}`; let candidatePatch = this.patchIds.get(key);
      if (!this.patchIds.has(key)) { candidatePatch = await git.patchId(candidate); this.patchIds.set(key, candidatePatch); }
      if (candidatePatch && candidatePatch === applyPatch) matches.push({ commit: candidate, kind: "apply" });
      else {
        let candidateShape = this.patchShapes.get(key); if (!candidateShape) { candidateShape = await git.patchShape(candidate); this.patchShapes.set(key, candidateShape); }
        if (candidateShape.forward === originalShape.reverse) matches.push({ commit: candidate, kind: "reverse" });
      }
    }
    const equivalent = matches.find((match) => match.kind === "apply" && match.commit !== original);
    const state: InclusionState = originalIncluded ? "contains-original" : equivalent ? "likely-equivalent" : bounded || !applyPatch ? "unknown" : "does-not-contain-original";
    const maximal: typeof matches = [];
    for (const match of matches) {
      signal?.throwIfAborted(); let superseded = false;
      for (const other of matches) if (other.commit !== match.commit && await git.contains(match.commit, other.commit)) { superseded = true; break; }
      if (!superseded) maximal.push(match);
    }
    const kinds = new Set(maximal.map((match) => match.kind));
    const activeBehaviour: ActiveBehaviour = bounded || kinds.size !== 1 ? "unknown" : kinds.has("apply") ? "likely-active" : "reverted";
    const lastMatchingCommit = maximal.length === 1 ? maximal[0]?.commit : undefined;
    const revertCommit = maximal.length === 1 && maximal[0]?.kind === "reverse" ? maximal[0].commit : undefined;
    const evidence: Evidence[] = [{ repositoryId: evidenceRepositoryId, commit: basis, resolutionMethod: "git-commit-ancestry", confidence: "confirmed", detail: originalIncluded ? `${original} is an ancestor of ${basis}` : `${original} is not an ancestor of ${basis}`, limitations: ["Ancestry alone does not prove that behaviour remains active after a revert"] }];
    if (equivalent) evidence.push({ repositoryId: evidenceRepositoryId, commit: equivalent.commit, resolutionMethod: "git-patch-id-stable", confidence: "possible", detail: `${equivalent.commit} has the same stable patch-id as ${original}`, limitations: ["Patch equivalence does not prove identical surrounding context"] });
    if (lastMatchingCommit) evidence.push({ repositoryId: evidenceRepositoryId, commit: lastMatchingCommit, resolutionMethod: "git-patch-id-reachable-order", confidence: activeBehaviour === "unknown" ? "unresolved" : "possible", detail: `The last ancestry-comparable matching patch is a${activeBehaviour === "reverted" ? " reverse" : "n apply"} patch`, limitations: ["Active behaviour is inferred from matching patches and does not execute the code"] });
    const limitations = ["Patch equivalence search is restricted to non-merge commits touching the selected change paths", ...(bounded ? [`Patch history traversal was bounded to ${maxCommits} path-changing commits; inclusion and active behaviour may be incomplete`] : []), ...(kinds.size > 1 ? ["Competing apply and reverse patch tips are not ancestry-comparable"] : []), ...(!applyPatch ? ["The selected commit has no stable textual patch-id"] : [])];
    return { state, activeBehaviour, basisCommit: basis, ...(equivalent ? { equivalentCommit: equivalent.commit } : {}), ...(revertCommit ? { revertCommit } : {}), ...(lastMatchingCommit ? { lastMatchingCommit } : {}), evidence, limitations };
    } catch (error) {
      if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") throw error;
      return {
        state: originalIncluded ? "contains-original" : "unknown",
        activeBehaviour: "unknown",
        basisCommit: basis,
        evidence: [{ repositoryId: evidenceRepositoryId, commit: basis, resolutionMethod: "git-commit-ancestry", confidence: "confirmed", detail: originalIncluded ? `${original} is an ancestor of ${basis}` : `${original} is not an ancestor of ${basis}`, limitations: ["Patch assessment was unavailable"] }],
        limitations: [`Patch equivalence and active-behaviour assessment was unavailable: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
}
