#!/usr/bin/env node
// facebook-ads-library-mcp: Meta / Facebook ads library tools over the hosted Spytrend MCP server, source pinned to Meta.
import { readFile } from "node:fs/promises";
import { adapterConfig } from "./src/adapter-config.js";
import { startAdapter } from "./src/adapter.js";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
startAdapter({ name: "facebook-ads-library-mcp", version: pkg.version, config: adapterConfig });
