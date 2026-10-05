# Changelog

All notable changes to this adapter are recorded here. Versions follow
[Semantic Versioning](https://semver.org/) and match the `version` field in `package.json`.

## [1.0.1] — 2026-10-05

- Tool results and errors no longer carry server-internal names: errors and parameter notes use this
  adapter's tool and parameter names, the hosted server's next-tool hint is not passed on, and fields
  the hosted server keeps for its own use are left out of every result row.

## [1.0.0] — 2026-10-05

Initial release: scenario adapter for the hosted Spytrend MCP server (Meta-only tool names, source pinned to Meta, 8 tools).
