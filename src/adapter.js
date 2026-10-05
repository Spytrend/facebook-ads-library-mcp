import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_ENDPOINT = "https://mcp.spytrend.com/mcp";

const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

// The adapter publishes only its own tools: the hosted server's prompts and
// resources describe the full server and are not passed through.
const EMPTY_LISTS = {
  "prompts/list": { prompts: [] },
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] }
};
const NOT_PROVIDED = new Set([
  "prompts/get",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "completion/complete"
]);
// Both answer with the server's identity, capabilities and instructions.
const IDENTITY_METHODS = new Set(["initialize", "server/discover"]);
const DROPPED_NOTIFICATIONS = new Set([
  "notifications/prompts/list_changed",
  "notifications/resources/list_changed",
  "notifications/resources/updated"
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every(isBlank);
  return false;
}

// "https://Shop.Example.com:443/path?q=1" -> "shop.example.com"
export function normalizeDomain(value) {
  if (Array.isArray(value)) return value.map(normalizeDomain);
  if (typeof value !== "string") return value;
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/, 1)[0];
  host = host.slice(host.lastIndexOf("@") + 1);
  return host.replace(/:\d+$/, "").replace(/\.+$/, "");
}

const NORMALIZERS = { domain: normalizeDomain };

function specFor(config, localName) {
  return typeof localName === "string" && Object.hasOwn(config.tools, localName)
    ? config.tools[localName]
    : undefined;
}

function rejection(message, text) {
  if (message.id === undefined) return { message: null };
  return {
    message: null,
    error: { jsonrpc: "2.0", id: message.id, error: { code: INVALID_PARAMS, message: text } }
  };
}

export function localToolNames(config) {
  return Object.keys(config.tools);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPattern(word, flags = "") {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, flags);
}

// Server parameter descriptions name server tools and server vocabulary. Rewrite them
// into this adapter's names and drop sentences that point at tools it does not expose.
export function createDescriptionRewriter(remoteTools, config) {
  const exposed = new Map();
  for (const [localName, spec] of Object.entries(config.tools)) {
    if (!exposed.has(spec.remoteName)) exposed.set(spec.remoteName, localName);
  }
  const replacements = [...exposed].map(([remote, local]) => [wordPattern(remote, "g"), local]);
  for (const spec of Object.values(config.tools)) {
    for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
      replacements.push([wordPattern(remote, "g"), local]);
    }
  }
  for (const [term, replacement] of config.vocabulary ?? []) {
    replacements.push([new RegExp(escapeRegExp(term), "g"), replacement]);
  }
  const hidden = remoteTools.map((tool) => tool.name).filter((name) => !exposed.has(name));
  const forbidden = [
    ...hidden.map((name) => wordPattern(name)),
    ...(config.dropTerms ?? []).map((term) => new RegExp(term, "i"))
  ];

  // Sentences are judged on the server's own wording, before any renaming, so a hidden
  // tool whose name contains a renamed word is still recognised.
  return function rewrite(text) {
    return text
      .split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s+/)
      .filter((sentence) => !forbidden.some((pattern) => pattern.test(sentence)))
      .map((sentence) => replacements.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), sentence))
      .join(" ")
      .trim();
  };
}

function rewriteDescriptions(node, rewrite) {
  if (Array.isArray(node)) {
    node.forEach((item) => rewriteDescriptions(item, rewrite));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") {
      const text = rewrite(value);
      if (text) node.description = text;
      else delete node.description;
    } else {
      rewriteDescriptions(value, rewrite);
    }
  }
}

// Parameters a call may not carry: unsupported by the server for this adapter's source, so a
// call that sets them is refused instead of silently running a wider (paid) search.
function isUnsupported(spec, property, config) {
  if ((spec.removeProperties ?? []).includes(property)) return false;
  if ((spec.rejectProperties ?? []).includes(property)) return true;
  if ((config?.rejectProperties ?? []).includes(property)) return true;
  return spec.allowProperties !== undefined && !spec.allowProperties.includes(property);
}

// The hosted server maps a parameter's singular/plural spelling onto its schema
// ("countries" -> "country", "pixel_ids" -> "pixel_id"). Same rule as the server's.
export function keyVariants(key) {
  const out = [];
  if (key.endsWith("ies") && key.length > 3) out.push(key.slice(0, -3) + "y");
  else if (key.endsWith("s") && key.length > 1) out.push(key.slice(0, -1));
  if (key.endsWith("y") && key.length > 1) out.push(key.slice(0, -1) + "ies");
  out.push(key + "s");
  return out;
}

