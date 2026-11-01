# Large-workspace scanning, queues and privacy

Trace must make repository discovery cheap enough to run automatically without turning access to a GitHub organisation or a large filesystem into permission to index everything. This document separates the production indexing contract from the standalone load harness.

## Discovery boundary

An eligible repository is either explicitly configured or resolved from a Composer package observed in an eligible repository's `composer.json`, `composer.lock` or installed-package metadata. GitHub discovery only produces candidates. It does not enqueue every accessible repository.

The scanner benchmark defaults to `auto` discovery:

1. inventory files tracked by the workspace root Git repository;
2. include the root Composer manifest and lock file even when ignored by that Git repository;
3. read `vendor/composer/installed.json`, falling back to locked package names when installed metadata is unavailable;
4. inventory only those installed package roots, using package-local Git metadata when present and a bounded package-local filesystem walk otherwise;
5. apply the same PHP/Composer include scope and dependency/generated-directory exclusions used by the indexer.

Installed roots are canonicalized and must remain under the supplied workspace root; an external path-repository symlink is outside this benchmark scope. The harness does not crawl sibling directories, home directories, GitHub organisations or arbitrary filesystem roots looking for repositories.

An anonymized read-only corpus demonstrated why the Composer fallback matters: its root Git inventory represented only a small fraction of the PHP/Composer inputs reachable through installed-package metadata and nested package worktrees. No corpus-specific count, path, repository, package, symbol or source identity is retained in this project.

## Automatic queued scanning

Automatic scanning is enabled unless `TRACE_AUTO_SCAN=0`. Configured repositories are queued at companion startup and when added. Filesystem watchers are enabled unless `TRACE_WATCH=0`; relevant PHP, Composer and Git index/HEAD changes are debounced before a follow-up scan.

Composer discovery reads the configured repository's lock file and installed-package metadata. A package is eligible only when it is both locked and installed, its installed `composer.json` confirms the same package name, and its canonical path is available. Packages sharing one owning Git checkout are grouped into one repository job; installed archives use revision-qualified filesystem inventory. This is intentionally different from enumerating every directory beneath `vendor` or every repository visible to GitHub credentials.

All work enters one bounded in-process repository queue:

- queued duplicates coalesce; manual duplicates against an active scan coalesce, while a filesystem change can leave one follow-up scan queued;
- repository-job concurrency and global file-analysis concurrency are separate limits;
- automatic discovery waits for queue capacity; an authenticated manual request receives HTTP 429 when the queue is full;
- queued or active jobs can be cancelled through `POST /v1/index/cancel`, and file-analysis slots observe the abort signal;
- job stages, queue position, cache hits/misses, analyzed files, filesystem fallback, duration and throughput are exposed by `GET /v1/jobs`;
- unchanged inventories reuse the published generation without rewriting symbols or relationships; analyzer/index format versions participate in the fingerprint so analyzer upgrades still re-index safely;
- job snapshots are persisted for diagnosis; jobs interrupted by companion shutdown are marked failed at next startup rather than silently resumed;
- a new generation is published only after discovery, analysis and relationship resolution complete, so cancellation or failure leaves the previous generation active;
- superseded generations are removed after atomic publication, file cache history and per-repository job history are bounded, and the active graph snapshot is reused until a generation changes;
- unsupported PHP syntax is isolated to the affected file and counted as an analysis failure instead of failing an otherwise usable package generation;
- history remains lazy and is analyzed when requested.

`POST /v1/repositories/refresh` returns HTTP 202 with a job ID and whether the request coalesced. Acceptance is not completion; verify `/v1/jobs` and the repository's published generation.

## Anonymized scanner load harness

The harness measures inventory, bounded streaming reads and content hashing. It does not parse PHP, write an index, execute repository code, call GitHub, or measure graph-query/database publication time.

Run it with output under a private temporary directory:

```sh
npm run benchmark:scanner -w @trace/fixtures -- \
  --root /absolute/path/to/workspace \
  --source auto \
  --concurrency 1,2,4 \
  --warmup 1 \
  --iterations 5 \
  > /tmp/trace-scanner-benchmark.json
```

`--source git-tracked` isolates root Git inventory. `--source composer-installed` isolates the Composer-driven fallback. Repeat `--include` or `--exclude` to replace the defaults. `--max-file-bytes` defaults to 64 MiB and is a harness safety limit, not a companion setting.

The JSON report contains only:

- aggregate discovery, selected/readable file and byte counts;
- PHP/Composer category and size-bucket counts;
- skipped/error categories without raw messages;
- concurrency, sample counts, duration distributions and aggregate throughput.

It deliberately omits the supplied root, repository/package names, paths, file names, symbols, source, content hashes, Git revisions, usernames and raw errors. The process reads source locally, retains only per-file byte counts while running, and emits no network traffic.

## CodeLens query harness

The independent CodeLens harness exercises the authenticated loopback `POST /v1/lenses/counts` boundary. A workload contains one or more exact active repository/commit bases and batches of 1–200 relative-path items. Each item has an opaque request ID, source range and optional logical symbol. The companion returns caller and exact-package-consumer counts separately; ambiguous, unavailable or revision-mismatched consumers are excluded and make the item partial.

Keep workloads under a private temporary directory because they necessarily contain repository IDs, revisions, paths and sometimes symbols. A minimal shape is:

```json
{
  "requests": [
    {
      "repository": {
        "repositoryId": "fictional-repository",
        "commit": "0000000000000000000000000000000000000000"
      },
      "items": [
        {
          "id": "opaque-1",
          "path": "src/Example.php",
          "range": {
            "startLine": 10,
            "startColumn": 4,
            "endLine": 10,
            "endColumn": 11
          },
          "symbol": "Example\\Service::run"
        }
      ]
    }
  ]
}
```

Run the benchmark only against a running loopback companion:

```sh
npm run --silent benchmark:codelens -w @trace/fixtures -- \
  --base-url http://127.0.0.1:47173 \
  --token-file "$HOME/.trace/client-token" \
  --workload /tmp/trace-codelens-workload.json \
  --iterations 20 \
  --warmup 1 \
  --cancellation-attempts 3 \
  --cancel-after-ms 1 \
  > /tmp/trace-codelens-benchmark.json
```

The harness accepts HTTP loopback URLs only, reads the bearer token from a file, and never includes the URL, token, request content or raw server error in its report. Output contains only aggregate request/item counts, actual cache hit/miss/rebuild totals, cold/warm/mixed latency distributions, returned/partial item totals, cancellation outcomes, sanitized error categories and acceptance assessments. It classifies a sample as cold or warm from response cache evidence, not request position. Expected cancellation is reported separately from query errors; a request that completes before the timer is not cancellation proof.

The default batch gates are:

| Gate | Threshold | Reason |
| --- | ---: | --- |
| Cold p95 | ≤ 5,000 ms | Bounds one generation-wide snapshot build on the synthetic high-scale corpus. |
| Warm p95 | ≤ 20 ms | Keeps a cached 200-item batch comfortably below normal editor interaction latency. |
| Observed cancellation p95 | ≤ 100 ms | Bounds client/server abort response while distinguishing completion-before-abort. |

`--enforce-thresholds` exits with status 2 unless all three gates are both observed and passing. A fixture-sized backend may complete before a 1 ms abort; report cancellation as **not observed**, then use a larger synthetic or authorized indexed corpus rather than calling it passed. Override thresholds only for an explicitly documented experiment, not to turn a failed baseline green.

### Cache and cancellation boundary

CodeLens cache identity includes all active generation IDs plus package mappings. A generation publication or mapping change rebuilds the snapshot and clears item values. Responses repeat the requested repository generation/commit, so callers can reject stale results. Snapshot loading yields between bounded database pages and the item loop yields every 25 items. Disconnecting the request aborts remaining work; it does not publish a new repository generation.

Cold and warm evidence are process-local. Restarting the companion, publishing any active generation or changing mappings invalidates the cache. OS filesystem cache warmth is a separate layer and is not controlled by this harness.

The VS Code provider adds a separate document-scoped layer: enabled by `trace.codeLens.enabled`, saved local PHP files only, no additional delay by default, one batch per document, 120 symbols by default and a hard cap of 200. VS Code already coalesces provider requests, while `trace.codeLens.delayMs` remains available for noisy hosts. Its cache key includes document version, repository ID/commit and response generation. Editing cancels the request and removes stale lenses; saving does not restore them until the repository's refreshed generation is ready. Only non-zero caller/consumer counts render, and partial counts are labelled rather than silently appearing complete.

### Recorded synthetic high-scale profile

On 2026-11-01, the same local machine ran the synthetic comparison with 200,000 symbols, 600,000 call relationships and the maximum 200 CodeLens items. The fixed gates were cold batch ≤ 5,000 ms, warm p95 batch ≤ 20 ms and observed cancellation ≤ 100 ms.

