import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_ENDPOINT = "https://mcp.spytrend.com/mcp";

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
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

// Server and client JSON is a few levels deep. A walker refuses anything nested deeper than this,
// and the bridge answers with a short refusal instead of crashing or passing it on unread.
const MAX_DEPTH = 100;

function deeper(depth) {
  if (depth >= MAX_DEPTH) throw new RangeError("The message is nested too deeply to read.");
  return depth + 1;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isBlank(value, depth = 0) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every((item) => isBlank(item, deeper(depth)));
  return false;
}

// "https://Shop.Example.com:443/path?q=1" -> "shop.example.com"
export function normalizeDomain(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => normalizeDomain(item, deeper(depth)));
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

// Links, hosts and e-mail addresses inside text are quoted as they are: words are replaced
// only around them.
const LINK_IN_TEXT =
  /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|[^\s@()<>"']+@[^\s@()<>"']+\.[a-z]{2,}|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/\S*)?/gi;

function outsideLinks(text, replace) {
  let out = "";
  let last = 0;
  for (const link of text.matchAll(LINK_IN_TEXT)) {
    out += replace(text.slice(last, link.index)) + link[0];
    last = link.index + link[0].length;
  }
  return out + replace(text.slice(last));
}

// The replacement in the letter case of the word it replaces: WEBMASTER, Webmaster, webmaster.
function matchCase(word, replacement) {
  const lower = replacement.toLowerCase();
  if (word.length > 1 && word === word.toUpperCase()) return replacement.toUpperCase();
  if (word[0] !== word[0].toLowerCase()) return lower[0].toUpperCase() + lower.slice(1);
  return lower;
}

// Server parameter descriptions name server tools and server vocabulary. Rewrite them
// into this adapter's names and drop sentences that point at tools it does not expose.
export function createDescriptionRewriter(remoteTools, config, extraForbidden = []) {
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
    replacements.push([new RegExp(escapeRegExp(term), "gi"), (word) => matchCase(word, replacement)]);
  }
  const hidden = remoteTools.map((tool) => tool.name).filter((name) => !exposed.has(name));
  const forbidden = [
    ...hidden.map((name) => wordPattern(name)),
    ...(config.dropTerms ?? []).map((term) => new RegExp(term, "i")),
    ...extraForbidden
  ];

  // Sentences are judged on the server's own wording, before any renaming, so a hidden
  // tool whose name contains a renamed word is still recognised.
  return function rewrite(text) {
    return text
      .split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s+/)
      .filter((sentence) => !forbidden.some((pattern) => pattern.test(sentence)))
      .map((sentence) =>
        outsideLinks(sentence, (part) => replacements.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), part))
      )
      .join(" ")
      .trim();
  };
}