// A call parameter is refused when the server would read it as a hidden one, under any of
// its spellings. A tool with an allow-list takes only its listed parameters, their spellings
// and the server's aliases of them. Accepted keys go to the server as sent: it maps them.
function isRefused(spec, key, config) {
  if ((spec.removeProperties ?? []).includes(key)) return false;
  const spellings = [key, ...keyVariants(key)];
  if (spec.allowProperties !== undefined) {
    const alias = spec.aliases && Object.hasOwn(spec.aliases, key) ? [spec.aliases[key]] : [];
    return ![...spellings, ...alias].some((name) => spec.allowProperties.includes(name));
  }
  const rejected = [...(spec.rejectProperties ?? []), ...(config?.rejectProperties ?? [])];
  return spellings.some((name) => rejected.includes(name));
}

// This adapter's own parameter names become the server's, spelling for spelling
// (tiktok_advertiser_ids -> webmaster_ids), so the server's own mapping still applies.
function remoteKey(spec, key) {
  for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
    if (key === local) return remote;
    const localSpellings = keyVariants(local);
    const remoteSpellings = keyVariants(remote);
    const index = localSpellings.indexOf(key);
    if (index >= 0 && localSpellings.length === remoteSpellings.length) return remoteSpellings[index];
  }
  return key;
}

function localSchema(remoteSchema, spec, rewrite, config) {
  const schema = clone(remoteSchema) ?? { type: "object", properties: {} };
  schema.properties ??= {};
  for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
    if (!Object.hasOwn(schema.properties, remote)) continue;
    schema.properties[local] = schema.properties[remote];
    delete schema.properties[remote];
    schema.required = (schema.required ?? []).map((property) => (property === remote ? local : property));
  }
  const hidden = Object.keys(schema.properties).filter(
    (property) => (spec.removeProperties ?? []).includes(property) || isUnsupported(spec, property, config)
  );
  for (const property of hidden) delete schema.properties[property];
  const required = (schema.required ?? []).filter((property) => !hidden.includes(property));
  for (const [property, values] of Object.entries(spec.enums ?? {})) {
    const target = schema.properties[property];
    if (!target) continue;
    if (target.items?.enum) target.items.enum = [...values];
    else target.enum = [...values];
  }
  rewriteDescriptions(schema, rewrite);
  for (const [property, description] of Object.entries(spec.properties ?? {})) {
    if (schema.properties[property]) schema.properties[property].description = description;
  }
  for (const property of spec.requireProperties ?? []) {
    if (!required.includes(property)) required.push(property);
  }
  if (required.length > 0) schema.required = required;
  else delete schema.required;
  return schema;
}

export function buildLocalToolList(remoteTools, config, onMissing = () => {}) {
  const rewrite = createDescriptionRewriter(remoteTools, config);
  return localToolNames(config).flatMap((localName) => {
    const spec = config.tools[localName];
    const remote = remoteTools.find((tool) => tool.name === spec.remoteName);
    if (!remote) {
      onMissing(localName, spec.remoteName);
      return [];
    }

    const tool = clone(remote);
    tool.name = localName;
    tool.title = spec.title;
    tool.description = spec.description;
    if (tool.annotations) tool.annotations = { ...tool.annotations, title: spec.title };
    // The server's output schema describes the full server: its field notes point at tools
    // this adapter does not expose. structuredContent still arrives with every result.
    delete tool.outputSchema;
    tool.inputSchema = localSchema(remote.inputSchema, spec, rewrite, config);
    return [tool];
  });
}

export function localInitializeResult(result, { name, version, config }) {
  const capabilities = { ...(result?.capabilities ?? {}) };
  delete capabilities.prompts;
  delete capabilities.resources;
  delete capabilities.completions;
  const serverInfo = { name, title: config.title, version };
  const local = { ...result, capabilities, serverInfo, instructions: config.instructions };
  // server/discover carries the identity in _meta as well.
  if (local._meta && typeof local._meta === "object") {
    local._meta = { ...local._meta };
    for (const key of Object.keys(local._meta)) if (key.endsWith("/serverInfo")) local._meta[key] = serverInfo;
  }
  return local;
}

function localReply(message, payload) {
  if (message.id === undefined) return { message: null };
  return { message: null, reply: { jsonrpc: "2.0", id: message.id, ...payload } };
}