| Measurement | Before snapshot optimization | Updated backend | Updated gate |
| --- | ---: | ---: | --- |
| Legacy 200-lens batch | 52,868.59 ms | 49,659.53 ms | Comparison only |
| Legacy p95 per lens | 394.92 ms | 322.72 ms | Comparison only |
| Cached cold 200-item batch | 5,920.29 ms | 3,457.05 ms | **Passed** |
| Cached warm p95 batch | 15.17 ms | 6.32 ms | **Passed** |
| Cancellation | 0.42 ms | 0.39 ms | **Passed** |
| Same-process peak RSS | 2,044.3 MiB | 2,606.3 MiB | Observed, no pass gate |

The initial cold result failed the unchanged five-second gate; the updated run passed without relaxing it. The legacy path could not observe mid-batch cancellation, while the cached path did. Timings and RSS are host-specific and should be used as a regression baseline on comparable hardware, not a universal capacity promise. Peak RSS is intentionally reported without a pass threshold because the process simultaneously holds the generated corpus, SQLite state, legacy comparison structures and the cached count snapshot; it is not the incremental production cache cost.

Separate focused backend repeats measured cached cold at 2.03–2.55 seconds, warm p95 at 0.70 ms, cancellation at 0.37–0.52 ms and a cache-only RSS increase of 85.8 MiB. Those isolated figures explain the cache cost more directly; the independent whole-process run above remains the reproducible end-to-end regression record.

## Operational tuning

Tune with representative local measurements rather than assuming more concurrency is faster:

1. Start with file concurrency 2. Compare median and p95 results at 1, 2 and 4 workers.
2. Prefer the lowest concurrency within roughly 10% of the best median throughput; it leaves capacity for the editor, Git and SQLite.
3. Narrow repository include rules to owned PHP and Composer roots. Exclude generated code, caches, exports, logs, dependencies not selected through Composer, and large artifacts.
4. Keep repository-job concurrency lower than file-read concurrency. Network clone/fetch, parsing and SQLite publication have different bottlenecks.
5. Leave history lazy for large repositories. A trace request can queue the relevant symbol history instead of scanning every commit eagerly.
6. Investigate large p95 variance, read errors, oversize skips or a high filesystem-package count before increasing workers.
7. Re-run after changing storage, include/exclude rules or cache state. Warm-cache throughput is not first-index latency.
8. Keep CodeLens batches bounded at 200 and distinguish direct callers from exact Composer consumers; they answer different questions and have different partial-data boundaries.

The companion exposes these runtime controls:

| Environment variable | Default | Effect |
| --- | ---: | --- |
| `TRACE_AUTO_SCAN` | enabled | Set to `0` to disable startup/add automatic scans. |
| `TRACE_WATCH` | enabled | Set to `0` to disable filesystem-triggered scans; manual refresh remains available. |
| `TRACE_REPOSITORY_CONCURRENCY` | `2` | Maximum repository scans running together. |
| `TRACE_ANALYSIS_CONCURRENCY` | `8` | Global concurrent PHP file-analysis slots across all repositories. |
| `TRACE_MAX_QUEUE` | `512` | Maximum queued repository jobs before backpressure. |

All numeric values must be positive integers. For a laptop, start with the defaults; reduce repository concurrency first when Git/storage contention affects the editor, then reduce analysis concurrency when parsing saturates CPU or memory. Increasing `TRACE_MAX_QUEUE` changes backlog capacity, not throughput.

Do not compare results from different machines or filesystems as if they were equivalent. The harness is most useful for relative tuning on the same corpus and host. It is scanner-boundary evidence only; use companion job/generation timings for end-to-end indexing evidence.

## Verification checklist

- Run the harness twice and confirm the output contains no supplied path or known repository/package/symbol string.
- Confirm `selectedFiles` matches the intended PHP/Composer scope and review all skip/error aggregate counts.
- Compare `auto` with `git-tracked`; a material difference should be explained by Composer-installed package roots.
- Verify the companion separately: queue state, cancellation, failure recovery, cache reuse and atomic generation publication are not proved by this harness.
- For CodeLens, confirm cold/warm classification agrees with returned cache counters, the response basis equals the requested active revision, and a completed-before-abort attempt is not counted as cancellation.
- Search both workload-derived output and stderr for a known repository ID, path, symbol and commit. The aggregate report must contain none of them; keep the workload itself private.
