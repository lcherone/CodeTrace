import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { HistoryEvent } from "@trace/contracts";
import type { ComposerDependency, ComposerPackage, IndexedRelationship, IndexedSymbol, ParsedCall, ParsedFile, RepositoryRecord } from "./model.js";
import { sanitizeRepositoryUrl } from "./composer.js";

interface Row { [key: string]: unknown }

function cacheAnalysis(analysis: ParsedFile): ParsedFile {
  return {
    ...analysis,
    types: analysis.types.map((type) => ({
      ...type,
      methods: type.methods.map((method) => ({ ...method, source: "" })),
    })),
  };
}

export interface PersistedScanJob {
  id: string;
  repositoryId: string;
  state: string;
  requestedAt: string;
  updatedAt: string;
  status: Record<string, unknown>;
}

export interface ActiveCountSymbol {
  id: string;
  generation: number;
  repositoryId: string;
  commit: string;
  path: string;
  kind: IndexedSymbol["kind"];
  fqn: string;
  memberName?: string;
  classFqn?: string;
  range: IndexedSymbol["range"];
  calls: ParsedCall[];
  parent?: string;
}

export interface ActiveCallEdge { sourceId: string; targetId: string }

export class TraceStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.migrate();
    this.recoverInterruptedWork();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const current = Number((this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as Row).version ?? 0);
    if (current < 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE repositories(
          id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, remote_url TEXT, default_branch TEXT,
          include_json TEXT NOT NULL DEFAULT '[]', exclude_json TEXT NOT NULL DEFAULT '[]',
          active_generation INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE generations(
          id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          commit_sha TEXT NOT NULL, branch TEXT, dirty INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed','cancelled')),
          total_files INTEGER NOT NULL DEFAULT 0, completed_files INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL, completed_at TEXT, error TEXT
        );
        CREATE TABLE file_cache(
          repository_id TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL,
          analysis_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(repository_id, path, content_hash)
        );
        CREATE TABLE symbols(
          id TEXT NOT NULL, generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
          fqn TEXT NOT NULL, member_name TEXT, class_fqn TEXT, range_json TEXT NOT NULL, data_json TEXT NOT NULL,
          PRIMARY KEY(generation_id, id)
        );
        CREATE INDEX symbols_lookup ON symbols(repository_id, generation_id, lower(fqn), lower(member_name));
        CREATE TABLE relationships(
          id TEXT NOT NULL, generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL, commit_sha TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
          type TEXT NOT NULL, confidence TEXT NOT NULL, path TEXT, range_json TEXT, detail TEXT NOT NULL, limitations_json TEXT NOT NULL,
          PRIMARY KEY(generation_id, id)
        );
        CREATE INDEX relationships_nodes ON relationships(generation_id, source_id, target_id);
        CREATE TABLE packages(
          generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE, repository_id TEXT NOT NULL,
          root_path TEXT NOT NULL, name TEXT NOT NULL, version TEXT, source_commit TEXT, autoload_json TEXT NOT NULL,
          PRIMARY KEY(generation_id, name, root_path)
        );
        CREATE TABLE dependencies(
          generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE, repository_id TEXT NOT NULL,
          package_name TEXT NOT NULL, development INTEGER NOT NULL, direct INTEGER NOT NULL,
          declared_constraint TEXT, resolved_version TEXT, resolved_source_commit TEXT,
          indexed_repository_id TEXT, indexed_revision TEXT, resolution TEXT NOT NULL,
          PRIMARY KEY(generation_id, package_name, development)
        );
        CREATE TABLE history_events(
          id TEXT NOT NULL, repository_id TEXT NOT NULL, symbol_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
          event_json TEXT NOT NULL, PRIMARY KEY(repository_id, id)
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES(1, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 2) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS package_mappings(
          package_name TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          package_root TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 3) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE file_cache ADD COLUMN source_fingerprint TEXT;
        UPDATE file_cache SET source_fingerprint=content_hash WHERE source_fingerprint IS NULL;
        CREATE INDEX IF NOT EXISTS file_cache_fingerprint ON file_cache(repository_id, path, source_fingerprint);
        CREATE TABLE IF NOT EXISTS scan_jobs(
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS scan_jobs_repository ON scan_jobs(repository_id, updated_at DESC);
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 4) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE repositories ADD COLUMN source_revision TEXT;
        ALTER TABLE repositories ADD COLUMN discovered_from TEXT;
        ALTER TABLE repositories ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 5) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE repositories ADD COLUMN inventory_fingerprint TEXT;
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 6) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE packages ADD COLUMN repository_path TEXT;
        ALTER TABLE packages ADD COLUMN repository_url TEXT;
        ALTER TABLE packages ADD COLUMN normalized_repository_url TEXT;
        ALTER TABLE dependencies ADD COLUMN declared_constraint_base TEXT;
        ALTER TABLE dependencies ADD COLUMN declared_alias TEXT;
        ALTER TABLE dependencies ADD COLUMN resolved_source_reference TEXT;
        ALTER TABLE dependencies ADD COLUMN resolved_source_url TEXT;
        ALTER TABLE dependencies ADD COLUMN normalized_source_url TEXT;
        ALTER TABLE dependencies ADD COLUMN resolved_dist_reference TEXT;
        ALTER TABLE dependencies ADD COLUMN resolved_dist_url TEXT;
        ALTER TABLE dependencies ADD COLUMN resolved_path TEXT;
        ALTER TABLE dependencies ADD COLUMN resolution_method TEXT NOT NULL DEFAULT 'unresolved';
        ALTER TABLE dependencies ADD COLUMN resolution_evidence_json TEXT NOT NULL DEFAULT '[]';
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 7) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE packages ADD COLUMN branch_aliases_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE dependencies ADD COLUMN repository_candidates_json TEXT NOT NULL DEFAULT '[]';
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(7, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 8) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE relationships ADD COLUMN resolution_method TEXT;
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(8, datetime('now'));
        COMMIT;
      `);
    }
    if (current < 9) {
      this.db.exec(`
        BEGIN;
        CREATE INDEX symbols_class_lookup ON symbols(repository_id,generation_id,lower(class_fqn));
        CREATE INDEX symbols_file_lookup ON symbols(repository_id,generation_id,path,kind);
        CREATE INDEX relationships_target_lookup ON relationships(repository_id,generation_id,target_id);
        CREATE INDEX history_symbol_lookup ON history_events(symbol_id);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(9,datetime('now'));
        COMMIT;
      `);
    }
    if (current < 10) {
      this.db.exec(`
        BEGIN;
        CREATE INDEX symbols_type_inventory ON symbols(repository_id,generation_id) WHERE kind IN ('class','interface','trait');
        INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(10,datetime('now'));
        COMMIT;
      `);
    }
  }

  private recoverInterruptedWork(): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE generations SET state='failed',error='Companion stopped before this generation was published',completed_at=? WHERE state IN ('queued','running')").run(now);
    const rows = this.db.prepare("SELECT id,status_json FROM scan_jobs WHERE state IN ('queued','running')").all() as Row[];
    const update = this.db.prepare("UPDATE scan_jobs SET state='failed',updated_at=?,status_json=? WHERE id=?");
    for (const row of rows) {
      const status = JSON.parse(String(row.status_json)) as Record<string, unknown>;
      update.run(now, JSON.stringify({ ...status, state: "failed", stage: "failed", error: "Companion stopped before this scan completed", completedAt: now }), String(row.id));
    }
  }

  upsertRepository(repository: RepositoryRecord): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO repositories(id,root,remote_url,default_branch,include_json,exclude_json,created_at,updated_at,source_revision,discovered_from,automatic)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,remote_url=COALESCE(excluded.remote_url,repositories.remote_url),
      default_branch=COALESCE(excluded.default_branch,repositories.default_branch),include_json=excluded.include_json,exclude_json=excluded.exclude_json,updated_at=excluded.updated_at,
      source_revision=COALESCE(excluded.source_revision,repositories.source_revision),discovered_from=COALESCE(excluded.discovered_from,repositories.discovered_from),automatic=excluded.automatic`)
      .run(repository.id, repository.root, sanitizeRepositoryUrl(repository.remoteUrl) ?? null, repository.defaultBranch ?? null, JSON.stringify(repository.include ?? []), JSON.stringify(repository.exclude ?? []), now, now, repository.sourceRevision ?? null, repository.discoveredFrom ?? null, repository.automatic ? 1 : 0);
  }

  removeRepository(id: string): boolean { return Number(this.db.prepare("DELETE FROM repositories WHERE id=?").run(id).changes) > 0; }

  listRepositories(): Array<RepositoryRecord & { activeGeneration?: number }> {
    return (this.db.prepare("SELECT * FROM repositories ORDER BY id").all() as Row[]).map((row) => ({
      id: String(row.id), root: String(row.root),
      ...(row.remote_url ? { remoteUrl: String(row.remote_url) } : {}),
      ...(row.default_branch ? { defaultBranch: String(row.default_branch) } : {}),
      include: JSON.parse(String(row.include_json)), exclude: JSON.parse(String(row.exclude_json)),
      ...(row.source_revision ? { sourceRevision: String(row.source_revision) } : {}),
      ...(row.discovered_from ? { discoveredFrom: String(row.discovered_from) } : {}),
      ...(row.automatic ? { automatic: true } : {}),
      ...(row.active_generation ? { activeGeneration: Number(row.active_generation) } : {}),
    }));
  }

  repository(id: string): (RepositoryRecord & { activeGeneration?: number }) | undefined { return this.listRepositories().find((repository) => repository.id === id); }

  beginGeneration(repositoryId: string, commit: string, branch: string | undefined, dirty: boolean, totalFiles: number): number {
    const result = this.db.prepare("INSERT INTO generations(repository_id,commit_sha,branch,dirty,state,total_files,started_at) VALUES(?,?,?,?,?,?,?)")
      .run(repositoryId, commit, branch ?? null, dirty ? 1 : 0, "running", totalFiles, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  updateProgress(generation: number, completedFiles: number): void { this.db.prepare("UPDATE generations SET completed_files=? WHERE id=?").run(completedFiles, generation); }

  failGeneration(generation: number, state: "failed" | "cancelled", error: string): void {
    this.db.prepare("UPDATE generations SET state=?, error=?, completed_at=? WHERE id=?").run(state, error, new Date().toISOString(), generation);
  }

  cachedFile(repositoryId: string, pathName: string, contentHash: string): ParsedFile | undefined {
    const row = this.db.prepare("SELECT analysis_json FROM file_cache WHERE repository_id=? AND path=? AND content_hash=?").get(repositoryId, pathName, contentHash) as Row | undefined;
    return row ? JSON.parse(String(row.analysis_json)) as ParsedFile : undefined;
  }

  cachedFileByFingerprint(repositoryId: string, pathName: string, sourceFingerprint: string): ParsedFile | undefined {
    const row = this.db.prepare("SELECT analysis_json FROM file_cache WHERE repository_id=? AND path=? AND source_fingerprint=? ORDER BY updated_at DESC LIMIT 1").get(repositoryId, pathName, sourceFingerprint) as Row | undefined;
    return row ? JSON.parse(String(row.analysis_json)) as ParsedFile : undefined;
  }

  cacheFile(repositoryId: string, analysis: ParsedFile, sourceFingerprint = analysis.contentHash): void {
    this.db.prepare("INSERT OR REPLACE INTO file_cache(repository_id,path,content_hash,analysis_json,updated_at,source_fingerprint) VALUES(?,?,?,?,?,?)")
      .run(repositoryId, analysis.path, analysis.contentHash, JSON.stringify(cacheAnalysis(analysis)), new Date().toISOString(), sourceFingerprint);
    this.db.prepare("DELETE FROM file_cache WHERE rowid IN (SELECT rowid FROM file_cache WHERE repository_id=? AND path=? ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 3)")
      .run(repositoryId, analysis.path);
  }

  activeGenerationSignature(): string {
    return (this.db.prepare("SELECT id,active_generation FROM repositories ORDER BY id").all() as Row[])
      .map((row) => `${String(row.id)}:${Number(row.active_generation ?? 0)}`).join("|");
  }

  saveScanJob(job: PersistedScanJob): void {
    this.db.prepare("INSERT INTO scan_jobs(id,repository_id,state,requested_at,updated_at,status_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,status_json=excluded.status_json")
      .run(job.id, job.repositoryId, job.state, job.requestedAt, job.updatedAt, JSON.stringify(job.status));
    if (["ready", "failed", "cancelled"].includes(job.state)) {
      this.db.prepare("DELETE FROM scan_jobs WHERE repository_id=? AND id NOT IN (SELECT id FROM scan_jobs WHERE repository_id=? ORDER BY updated_at DESC LIMIT 20)")
        .run(job.repositoryId, job.repositoryId);
    }
  }

  currentGeneration(repositoryId: string, commit: string, inventoryFingerprint: string): number | undefined {
    const row = this.db.prepare(`SELECT r.active_generation FROM repositories r
      JOIN generations g ON g.id=r.active_generation
      WHERE r.id=? AND g.commit_sha=? AND r.inventory_fingerprint=? AND g.state='ready'`)
      .get(repositoryId, commit, inventoryFingerprint) as Row | undefined;
    return row?.active_generation ? Number(row.active_generation) : undefined;
  }

  scanJobs(limit = 500): PersistedScanJob[] {
    return (this.db.prepare("SELECT * FROM scan_jobs ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map((row) => ({ id: String(row.id), repositoryId: String(row.repository_id), state: String(row.state), requestedAt: String(row.requested_at), updatedAt: String(row.updated_at), status: JSON.parse(String(row.status_json)) as Record<string, unknown> }));
  }

  publishGeneration(generation: number, repositoryId: string, inventoryFingerprint: string, symbols: IndexedSymbol[], relationships: IndexedRelationship[], packages: ComposerPackage[], dependencies: ComposerDependency[]): void {
    const symbolStatement = this.db.prepare("INSERT INTO symbols(id,generation_id,repository_id,commit_sha,path,kind,fqn,member_name,class_fqn,range_json,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const relationStatement = this.db.prepare("INSERT INTO relationships(id,generation_id,repository_id,commit_sha,source_id,target_id,type,confidence,path,range_json,detail,limitations_json,resolution_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const packageStatement = this.db.prepare("INSERT INTO packages(generation_id,repository_id,root_path,name,version,source_commit,autoload_json,repository_path,repository_url,normalized_repository_url,branch_aliases_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const dependencyStatement = this.db.prepare("INSERT INTO dependencies(generation_id,repository_id,package_name,development,direct,declared_constraint,resolved_version,resolved_source_commit,indexed_repository_id,indexed_revision,resolution,declared_constraint_base,declared_alias,resolved_source_reference,resolved_source_url,normalized_source_url,resolved_dist_reference,resolved_dist_url,resolved_path,resolution_method,resolution_evidence_json,repository_candidates_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of symbols) symbolStatement.run(item.id, generation, item.repositoryId, item.commit, item.path, item.kind, item.fqn, item.memberName ?? null, item.classFqn ?? null, JSON.stringify(item.range), JSON.stringify(item.data));
      for (const item of relationships) relationStatement.run(item.id, generation, item.repositoryId, item.commit, item.sourceId, item.targetId, item.type, item.confidence, item.path ?? null, item.range ? JSON.stringify(item.range) : null, item.detail, JSON.stringify(item.limitations), item.resolutionMethod ?? null);
      for (const item of packages) packageStatement.run(generation, item.repositoryId, item.rootPath, item.name, item.version ?? null, item.sourceCommit ?? null, JSON.stringify(item.autoload), item.repositoryPath ?? null, item.repositoryUrl ?? null, item.normalizedRepositoryUrl ?? null, JSON.stringify(item.branchAliases ?? {}));
      for (const item of dependencies) dependencyStatement.run(generation, item.repositoryId, item.packageName, item.development ? 1 : 0, item.direct ? 1 : 0, item.declaredConstraint ?? null, item.resolvedVersion ?? null, item.resolvedSourceCommit ?? null, item.indexedRepositoryId ?? null, item.indexedRevision ?? null, item.resolution, item.declaredConstraintBase ?? null, item.declaredAlias ?? null, item.resolvedSourceReference ?? null, item.resolvedSourceUrl ?? null, item.normalizedSourceUrl ?? null, item.resolvedDistReference ?? null, item.resolvedDistUrl ?? null, item.resolvedPath ?? null, item.resolutionMethod ?? "unresolved", JSON.stringify(item.resolutionEvidence ?? []), JSON.stringify(item.repositoryCandidates ?? []));
      const completedAt = new Date().toISOString();
      this.db.prepare("UPDATE generations SET state='ready',completed_files=total_files,completed_at=? WHERE id=?").run(completedAt, generation);
      this.db.prepare("UPDATE repositories SET active_generation=?,inventory_fingerprint=?,updated_at=? WHERE id=?").run(generation, inventoryFingerprint, completedAt, repositoryId);
      this.db.prepare("DELETE FROM generations WHERE repository_id=? AND id<>?").run(repositoryId, generation);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activeSymbols(): IndexedSymbol[] {
    return (this.db.prepare("SELECT s.* FROM symbols s JOIN repositories r ON r.id=s.repository_id AND r.active_generation=s.generation_id").all() as Row[]).map((row) => ({
      id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), path: String(row.path), kind: row.kind as IndexedSymbol["kind"], fqn: String(row.fqn),
      ...(row.member_name ? { memberName: String(row.member_name) } : {}), ...(row.class_fqn ? { classFqn: String(row.class_fqn) } : {}),
      range: JSON.parse(String(row.range_json)), data: JSON.parse(String(row.data_json)),
    }));
  }

  /** Small ancestry inventory; full declarations are read at exact Git revisions on demand. */
  typeInventory(repositoryId: string): IndexedSymbol[] {
    const rows = this.db.prepare(`SELECT s.id,s.generation_id,s.repository_id,s.commit_sha,s.path,s.kind,s.fqn,s.range_json,
      json_extract(s.data_json,'$.parent') AS parent,
      json_extract(s.data_json,'$.interfaces') AS interfaces,
      json_extract(s.data_json,'$.traits') AS traits
      FROM symbols s JOIN repositories r ON r.id=s.repository_id AND r.active_generation=s.generation_id
      WHERE s.repository_id=? AND s.kind IN ('class','interface','trait')`).all(repositoryId) as Row[];
    return rows.map((row) => ({ id: String(row.id), generation: Number(row.generation_id), repositoryId, commit: String(row.commit_sha), path: String(row.path), kind: row.kind as IndexedSymbol["kind"], fqn: String(row.fqn), range: JSON.parse(String(row.range_json)), data: { fqn: String(row.fqn), kind: row.kind, parent: row.parent ? String(row.parent) : undefined, interfaces: row.interfaces ? JSON.parse(String(row.interfaces)) : [], traits: row.traits ? JSON.parse(String(row.traits)) : [], methods: [] } as unknown as IndexedSymbol["data"] }));
  }

  activeSymbolsForRepositories(repositoryIds: readonly string[], pathName?: string, typesOnly = false, symbolIds?: readonly string[]): IndexedSymbol[] {
    if (!repositoryIds.length) return [];
    if (symbolIds && !symbolIds.length) return [];
    const placeholders = repositoryIds.map(() => "?").join(",");
    return (this.db.prepare(`SELECT s.* FROM symbols s JOIN repositories r ON r.id=s.repository_id AND r.active_generation=s.generation_id WHERE s.repository_id IN (${placeholders})${pathName === undefined ? "" : " AND s.path=?"}${typesOnly ? " AND s.kind<>'method'" : ""}${symbolIds ? ` AND s.id IN (${symbolIds.map(() => "?").join(",")})` : ""}`).all(...repositoryIds, ...(pathName === undefined ? [] : [pathName]), ...(symbolIds ?? [])) as Row[]).map((row) => ({
      id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), path: String(row.path), kind: row.kind as IndexedSymbol["kind"], fqn: String(row.fqn),
      ...(row.member_name ? { memberName: String(row.member_name) } : {}), ...(row.class_fqn ? { classFqn: String(row.class_fqn) } : {}),
      range: JSON.parse(String(row.range_json)), data: JSON.parse(String(row.data_json)),
    }));
  }

  activeSymbolsMatchingClasses(repositoryIds: readonly string[], classFqns: readonly string[], includeMethods = true): IndexedSymbol[] {
    if (!repositoryIds.length || !classFqns.length) return [];
    const rowsById = new Map<string, Row>();
    const normalizedClasses = [...new Set(classFqns.map((item) => item.toLowerCase()))];
    // Keep well below SQLite's host-parameter limit even for unusually large
    // Composer installations and generated union types.
    for (let repositoryOffset = 0; repositoryOffset < repositoryIds.length; repositoryOffset += 400) {
      const repositories = repositoryIds.slice(repositoryOffset, repositoryOffset + 400);
      const repositoryPlaceholders = repositories.map(() => "?").join(",");
      for (let classOffset = 0; classOffset < normalizedClasses.length; classOffset += 100) {
        const classes = normalizedClasses.slice(classOffset, classOffset + 100);
        const classPlaceholders = classes.map(() => "?").join(",");
        const rows = this.db.prepare(`SELECT s.* FROM symbols s
          JOIN repositories r ON r.id=s.repository_id AND r.active_generation=s.generation_id
          WHERE s.repository_id IN (${repositoryPlaceholders})
            AND (lower(s.fqn) IN (${classPlaceholders})${includeMethods ? ` OR lower(s.class_fqn) IN (${classPlaceholders})` : ""})`)
          .all(...repositories, ...classes, ...(includeMethods ? classes : [])) as Row[];
        for (const row of rows) rowsById.set(String(row.id), row);
      }
    }
    return [...rowsById.values()].map((row) => ({
      id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), path: String(row.path), kind: row.kind as IndexedSymbol["kind"], fqn: String(row.fqn),
      ...(row.member_name ? { memberName: String(row.member_name) } : {}), ...(row.class_fqn ? { classFqn: String(row.class_fqn) } : {}),
      range: JSON.parse(String(row.range_json)), data: JSON.parse(String(row.data_json)),
    }));
  }

  activeCountSymbolsBatch(afterRowId: number, limit: number): { items: ActiveCountSymbol[]; nextRowId?: number } {
    const rows = this.db.prepare("SELECT s.rowid AS _rowid,s.id,s.generation_id,s.repository_id,s.commit_sha,s.path,s.kind,s.fqn,s.member_name,s.class_fqn,s.range_json,s.data_json FROM symbols s JOIN repositories r ON r.id=s.repository_id AND r.active_generation=s.generation_id WHERE s.rowid>? ORDER BY s.rowid LIMIT ?").all(afterRowId, limit) as Row[];
    const items = rows.map((row) => {
      const data = JSON.parse(String(row.data_json)) as { calls?: ParsedCall[]; parent?: string };
      return {
        id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), path: String(row.path), kind: row.kind as IndexedSymbol["kind"], fqn: String(row.fqn),
        ...(row.member_name ? { memberName: String(row.member_name) } : {}), ...(row.class_fqn ? { classFqn: String(row.class_fqn) } : {}),
        range: JSON.parse(String(row.range_json)), calls: data.calls ?? [], ...(data.parent ? { parent: data.parent } : {}),
      };
    });
    return { items, ...(rows.length ? { nextRowId: Number(rows.at(-1)!._rowid) } : {}) };
  }

  activeRelationships(): IndexedRelationship[] {
    return (this.db.prepare("SELECT x.* FROM relationships x JOIN repositories r ON r.id=x.repository_id AND r.active_generation=x.generation_id").all() as Row[]).map((row) => ({
      id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), sourceId: String(row.source_id), targetId: String(row.target_id), type: row.type as IndexedRelationship["type"], confidence: row.confidence as IndexedRelationship["confidence"],
      ...(row.path ? { path: String(row.path) } : {}), ...(row.range_json ? { range: JSON.parse(String(row.range_json)) } : {}), detail: String(row.detail), limitations: JSON.parse(String(row.limitations_json)), ...(row.resolution_method ? { resolutionMethod: String(row.resolution_method) } : {}),
    }));
  }

  activeRelationshipsForRepositories(repositoryIds: readonly string[], symbolIds?: readonly string[]): IndexedRelationship[] {
    if (!repositoryIds.length) return [];
    if (symbolIds && !symbolIds.length) return [];
    const placeholders = repositoryIds.map(() => "?").join(",");
    const symbolPlaceholders = symbolIds?.map(() => "?").join(",");
    return (this.db.prepare(`SELECT x.* FROM relationships x JOIN repositories r ON r.id=x.repository_id AND r.active_generation=x.generation_id WHERE x.repository_id IN (${placeholders})${symbolIds ? ` AND (x.source_id IN (${symbolPlaceholders}) OR x.target_id IN (${symbolPlaceholders}))` : ""}`).all(...repositoryIds, ...(symbolIds ?? []), ...(symbolIds ?? [])) as Row[]).map((row) => ({
      id: String(row.id), generation: Number(row.generation_id), repositoryId: String(row.repository_id), commit: String(row.commit_sha), sourceId: String(row.source_id), targetId: String(row.target_id), type: row.type as IndexedRelationship["type"], confidence: row.confidence as IndexedRelationship["confidence"],
      ...(row.path ? { path: String(row.path) } : {}), ...(row.range_json ? { range: JSON.parse(String(row.range_json)) } : {}), detail: String(row.detail), limitations: JSON.parse(String(row.limitations_json)), ...(row.resolution_method ? { resolutionMethod: String(row.resolution_method) } : {}),
    }));
  }

  activeCallEdgesBatch(afterRowId: number, limit: number): { items: ActiveCallEdge[]; nextRowId?: number } {
    const rows = this.db.prepare("SELECT x.rowid AS _rowid,x.source_id,x.target_id FROM relationships x JOIN repositories r ON r.id=x.repository_id AND r.active_generation=x.generation_id WHERE x.rowid>? AND x.type IN ('calls','calls-parent') ORDER BY x.rowid LIMIT ?").all(afterRowId, limit) as Row[];
    return { items: rows.map((row) => ({ sourceId: String(row.source_id), targetId: String(row.target_id) })), ...(rows.length ? { nextRowId: Number(rows.at(-1)!._rowid) } : {}) };
  }

  activeGenerationBasis(repositoryId: string): { generation: number; commit: string } | undefined {
    const row = this.db.prepare("SELECT g.id generation,g.commit_sha FROM repositories r JOIN generations g ON g.id=r.active_generation WHERE r.id=? AND g.state='ready'").get(repositoryId) as Row | undefined;
    return row ? { generation: Number(row.generation), commit: String(row.commit_sha) } : undefined;
  }

  activePackages(): ComposerPackage[] {
    return (this.db.prepare("SELECT p.* FROM packages p JOIN repositories r ON r.id=p.repository_id AND r.active_generation=p.generation_id").all() as Row[]).map((row) => ({ generation: Number(row.generation_id), repositoryId: String(row.repository_id), rootPath: String(row.root_path), name: String(row.name), ...(row.version ? { version: String(row.version) } : {}), ...(row.source_commit ? { sourceCommit: String(row.source_commit) } : {}), ...(row.repository_path ? { repositoryPath: String(row.repository_path) } : {}), ...(row.repository_url ? { repositoryUrl: String(row.repository_url) } : {}), ...(row.normalized_repository_url ? { normalizedRepositoryUrl: String(row.normalized_repository_url) } : {}), branchAliases: JSON.parse(String(row.branch_aliases_json ?? "{}")), autoload: JSON.parse(String(row.autoload_json)) }));
  }

  activeDependencies(): ComposerDependency[] {
    return (this.db.prepare("SELECT d.* FROM dependencies d JOIN repositories r ON r.id=d.repository_id AND r.active_generation=d.generation_id").all() as Row[]).map((row) => ({ generation: Number(row.generation_id), repositoryId: String(row.repository_id), packageName: String(row.package_name), development: Boolean(row.development), direct: Boolean(row.direct), ...(row.declared_constraint ? { declaredConstraint: String(row.declared_constraint) } : {}), ...(row.declared_constraint_base ? { declaredConstraintBase: String(row.declared_constraint_base) } : {}), ...(row.declared_alias ? { declaredAlias: String(row.declared_alias) } : {}), ...(row.resolved_version ? { resolvedVersion: String(row.resolved_version) } : {}), ...(row.resolved_source_reference ? { resolvedSourceReference: String(row.resolved_source_reference) } : {}), ...(row.resolved_source_url ? { resolvedSourceUrl: String(row.resolved_source_url) } : {}), ...(row.normalized_source_url ? { normalizedSourceUrl: String(row.normalized_source_url) } : {}), ...(row.resolved_dist_reference ? { resolvedDistReference: String(row.resolved_dist_reference) } : {}), ...(row.resolved_dist_url ? { resolvedDistUrl: String(row.resolved_dist_url) } : {}), ...(row.resolved_path ? { resolvedPath: String(row.resolved_path) } : {}), ...(row.resolved_source_commit ? { resolvedSourceCommit: String(row.resolved_source_commit) } : {}), ...(row.indexed_repository_id ? { indexedRepositoryId: String(row.indexed_repository_id) } : {}), ...(row.indexed_revision ? { indexedRevision: String(row.indexed_revision) } : {}), resolutionMethod: (row.resolution_method ?? "unresolved") as NonNullable<ComposerDependency["resolutionMethod"]>, resolutionEvidence: JSON.parse(String(row.resolution_evidence_json ?? "[]")), repositoryCandidates: JSON.parse(String(row.repository_candidates_json ?? "[]")), resolution: row.resolution as ComposerDependency["resolution"] }));
  }

  packageMappings(): Array<{ packageName: string; repositoryId: string; packageRoot: string }> {
    return (this.db.prepare("SELECT * FROM package_mappings ORDER BY package_name").all() as Row[]).map((row) => ({ packageName: String(row.package_name), repositoryId: String(row.repository_id), packageRoot: String(row.package_root) }));
  }

  setPackageMapping(packageName: string, repositoryId: string, packageRoot = ""): void {
    this.db.prepare("INSERT INTO package_mappings(package_name,repository_id,package_root,updated_at) VALUES(?,?,?,?) ON CONFLICT(package_name) DO UPDATE SET repository_id=excluded.repository_id,package_root=excluded.package_root,updated_at=excluded.updated_at")
      .run(packageName, repositoryId, packageRoot, new Date().toISOString());
  }

  removePackageMapping(packageName: string): boolean { return Number(this.db.prepare("DELETE FROM package_mappings WHERE package_name=?").run(packageName).changes) > 0; }

  generations(): Row[] { return this.db.prepare("SELECT * FROM generations ORDER BY id DESC").all() as Row[]; }

  saveHistory(repositoryId: string, event: HistoryEvent): void {
    this.db.prepare("INSERT OR REPLACE INTO history_events(id,repository_id,symbol_id,commit_sha,event_json) VALUES(?,?,?,?,?)").run(event.id, repositoryId, event.symbolId, event.commit, JSON.stringify(event));
  }

  replaceHistory(repositoryId: string, symbolId: string, events: HistoryEvent[]): void {
    const insert = this.db.prepare("INSERT INTO history_events(id,repository_id,symbol_id,commit_sha,event_json) VALUES(?,?,?,?,?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM history_events WHERE repository_id=? AND symbol_id=?").run(repositoryId, symbolId);
      for (const event of events) insert.run(event.id, repositoryId, event.symbolId, event.commit, JSON.stringify(event));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  history(symbolId: string): HistoryEvent[] {
    return (this.db.prepare("SELECT event_json FROM history_events WHERE symbol_id=? ORDER BY json_extract(event_json,'$.authoredAt')").all(symbolId) as Row[]).map((row) => JSON.parse(String(row.event_json)) as HistoryEvent);
  }
}