export function transformClientMessage(message, config) {
  const method = message?.method;
  if (Object.hasOwn(EMPTY_LISTS, method)) return localReply(message, { result: EMPTY_LISTS[method] });
  if (NOT_PROVIDED.has(method)) {
    return localReply(message, { error: { code: METHOD_NOT_FOUND, message: `This adapter does not provide ${method}.` } });
  }
  if (method !== "tools/call") return { message };

  const localName = message.params?.name;
  const spec = specFor(config, localName);
  if (!spec) {
    return rejection(
      message,
      `Unknown tool: ${String(localName)}. This adapter provides: ${localToolNames(config).join(", ")}.`
    );
  }

  const args = { ...(message.params.arguments ?? {}) };
  const unsupported = Object.keys(args).filter((property) => isRefused(spec, property, config) && !isBlank(args[property]));
  if (unsupported.length > 0) {
    return rejection(message, `${localName} does not support: ${unsupported.join(", ")}. Use only the parameters in its schema.`);
  }
  for (const property of Object.keys(args)) {
    if ((spec.removeProperties ?? []).includes(property) || isRefused(spec, property, config)) delete args[property];
  }
  for (const [property, kind] of Object.entries(spec.normalize ?? {})) {
    if (args[property] !== undefined) args[property] = NORMALIZERS[kind](args[property]);
  }
  const missing = (spec.requireProperties ?? []).filter((property) => isBlank(args[property]));
  if (missing.length > 0) {
    return rejection(message, spec.missingMessage ?? `${localName} requires: ${missing.join(", ")}.`);
  }
  for (const key of Object.keys(args)) {
    const target = remoteKey(spec, key);
    if (target === key) continue;
    if (!Object.hasOwn(args, target)) args[target] = args[key];
    delete args[key];
  }
  Object.assign(args, spec.inject);

  return {
    message: {
      ...message,
      params: { ...message.params, name: spec.remoteName, arguments: args }
    }
  };
}

// Some server answers are too large for MCP clients to read back. A tool may drop fields
// and cap lists in its result; the text block carries the same JSON as structuredContent.
function shrinkData(data, trim) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const out = { ...data };
  for (const field of trim.drop ?? []) delete out[field];
  for (const [field, limit] of Object.entries(trim.limit ?? {})) {
    if (Array.isArray(out[field]) && out[field].length > limit) out[field] = out[field].slice(0, limit);
  }
  return out;
}

export function transformToolResult(result, spec) {
  const trim = spec?.trimResult;
  if (!trim || result === null || typeof result !== "object") return result;
  const shrink = (payload) =>
    payload !== null && typeof payload === "object" && !Array.isArray(payload) && "data" in payload
      ? { ...payload, data: shrinkData(payload.data, trim) }
      : payload;
  const content = Array.isArray(result.content)
    ? result.content.map((block) => {
        if (block?.type !== "text" || typeof block.text !== "string") return block;
        try {
          const parsed = JSON.parse(block.text);
          return parsed !== null && typeof parsed === "object" && "data" in parsed
            ? { ...block, text: JSON.stringify(shrink(parsed)) }
            : block;
        } catch {
          return block;
        }
      })
    : result.content;
  const trimmed = { ...result, content };
  if ("structuredContent" in result) trimmed.structuredContent = shrink(result.structuredContent);
  return trimmed;
}

export function transformServerMessage(message, config, onMissing) {
  if (!Array.isArray(message?.result?.tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: buildLocalToolList(message.result.tools, config, onMissing)
    }
  };
}

function idKey(id) {
  return `${typeof id}:${id}`;
}

function readJsonLines(stream, label, onMessage, log) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`Ignoring invalid JSON-RPC from ${label}.`);
      return;
    }
    onMessage(message);
  });
  return lines;
}

// A source stays paused while any destination it wrote to is full.
function createWriter() {
  const blockedBy = new Map();
  return function writeJsonLine(destination, message, source) {
    if (destination.write(JSON.stringify(message) + "\n")) return;
    let waiting = blockedBy.get(source);
    if (!waiting) blockedBy.set(source, (waiting = new Set()));
    if (waiting.has(destination)) return;
    waiting.add(destination);
    source.pause();
    destination.once("drain", () => {
      waiting.delete(destination);
      if (waiting.size === 0) source.resume();
    });
  };
}