function rewriteDescriptions(node, rewrite, depth = 0) {
  if (Array.isArray(node)) {
    node.forEach((item) => rewriteDescriptions(item, rewrite, deeper(depth)));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") {
      const text = rewrite(value);
      if (text) node.description = text;
      else delete node.description;
    } else {
      rewriteDescriptions(value, rewrite, deeper(depth));
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
// and cap lists in its result, in a single object or in every row of a list.
function shrinkData(data, trim, depth = 0) {
  if (Array.isArray(data)) return data.map((row) => shrinkData(row, trim, deeper(depth)));
  if (data === null || typeof data !== "object") return data;
  const out = { ...data };
  for (const field of trim.drop ?? []) delete out[field];
  for (const [field, limit] of Object.entries(trim.limit ?? {})) {
    if (Array.isArray(out[field]) && out[field].length > limit) out[field] = out[field].slice(0, limit);
  }
  return out;
}

// The server's hint at its next tool names server tools; the adapter's instructions carry the flow.
const NEXT_STEP_META = "spytrend/next_step";
// The parameter an error is about, under the server's name (also in structuredContent.error.param).
const ERROR_PARAM_META = "spytrend/param";
// Result keys about tracking pixels, IP addresses or the server's own advertiser entities: internal.
// Keys are compared in NFKC form and lower case, so a lookalike spelling is caught too.
const INTERNAL_KEY = /pixel|webmaster|resolved_ip/;
// Server text that may not reach the user as is.
const INTERNAL_TEXT = /webmaster|pixel_id|resolved_ip/i;
// What an advertiser published (copy, names, brands, sponsors, payers, domains) is quoted as is,
// never reworded; so are links, domains and e-mail addresses.
const CONTENT_FIELD =
  /(?:^|_)(?:title|body|text|name|names|label|caption|description|call_to_action|brand|brands|vendor|handle|sponsor|sponsors|payer|beneficiary|organization|organisation|company|companies|owner|domain|domains)$/;
const LINK_LIKE = /^\S*[./@]\S*$/;
// Correlation ids (a notification's requestId or progressToken, any id or token) pass as they are.
const CORRELATION_KEY = /^(?:id|requestId|progressToken|token)$/;
// A JSON document inside a string value is cleaned like the result around it, up to this size.
const NESTED_JSON_LIMIT = 64 * 1024;
// What an error says when every sentence of the server's text named something internal.
const UNAVAILABLE_TEXT = "This parameter or option is not available in this adapter.";
// What a result says when it is nested too deeply to be read and cleaned.
const UNREADABLE_TEXT = "The hosted server's answer is nested too deeply for this adapter to pass on; its structured part was left out.";

// The server's word for advertiser entities, in this product's word, keeping its letter case.
function localWords(text) {
  if (!/webmaster/i.test(text)) return text;
  return outsideLinks(text, (part) =>
    part.replace(/\b([Aa]) (?=webmaster)/gi, "$1n ").replace(/webmaster/gi, (word) => matchCase(word, "advertiser"))
  );
}

// Server text inside a result (an error, a parameter note, a log line) is renamed like the
// parameter notes in tools/list. Sentences are dropped only where they name a server tool or
// parameter this adapter does not offer, or an internal lookup: plan and pricing notes stay.
// When nothing is left, the original is kept unless it names something internal.
export function createResultRewriter(remoteTools, config) {
  const specs = Object.values(config.tools);
  const refused = [...(config.rejectProperties ?? []), ...specs.flatMap((spec) => spec.rejectProperties ?? [])];
  const dropTerms = [...new Set(refused.flatMap((name) => [name, ...keyVariants(name)]))].map(
    (name) => `(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`
  );
  // A server name built on its own advertiser word is dropped unless this adapter renames it.
  const renamed = new Set(
    specs
      .flatMap((spec) => [spec.remoteName, ...Object.values(spec.renameProperties ?? {})])
      .flatMap((name) => [name, ...keyVariants(name)])
  );
  const serverName = {
    test: (sentence) =>
      (sentence.match(/[A-Za-z0-9_]*webmaster[A-Za-z0-9_]*/gi) ?? []).some(
        (token) => token.includes("_") && !renamed.has(token.toLowerCase())
      )
  };
  const rewrite = createDescriptionRewriter(remoteTools, { ...config, dropTerms }, [serverName, /pixel_id|resolved_ip/i]);
  return (text) => {
    const kept = rewrite(text) || (INTERNAL_TEXT.test(text) ? UNAVAILABLE_TEXT : text);
    return localWords(kept).replace(/\b([Aa]) (?=advertiser)/g, "$1n ");
  };
}

// The reverse of remoteKey: a server parameter name back in this adapter's spelling.
function localKey(spec, key) {
  for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
    if (key === remote) return local;
    const remoteSpellings = keyVariants(remote);
    const localSpellings = keyVariants(local);
    const index = remoteSpellings.indexOf(key);
    if (index >= 0 && remoteSpellings.length === localSpellings.length) return localSpellings[index];
  }
  return key;
}

// The server echoes the parameters that shaped a result under its own names. They go back into
// this adapter's names; the ones the adapter sets by itself (source) were not the caller's.
function localParams(params, spec, rewrite) {
  const own = new Set([...Object.keys(spec.inject ?? {}), ...(spec.removeProperties ?? [])]);
  const out = { ...params };
  if (Array.isArray(out.applied)) {
    out.applied = out.applied.filter((name) => !own.has(name)).map((name) => localKey(spec, name));
  }
  for (const list of ["normalized", "ignored"]) {
    if (!Array.isArray(out[list])) continue;
    out[list] = out[list]
      .filter((note) => !(isMessage(note) && (own.has(note.param) || own.has(note.to))))
      .map((note) => {
        if (!isMessage(note)) return note;
        const local = { ...note };
        for (const field of ["param", "to"]) if (typeof local[field] === "string") local[field] = localKey(spec, local[field]);
        if (typeof local.reason === "string") local.reason = rewrite(local.reason);
        return local;
      });
  }
  return out;
}

function localError(error, spec, rewrite) {
  const out = { ...error };
  if (typeof out.message === "string") out.message = rewrite(out.message);
  if (typeof out.param === "string") out.param = localKey(spec, out.param);
  return out;
}

// Fields a tool drops (exact names, or with a * wildcard), rows it drops by a field value, and
// the internal keys every tool drops unless it keeps them by name. Applied at every depth.
// Text values are cleaned by words: server text of an error or a notification by the rewriter.
function resultRules(spec, words = localWords) {
  const patterns = (spec.dropFields ?? []).map((field) => new RegExp(`^${field.split("*").map(escapeRegExp).join(".*")}$`));
  const keep = new Set(spec.keepFields ?? []);
  const rows = Object.entries(spec.dropRows ?? {});
  return {
    dropsField: (key) =>
      patterns.some((pattern) => pattern.test(key)) || (INTERNAL_KEY.test(key.normalize("NFKC").toLowerCase()) && !keep.has(key)),
    dropsRow: (row) => isMessage(row) && rows.some(([field, values]) => values.includes(row[field])),
    words
  };
}

function cleanValue(value, field, rules, depth = 0) {
  if (field !== undefined && CORRELATION_KEY.test(field)) return value;
  if (Array.isArray(value)) {
    return value.filter((row) => !rules.dropsRow(row)).map((row) => cleanValue(row, field, rules, deeper(depth)));
  }
  if (isMessage(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (!rules.dropsField(key)) out[key] = cleanValue(item, key, rules, deeper(depth));
    return out;
  }
  if (typeof value !== "string" || CONTENT_FIELD.test(field ?? "")) return value;
  if (value.length <= NESTED_JSON_LIMIT && /^\s*[[{]/.test(value)) {
    const nested = parseJson(value);
    if (nested !== null && typeof nested === "object") {
      const cleaned = JSON.stringify(cleanValue(nested, field, rules, deeper(depth)));
      return cleaned === JSON.stringify(nested) ? value : cleaned;
    }
  }
  return LINK_LIKE.test(value) ? value : rules.words(value);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// structuredContent, and the same JSON in a text block.
function localPayload(payload, spec, rewrite, rules) {
  if (!isMessage(payload)) return cleanValue(payload, undefined, rules);
  const out = { ...payload };
  if (spec.trimResult && "data" in out) out.data = shrinkData(out.data, spec.trimResult);
  if (isMessage(out.params)) out.params = localParams(out.params, spec, rewrite);
  if (isMessage(out.error)) out.error = localError(out.error, spec, rewrite);
  return cleanValue(out, undefined, rules);
}

// _meta of a result, a content block or its resource: without the next-tool hint, the error parameter in
// this adapter's name, internal keys dropped. Undefined when nothing is left.
function localMeta(meta, spec, rules) {
  const out = { ...meta };
  delete out[NEXT_STEP_META];
  if (typeof out[ERROR_PARAM_META] === "string") out[ERROR_PARAM_META] = localKey(spec, out[ERROR_PARAM_META]);
  const cleaned = cleanValue(out, undefined, rules);
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// A text block or a text resource: JSON (an object or a list) is cleaned like structuredContent,
// plain text is server text (in an error, rewritten like structuredContent.error).
function localText(text, spec, rewrite, rules) {
  const parsed = /^\s*[[{]/.test(text) ? parseJson(text) : undefined;
  if (parsed !== null && typeof parsed === "object") {
    const payload = localPayload(parsed, spec, rewrite, rules);
    return JSON.stringify(payload) === JSON.stringify(parsed) ? text : JSON.stringify(payload);
  }
  return rules.words(text);
}

function withMeta(node, spec, rules) {
  if (!isMessage(node._meta)) return node;
  const local = { ...node, _meta: localMeta(node._meta, spec, rules) };
  if (local._meta === undefined) delete local._meta;
  return local;
}

// Image and audio data and resource blobs pass as they are.
function localBlock(block, spec, rewrite, rules) {
  if (!isMessage(block)) return block;
  let local = block;
  if (block.type === "text" && typeof block.text === "string") {
    const text = localText(block.text, spec, rewrite, rules);
    if (text !== block.text) local = { ...local, text };
  }
  if (block.type === "resource" && isMessage(block.resource)) {
    let resource = withMeta(block.resource, spec, rules);
    if (typeof resource.text === "string") {
      const text = localText(resource.text, spec, rewrite, rules);
      if (text !== resource.text) resource = { ...resource, text };
    }
    if (resource !== block.resource) local = { ...local, resource };
  }
  return withMeta(local, spec, rules);
}

// A result too deeply nested to walk: a note, then only its plain-text blocks, rewritten.
function unreadableResult(result, rewrite) {
  const blocks = (Array.isArray(result.content) ? result.content : []).filter(
    (block) => block?.type === "text" && typeof block.text === "string" && !/^\s*[[{]/.test(block.text)
  );
  return { isError: true, content: [UNREADABLE_TEXT, ...blocks.map((block) => rewrite(block.text))].map((text) => ({ type: "text", text })) };
}

// A tool result in this adapter's names: errors and parameter notes renamed, the server's
// next-tool hint removed, the configured and internal fields dropped, every list row included.
export function transformToolResult(result, spec, { rewrite = localWords } = {}) {
  if (result === null || typeof result !== "object" || !spec) return result;
  try {
    const rules = resultRules(spec, result.isError === true ? rewrite : localWords);
    const local = { ...result };
    if (Array.isArray(result.content)) local.content = result.content.map((block) => localBlock(block, spec, rewrite, rules));
    if ("structuredContent" in result) local.structuredContent = localPayload(result.structuredContent, spec, rewrite, rules);
    if (isMessage(result._meta)) {
      local._meta = localMeta(result._meta, spec, rules);
      if (local._meta === undefined) delete local._meta;
    }
    return local;
  } catch {
    return unreadableResult(result, rewrite);
  }
}

// A JSON-RPC error answering a tool call: the server's text in this adapter's names.
function transformCallError(error, spec, rewrite) {
  if (!isMessage(error)) return error;
  const out = { ...error };
  if (typeof out.message === "string") out.message = rewrite(out.message);
  if ("data" in out) {
    try {
      out.data = cleanValue(out.data, undefined, resultRules(spec));
    } catch {
      delete out.data;
    }
  }
  return out;
}

// Server notifications (log lines, progress, cancellations) carry server text as well. A JSON
// document in a text field is cleaned as JSON first: public names stay, internal keys go.
function transformNotification(message, rewrite) {
  if (!isMessage(message.params)) return message;
  return { ...message, params: cleanValue(message.params, undefined, resultRules({}, rewrite)) };
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

// A source stays paused while any destination it wrote to is full. A message that cannot be
// serialized (nested too deeply) is not written, and the writer says so.
function createWriter(log) {
  const blockedBy = new Map();
  return function writeJsonLine(destination, message, source) {
    let line;
    try {
      line = JSON.stringify(message) + "\n";
    } catch {
      log("A message could not be serialized and was not passed on.");
      return false;
    }
    if (destination.write(line)) return true;
    let waiting = blockedBy.get(source);
    if (!waiting) blockedBy.set(source, (waiting = new Set()));
    if (waiting.has(destination)) return true;
    waiting.add(destination);
    source.pause();
    destination.once("drain", () => {
      waiting.delete(destination);
      if (waiting.size === 0) source.resume();
    });
    return true;
  };
}

function errorReply(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const UNREADABLE_CALL = "This call could not be read: its arguments are nested too deeply.";
const UNREADABLE_ANSWER = "The hosted server's answer could not be read safely.";

function isMessage(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Pipes JSON-RPC lines between the MCP client and the hosted server bridge,
// rewriting tools/list responses and tools/call requests on the way.
export function createBridge({ config, client, upstream, identity, log = (text) => console.error(text) }) {
  const writeJsonLine = createWriter(log);
  const pendingLists = new Set();
  const pendingInits = new Set();
  const pendingCalls = new Map();
  // Server tool names known from the last tools/list: results rename them too.
  let rewriteResult = createResultRewriter([], config);
  const reported = new Set();
  // The log names only this adapter's tools: it is user-visible in client logs.
  const onMissing = (localName) => {
    if (reported.has(localName)) return;
    reported.add(localName);
    log(`${localName} is unavailable: the hosted server did not list it.`);
  };

  const clientLines = readJsonLines(client.input, "the MCP client", (message) => {
    if (!isMessage(message)) {
      const text = Array.isArray(message) ? "Batch requests are not supported." : "Invalid JSON-RPC message.";
      writeJsonLine(client.output, { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: text } }, clientLines);
      return;
    }
    let transformed;
    try {
      transformed = transformClientMessage(message, config);
    } catch {
      transformed = { message: null };
    }
    if (transformed.error) writeJsonLine(client.output, transformed.error, clientLines);
    if (transformed.reply) writeJsonLine(client.output, transformed.reply, clientLines);
    const forwarded = transformed.message && writeJsonLine(upstream.input, transformed.message, clientLines);
    if (!forwarded) {
      const refused = transformed.error || transformed.reply;
      if (!refused && message.id !== undefined) writeJsonLine(client.output, errorReply(message.id, INVALID_PARAMS, UNREADABLE_CALL), clientLines);
      return;
    }
    if (message.id !== undefined && message.method === "tools/list") pendingLists.add(idKey(message.id));
    if (message.id !== undefined && IDENTITY_METHODS.has(message.method)) pendingInits.add(idKey(message.id));
    if (message.id !== undefined && message.method === "tools/call") {
      const spec = specFor(config, message.params?.name);
      if (spec) pendingCalls.set(idKey(message.id), spec);
    }
  }, log);

  // Only a response answers our request: server requests may reuse the same id.
  const localServerMessage = (message, isResponse) => {
    if (isResponse && pendingLists.delete(idKey(message.id))) {
      if (Array.isArray(message.result?.tools)) rewriteResult = createResultRewriter(message.result.tools, config);
      return transformServerMessage(message, config, onMissing);
    }
    if (isResponse && pendingInits.delete(idKey(message.id)) && message.result) {
      return { ...message, result: localInitializeResult(message.result, { ...identity, config }) };
    }
    if (isResponse && pendingCalls.has(idKey(message.id))) {
      const spec = pendingCalls.get(idKey(message.id));
      pendingCalls.delete(idKey(message.id));
      if (message.result) return { ...message, result: transformToolResult(message.result, spec, { rewrite: rewriteResult }) };
      if (message.error) return { ...message, error: transformCallError(message.error, spec, rewriteResult) };
      return message;
    }
    if (isMessage(message) && typeof message.method === "string" && message.id === undefined) {
      return transformNotification(message, rewriteResult);
    }
    return message;
  };

  const upstreamLines = readJsonLines(upstream.output, "the hosted server", (message) => {
    if (isMessage(message) && DROPPED_NOTIFICATIONS.has(message.method)) return;
    const isResponse = isMessage(message) && message.method === undefined && message.id !== undefined;
    let local;
    try {
      local = localServerMessage(message, isResponse);
    } catch {
      log("A message from the hosted server could not be read safely and was not passed on.");
      local = isResponse ? errorReply(message.id, INTERNAL_ERROR, UNREADABLE_ANSWER) : null;
    }
    if (local && !writeJsonLine(client.output, local, upstreamLines) && isResponse) {
      writeJsonLine(client.output, errorReply(message.id, INTERNAL_ERROR, UNREADABLE_ANSWER), upstreamLines);
    }
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
