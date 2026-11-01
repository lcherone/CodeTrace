# Security model

Trace treats repositories, Git hosting responses, and webview messages as untrusted input.

## Local transport

- The companion binds to a loopback interface by default.
- Requests require a matching protocol version. The minimal status probe is public; repository, index, graph, source and mutation routes require a local bearer token.
- Tokens are sent in headers, never URLs, and are not written to logs.
- Browser origins are restricted; mutation endpoints reject cross-origin requests.
- Request bodies and webview messages are schema-validated and size-bounded.
- Port conflicts fail clearly instead of silently binding to a public interface.

The extension webview receives query results, not GitHub credentials. Its content security policy permits only bundled local resources; scripts and styles are external assets, opened links are allow-listed, messages are validated in both directions, and repository text is inserted as text rather than HTML.

## Credentials

GitHub credentials belong to the companion. They can be read from `TRACE_GITHUB_TOKEN` for the process or written by its authenticated credential endpoint to an owner-only companion state file. Configuration examples contain no secret fields. The companion's local client token is also an owner-only file, while the extension copy is stored in VS Code SecretStorage. Tokens are never embedded in clone URLs shown to users.

Use the narrowest GitHub permissions that can read the explicitly configured repositories. Rotate a token if companion state or process output is suspected to be exposed.

GitHub pull-request/release association is optional and failure-isolated. With no token, Trace returns a limitation instead of attempting the lookup. With a token but no normalized GitHub repository identity, it likewise skips the lookup rather than sending an inferred name. API errors, rate limits and bounded results are returned as sanitized association limitations; one failed lookup does not remove successful local Git inclusion or another successful association. Evidence and API responses must never include the token. Repository URLs are sanitized before persistence and display by removing user information, query strings and fragments.

## Repository isolation

- User working trees are never reset, cleaned, checked out, stashed or modified for a query.
- Historical files are read from Git objects and presented in virtual read-only documents.
- Remote repositories use a companion-owned cache separate from working repositories.
- Git operations use argument arrays and validated refs/paths, not shell interpolation.
- Indexing reads source and metadata; it does not execute Composer scripts, project build scripts, autoloaders or repository code.
- Composer repository declarations and lock URLs are untrusted metadata. They are sanitized for display and used only as identity candidates; Trace does not contact arbitrary Composer/VCS URLs merely because a repository declares them.
- Archive extraction and file traversal enforce repository boundaries and ignore dependencies/generated bundles unless explicitly configured.

## State and removal

SQLite, remote caches and the local client token live in the companion state directory, not inside indexed repositories. Repository removal deletes only companion-owned index/cache records after resolving the exact target. It never deletes a configured local repository. Back up or remove the state directory using normal OS controls when required.

## Performance diagnostics

The scanner benchmark is local and read-only. Its machine-readable output suppresses the supplied root, repository/package names, paths, file names, symbols, source, content hashes, revisions, usernames and raw errors. It emits only aggregate counts, size/error buckets and timing distributions, and makes no network request. Store benchmark output under a private temporary directory such as `/tmp`; aggregate results can still reveal the approximate size and shape of a private codebase.

The CodeLens benchmark sends caller-supplied workloads only to an explicit loopback HTTP companion and reads its bearer token from a file. The workload is sensitive because it contains exact repository IDs, revisions, paths and possibly symbols; keep it under a private temporary directory and do not commit it. Reports suppress those fields, the companion URL, token, source and raw errors, retaining only anonymized counts, cache/cancellation outcomes and latency distributions. Aggregate item, partial-result and timing values can still reveal the approximate shape and performance of a private index.

## Scope limitations

Trace is a local development aid, not a hardened multi-user server. Do not expose its port through a public tunnel or bind it to a non-loopback address. Static analysis can display malicious-looking repository strings as inert text but cannot establish that indexed application code is safe.