function isMessage(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Pipes JSON-RPC lines between the MCP client and the hosted server bridge,
// rewriting tools/list responses and tools/call requests on the way.
export function createBridge({ config, client, upstream, identity, log = (text) => console.error(text) }) {
  const writeJsonLine = createWriter();
  const pendingLists = new Set();
  const pendingInits = new Set();
  const pendingCalls = new Map();
  const reported = new Set();
  const onMissing = (localName, remoteName) => {
    if (reported.has(localName)) return;
    reported.add(localName);
    log(`The hosted server did not list ${remoteName}; ${localName} is unavailable.`);
  };

  const clientLines = readJsonLines(client.input, "the MCP client", (message) => {
    if (!isMessage(message)) {
      const text = Array.isArray(message) ? "Batch requests are not supported." : "Invalid JSON-RPC message.";
      writeJsonLine(client.output, { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: text } }, clientLines);
      return;
    }
    const transformed = transformClientMessage(message, config);
    if (transformed.error) writeJsonLine(client.output, transformed.error, clientLines);
    if (transformed.reply) writeJsonLine(client.output, transformed.reply, clientLines);
    if (!transformed.message) return;
    if (message.id !== undefined && message.method === "tools/list") pendingLists.add(idKey(message.id));
    if (message.id !== undefined && IDENTITY_METHODS.has(message.method)) pendingInits.add(idKey(message.id));
    if (message.id !== undefined && message.method === "tools/call") {
      const spec = specFor(config, message.params?.name);
      if (spec?.trimResult) pendingCalls.set(idKey(message.id), spec);
    }
    writeJsonLine(upstream.input, transformed.message, clientLines);
  }, log);

  const upstreamLines = readJsonLines(upstream.output, "the hosted server", (message) => {
    if (isMessage(message) && DROPPED_NOTIFICATIONS.has(message.method)) return;
    // Only a response answers our request: server requests may reuse the same id.
    const isResponse = isMessage(message) && message.method === undefined && message.id !== undefined;
    if (isResponse && pendingLists.delete(idKey(message.id))) {
      message = transformServerMessage(message, config, onMissing);
    } else if (isResponse && pendingInits.delete(idKey(message.id)) && message.result) {
      message = { ...message, result: localInitializeResult(message.result, { ...identity, config }) };
    } else if (isResponse && pendingCalls.has(idKey(message.id))) {
      const spec = pendingCalls.get(idKey(message.id));
      pendingCalls.delete(idKey(message.id));
      if (message.result) message = { ...message, result: transformToolResult(message.result, spec) };
    }
    writeJsonLine(client.output, message, upstreamLines);
  }, log);
}

function remoteProxyPath() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("mcp-remote/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["mcp-remote"];
  return join(dirname(manifestPath), bin);
}

function usage(name) {
  return [
    `${name} — stdio MCP adapter for the hosted Spytrend MCP server.`,
    "",
    `Usage: npx -y github:Spytrend/${name} [--list-tools | --version | --help]`,
    "",
    "Without flags it speaks MCP over stdio and signs in through the browser on first use.",
    `SPYTREND_MCP_URL overrides the server address (default ${DEFAULT_ENDPOINT}).`
  ].join("\n");
}

export function startAdapter({ name, version, config, argv = process.argv.slice(2) }) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage(name) + "\n");
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(version + "\n");
    return;
  }
  if (argv.includes("--list-tools")) {
    const tools = localToolNames(config).map((tool) => ({
      name: tool,
      title: config.tools[tool].title,
      description: config.tools[tool].description
    }));
    process.stdout.write(JSON.stringify({ name, version, source: config.source ?? null, tools }, null, 2) + "\n");
    return;
  }

  const endpoint = process.env.SPYTREND_MCP_URL ?? DEFAULT_ENDPOINT;
  const child = spawn(process.execPath, [remoteProxyPath(), endpoint], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env
  });
  child.stdin.on("error", () => {});
  createBridge({
    config,
    identity: { name, version },
    client: { input: process.stdin, output: process.stdout },
    upstream: { input: child.stdin, output: child.stdout }
  });

  process.stdin.on("end", () => child.stdin.end());
  process.stdout.on("error", () => child.kill());
  const childRunning = () => child.exitCode === null && child.signalCode === null;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => (childRunning() ? child.kill(signal) : process.exit(1)));
  }
  child.on("error", (error) => {
    console.error(`Could not start the connection to ${endpoint}: ${error.message}`);
    process.exit(1);
  });
  // "close" comes after the child's output is fully read; flush ours before leaving.
  child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    process.stdout.write("", () => process.exit());
  });
}
