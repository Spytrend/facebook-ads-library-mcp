import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adapterConfig } from "../src/adapter-config.js";
import { buildLocalToolList, createBridge, transformClientMessage, transformToolResult } from "../src/adapter.js";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

const REPO = "facebook-ads-library-mcp";
const SOURCE = "meta";
const EXPECTED_TOOLS = {
  search_facebook_ads: "search_ads",
  get_facebook_ad: "get_ad",
  search_facebook_advertisers: "search_advertisers",
  get_facebook_advertiser: "get_advertiser",
  get_facebook_ads_analytics: "get_ads_analytics",
  find_similar_facebook_ads: "find_similar_ads",
  get_facebook_ad_media: "get_media",
  get_usage: "get_usage"
};
const PINNED = ["search_facebook_ads", "get_facebook_ad"];
const SAMPLE_ARGS = { query: "collagen gummies", countries: ["DE"] };

// Server tools as the hosted server lists them, reduced to the fields the adapter touches,
// plus two tools this adapter must not expose. Server titles and parameter notes name
// server tools and server pages; the adapter publishes its own.
// Hidden server tools also include names built from the server vocabulary this adapter
// rewrites, so the rewrite must not hide them from the check.
const HIDDEN_SERVER_TOOLS = [
  "search_creatives",
  "get_trends",
  ...new Set((adapterConfig.vocabulary ?? []).map(([term]) => `find_similar_${term.toLowerCase()}`))
];
const SPEC_OF_REMOTE = Object.fromEntries(Object.values(adapterConfig.tools).map((spec) => [spec.remoteName, spec]));
const RENAMED = Object.values(adapterConfig.tools).flatMap((spec) => Object.values(spec.renameProperties ?? {}));
const INTERNAL_LOOKUPS = adapterConfig.rejectProperties ?? [];
const isUnsupported = (spec, property) =>
  !(spec.removeProperties ?? []).includes(property) &&
  ((spec.rejectProperties ?? []).includes(property) ||
    INTERNAL_LOOKUPS.includes(property) ||
    (spec.allowProperties !== undefined && !spec.allowProperties.includes(property)));
const SERVER_TOOLS = [...new Set([...Object.values(EXPECTED_TOOLS), ...HIDDEN_SERVER_TOOLS])]
  .map((name) => {
    const spec = SPEC_OF_REMOTE[name] ?? {};
    const serverOnly = [
      ...(spec.removeProperties ?? []),
      ...(spec.rejectProperties ?? []),
      ...Object.values(spec.renameProperties ?? {})
    ];
    const enums = Object.entries(spec.enums ?? {}).map(([property, values]) => [
      property,
      { type: "string", enum: [...values, "server_only_value"] }
    ]);
    return {
      name,
      title: `Server title of ${name}`,
      description: `server description of ${name}`,
      annotations: { title: `Server title of ${name}`, readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["meta", "tiktok"] },
          query: { type: "string" },
          landing_domain: { type: "string" },
          id: { type: "string" },
          ref: {
            type: "string",
            description: `an id from ${name}. Mirrors the /ads page. See \`/ads\` for filters. See https://spytrend.com/ads. Match a pixel id here. Lookup by IP. ${HIDDEN_SERVER_TOOLS.map((hidden) => `Same as ${hidden} rows.`).join(" ")}`
          },
          shared: { $ref: "#/$defs/note" },
          ...Object.fromEntries(serverOnly.map((property) => [property, { type: "string", description: `server filter ${property}` }])),
          ...Object.fromEntries(enums),
          ...Object.fromEntries(INTERNAL_LOOKUPS.map((property) => [property, { type: "string", description: `server lookup ${property}` }]))
        },
        required: ["source"],
        description: `Root notes. See get_trends.`,
        $defs: { note: { type: "string", description: `kept text. Same as get_trends rows.` } }
      },
      outputSchema: { type: "object", properties: { data: { type: "array", description: "rows, see search_creatives" } } }
    };
  });

// Words that belong to the hosted server and must not reach the client: server tool names
// that differ from this adapter's, server-only parameter names and server vocabulary.
const SERVER_WORDS = [
  ...Object.values(EXPECTED_TOOLS).filter((remote) => !Object.hasOwn(EXPECTED_TOOLS, remote)),
  ...HIDDEN_SERVER_TOOLS,
  ...RENAMED
];
const SERVER_TERMS = (adapterConfig.vocabulary ?? []).map(([term]) => term.toLowerCase());
const IDENTITY = { name: REPO, version: "1.0.1" };

function assertNoServerWords(text, where) {
  for (const word of SERVER_WORDS) {
    assert.doesNotMatch(text, new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`), `${where}: ${word}`);
  }
  for (const term of SERVER_TERMS) assert.ok(!text.toLowerCase().includes(term), `${where}: ${term}`);
}

function call(name, args, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

test("the adapter declares exactly its tool set", () => {
  const declared = Object.fromEntries(
    Object.entries(adapterConfig.tools).map(([name, spec]) => [name, spec.remoteName])
  );
  assert.deepEqual(declared, EXPECTED_TOOLS);
  for (const spec of Object.values(adapterConfig.tools)) assert.ok(spec.description.length > 40);
});

test("tools/list exposes only the adapter tools, renamed, with adapter descriptions", () => {
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  assert.deepEqual(tools.map((tool) => tool.name), Object.keys(EXPECTED_TOOLS));
  for (const tool of tools) assert.equal(tool.description, adapterConfig.tools[tool.name].description);
});

test("the source parameter is hidden and no longer required in pinned tools", () => {
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  for (const tool of tools) {
    const pinned = PINNED.includes(tool.name);
    assert.equal("source" in tool.inputSchema.properties, !pinned, tool.name);
    assert.equal((tool.inputSchema.required ?? []).includes("source"), !pinned, tool.name);
  }
});

test(`pinned calls are renamed and always carry source=${SOURCE}`, () => {
  for (const name of PINNED) {
    const other = SOURCE === "meta" ? "tiktok" : "meta";
    const sample = Object.entries(SAMPLE_ARGS).filter(([property]) => !isUnsupported(adapterConfig.tools[name], property));
    const { message, error } = transformClientMessage(call(name, { ...Object.fromEntries(sample), source: other }), adapterConfig);
    assert.equal(error, undefined, name);
    assert.equal(message.params.name, EXPECTED_TOOLS[name]);
    assert.equal(message.params.arguments.source, SOURCE);
  }
});

test("other calls are renamed and keep their arguments as given", () => {
  for (const name of Object.keys(EXPECTED_TOOLS).filter((tool) => !PINNED.includes(tool))) {
    const { message } = transformClientMessage(call(name, { id: "abc" }), adapterConfig);
    assert.equal(message.params.name, EXPECTED_TOOLS[name]);
    assert.deepEqual(message.params.arguments, { id: "abc" });
  }
});

test("unknown tools are rejected and never reach the server", () => {
  for (const name of ["search_creatives", "get_trends", "toString", undefined]) {
    const { message, error } = transformClientMessage(call(name, {}, 9), adapterConfig);
    assert.equal(message, null);
    assert.equal(error.id, 9);
    assert.equal(error.error.code, -32602);
  }
  const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "get_trends" } };
  assert.deepEqual(transformClientMessage(notification, adapterConfig), { message: null });
});


test("the stdio bridge rewrites live traffic in both directions", async () => {
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toServer = lines(upstream.input);
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  client.input.write(JSON.stringify(initialize) + "\n");
  assert.deepEqual(await toServer.next(), initialize);

  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" }) + "\n");
  assert.equal((await toServer.next()).method, "tools/list");
  upstream.output.write(JSON.stringify({ jsonrpc: "2.0", id: "list", result: { tools: SERVER_TOOLS } }) + "\n");
  const listed = await toClient.next();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), Object.keys(EXPECTED_TOOLS));

  const first = PINNED[0];
  client.input.write(JSON.stringify(call(first, SAMPLE_ARGS, 2)) + "\n");
  const forwarded = await toServer.next();
  assert.equal(forwarded.params.name, EXPECTED_TOOLS[first]);
  assert.equal(forwarded.params.arguments.source, SOURCE);

  client.input.write(JSON.stringify(call("get_trends", {}, 3)) + "\n");
  assert.equal((await toClient.next()).error.code, -32602);

  // A server response that is not a tools/list answer passes through untouched.
  const result = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } };
  upstream.output.write(JSON.stringify(result) + "\n");
  assert.deepEqual(await toClient.next(), result);
});

test("a server request reusing a pending tools/list id does not unfilter the list", async () => {
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });

  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  const serverRequest = { jsonrpc: "2.0", id: 1, method: "roots/list" };
  upstream.output.write(JSON.stringify(serverRequest) + "\n");
  assert.deepEqual(await toClient.next(), serverRequest);
  upstream.output.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: SERVER_TOOLS } }) + "\n");
  assert.deepEqual((await toClient.next()).result.tools.map((tool) => tool.name), Object.keys(EXPECTED_TOOLS));
});

test("the client stays paused until every full destination has drained", async () => {
  const client = { input: new PassThrough(), output: new PassThrough({ highWaterMark: 1 }) };
  const upstream = { input: new PassThrough({ highWaterMark: 1 }), output: new PassThrough() };
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  // One chunk: a request for the server and a call the adapter refuses itself.
  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n" + JSON.stringify(call("get_trends", {}, 2)) + "\n");
  await tick();
  assert.equal(client.input.isPaused(), true);

  client.output.resume();
  await tick();
  assert.equal(client.input.isPaused(), true, "the server side is still full");

  upstream.input.resume();
  await tick();
  assert.equal(client.input.isPaused(), false);
});

test("non-object JSON from the client is refused without stopping the bridge", async () => {
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toServer = lines(upstream.input);
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });

  for (const line of ["null", "42", '"text"', "[]"]) {
    client.input.write(line + "\n");
    const reply = await toClient.next();
    assert.equal(reply.id, null);
    assert.equal(reply.error.code, -32600);
  }
  const ping = { jsonrpc: "2.0", id: 4, method: "ping" };
  client.input.write(JSON.stringify(ping) + "\n");
  assert.deepEqual(await toServer.next(), ping);
});

test("--list-tools and --version work without a network connection", async () => {
  const listed = JSON.parse((await run(process.execPath, ["index.js", "--list-tools"], { cwd: root })).stdout);
  assert.equal(listed.name, REPO);
  assert.equal(listed.source, SOURCE);
  assert.deepEqual(listed.tools.map((tool) => tool.name), Object.keys(EXPECTED_TOOLS));
  for (const tool of listed.tools) assert.equal(tool.title, adapterConfig.tools[tool.name].title);
  const version = (await run(process.execPath, ["index.js", "--version"], { cwd: root })).stdout.trim();
  assert.equal(version, "1.0.1");
});

test("the package installs as a command from GitHub", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.name, `@spytrend/${REPO}`);
  assert.equal(pkg.version, "1.0.1");
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { [REPO]: "./index.js" });
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.engines.node);
  assert.ok(pkg.homepage.includes(`utm_source=github-${REPO}&utm_medium=repo&utm_campaign=mcp-launch`));
  const index = await readFile(new URL("index.js", root), "utf8");
  assert.ok(index.startsWith("#!/usr/bin/env node\n"));
  const changelog = await readFile(new URL("CHANGELOG.md", root), "utf8");
  assert.match(changelog, /## \[1\.0\.1\] — 2026-10-05/);
  assert.match(changelog, /## \[1\.0\.0\] — 2026-10-05/);
  assert.match(await readFile(new URL("LICENSE", root), "utf8"), /Copyright \(c\) 2026 Spytrend/);
});

test("tool titles, annotation titles and parameter notes are the adapter's own", () => {
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  let rewritten = 0;
  for (const tool of tools) {
    const spec = adapterConfig.tools[tool.name];
    assert.ok(spec.title, tool.name);
    assert.equal(tool.title, spec.title);
    assert.deepEqual(tool.annotations, { title: spec.title, readOnlyHint: true });
    assert.equal(tool.outputSchema, undefined);
    // The server's own name becomes this adapter's; notes about server pages and
    // tools the adapter does not expose are dropped.
    if (tool.inputSchema.properties.ref) {
      assert.equal(tool.inputSchema.properties.ref.description, `an id from ${tool.name}.`);
      rewritten += 1;
    }
    assert.equal(tool.inputSchema.description, "Root notes.");
    assert.equal(tool.inputSchema.$defs.note.description, "kept text.");
    for (const [property, description] of Object.entries(spec.properties ?? {})) {
      if (tool.inputSchema.properties[property]) assert.equal(tool.inputSchema.properties[property].description, description);
    }
  }
  assert.ok(rewritten > 0);
  assertNoServerWords(JSON.stringify(tools), "tools/list");
});

test("server-only parameters are neither published nor forwarded under server names", () => {
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  for (const [localName, spec] of Object.entries(adapterConfig.tools)) {
    const properties = tools.find((tool) => tool.name === localName).inputSchema.properties;
    const remote = SERVER_TOOLS.find((tool) => tool.name === spec.remoteName).inputSchema.properties;
    for (const property of Object.keys(remote)) {
      const hidden = (spec.removeProperties ?? []).includes(property) || isUnsupported(spec, property);
      if (hidden) assert.ok(!(property in properties), `${localName}.${property}`);
    }
    const args = Object.fromEntries((spec.removeProperties ?? []).map((hidden) => [hidden, "x"]));
    for (const property of spec.requireProperties ?? []) args[property] = "example.com";
    for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
      assert.ok(local in properties, `${localName}.${local}`);
      assert.ok(!(remote in properties), `${localName}.${remote}`);
      args[local] = "abc";
    }
    const { message } = transformClientMessage(call(localName, args), adapterConfig);
    for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
      assert.equal(message.params.arguments[remote], "abc");
      assert.ok(!(local in message.params.arguments));
    }
    for (const hidden of spec.removeProperties ?? []) {
      assert.notEqual(message.params.arguments[hidden], "x", `${localName}.${hidden}`);
    }
    for (const [property, values] of Object.entries(spec.enums ?? {})) {
      if (properties[property]) assert.deepEqual(properties[property].enum, values, `${localName}.${property}`);
    }
  }
});

test("a call setting an unsupported filter is refused, not silently widened", () => {
  let checked = 0;
  for (const [localName, spec] of Object.entries(adapterConfig.tools)) {
    const remote = SERVER_TOOLS.find((tool) => tool.name === spec.remoteName).inputSchema.properties;
    const required = Object.fromEntries((spec.requireProperties ?? []).map((property) => [property, "example.com"]));
    for (const property of Object.keys(remote).filter((property) => isUnsupported(spec, property))) {
      const { message, error } = transformClientMessage(call(localName, { ...required, [property]: "x" }, 7), adapterConfig);
      assert.equal(message, null, `${localName}.${property}`);
      assert.equal(error.id, 7);
      assert.equal(error.error.code, -32602);
      assert.match(error.error.message, new RegExp(property));
      // An empty value is not a filter: it is dropped and the call goes through.
      const blank = transformClientMessage(call(localName, { ...required, [property]: "" }), adapterConfig);
      assert.ok(!(property in blank.message.params.arguments), `${localName}.${property}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});

test("initialize answers with the adapter's own identity, capabilities and instructions", async () => {
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toServer = lines(upstream.input);
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });

  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  assert.equal((await toServer.next()).method, "initialize");
  const serverResult = {
    protocolVersion: "2025-06-18",
    capabilities: { logging: {}, prompts: { listChanged: true }, resources: { listChanged: true }, tools: { listChanged: true } },
    serverInfo: { name: "server", title: "Server", version: "abc123" },
    instructions: `Server notes: ${SERVER_WORDS.join(", ")}.`
  };
  upstream.output.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: serverResult }) + "\n");
  const { result } = await toClient.next();

  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(result.serverInfo, { name: REPO, title: adapterConfig.title, version: "1.0.1" });
  assert.deepEqual(result.capabilities, { logging: {}, tools: { listChanged: true } });
  assert.equal(result.instructions, adapterConfig.instructions);
  assertNoServerWords(result.instructions, "instructions");

  // server/discover carries the same identity, capabilities and instructions.
  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover" }) + "\n");
  assert.equal((await toServer.next()).method, "server/discover");
  const metaKey = "io.modelcontextprotocol/serverInfo";
  upstream.output.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ...serverResult, _meta: { [metaKey]: serverResult.serverInfo } } }) + "\n");
  const discovered = (await toClient.next()).result;
  assert.deepEqual(discovered._meta[metaKey], result.serverInfo);
  assert.deepEqual(discovered.serverInfo, result.serverInfo);
  assert.deepEqual(discovered.capabilities, result.capabilities);
  assert.equal(discovered.instructions, adapterConfig.instructions);
  // Every tool or parameter the instructions name is one this adapter publishes.
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  const published = new Set([
    ...tools.flatMap((tool) => [tool.name, ...Object.keys(tool.inputSchema.properties)]),
    ...Object.values(adapterConfig.tools).flatMap((spec) => Object.keys(spec.properties ?? {}))
  ]);
  for (const name of result.instructions.replace(/https?:\/\/\S+/g, "").match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
    assert.ok(published.has(name), `instructions name ${name}`);
  }
});

test("prompts and resources are answered by the adapter: empty, never from the server", async () => {
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toServer = lines(upstream.input);
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });

  const lists = { "prompts/list": "prompts", "resources/list": "resources", "resources/templates/list": "resourceTemplates" };
  let id = 1;
  for (const [method, key] of Object.entries(lists)) {
    client.input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method }) + "\n");
    assert.deepEqual(await toClient.next(), { jsonrpc: "2.0", id, result: { [key]: [] } });
  }
  for (const method of ["prompts/get", "resources/read", "resources/subscribe", "resources/unsubscribe", "completion/complete"]) {
    client.input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { name: "x", uri: "x" } }) + "\n");
    const reply = await toClient.next();
    assert.equal(reply.id, id);
    assert.equal(reply.error.code, -32601, method);
  }
  // None of these reached the server: the first thing it sees is the next request.
  const ping = { jsonrpc: "2.0", id: ++id, method: "ping" };
  client.input.write(JSON.stringify(ping) + "\n");
  assert.deepEqual(await toServer.next(), ping);

  // The server's own prompt and resource notifications are not passed on.
  for (const method of ["notifications/prompts/list_changed", "notifications/resources/list_changed", "notifications/resources/updated"]) {
    upstream.output.write(JSON.stringify({ jsonrpc: "2.0", method, params: { uri: "x" } }) + "\n");
  }
  const pong = { jsonrpc: "2.0", id, result: {} };
  upstream.output.write(JSON.stringify(pong) + "\n");
  assert.deepEqual(await toClient.next(), pong);
});

test("pixel and IP lookups are internal: never published, a call setting one is refused", () => {
  assert.deepEqual(INTERNAL_LOOKUPS, ["pixel_id", "resolved_ip"]);
  const tools = buildLocalToolList(SERVER_TOOLS, adapterConfig);
  assert.doesNotMatch(JSON.stringify(tools), /pixel|resolved_ip|\bIP\b/i);
  for (const [localName, spec] of Object.entries(adapterConfig.tools)) {
    const required = Object.fromEntries((spec.requireProperties ?? []).map((property) => [property, "example.com"]));
    for (const property of INTERNAL_LOOKUPS) {
      const { message, error } = transformClientMessage(call(localName, { ...required, [property]: "123" }, 5), adapterConfig);
      assert.equal(message, null, `${localName}.${property}`);
      assert.equal(error.error.code, -32602);
    }
  }
});

test("oversized results are trimmed for the tools that declare it", () => {
  for (const [localName, spec] of Object.entries(adapterConfig.tools)) {
    const trim = spec.trimResult;
    if (!trim) {
      const result = { content: [{ type: "text", text: '{"data":{"a":1}}' }], structuredContent: { data: { a: 1 } } };
      assert.deepEqual(transformToolResult(result, spec), result, localName);
      continue;
    }
    const data = { kept: 1 };
    for (const field of trim.drop ?? []) data[field] = "large";
    for (const [field, limit] of Object.entries(trim.limit ?? {})) data[field] = Array.from({ length: limit + 5 }, (_, i) => i);
    const payload = { data };
    const result = {
      content: [{ type: "text", text: JSON.stringify(payload) }, { type: "text", text: "Actual debit: 1 token." }],
      structuredContent: payload
    };
    const trimmed = transformToolResult(result, spec);
    for (const view of [trimmed.structuredContent, JSON.parse(trimmed.content[0].text)]) {
      assert.equal(view.data.kept, 1);
      for (const field of trim.drop ?? []) assert.ok(!(field in view.data), `${localName}.${field}`);
      for (const [field, limit] of Object.entries(trim.limit ?? {})) assert.deepEqual(view.data[field], [...Array(limit).keys()]);
    }
    assert.equal(trimmed.content[1].text, "Actual debit: 1 token.");
    // An error result without data passes through.
    const failure = { isError: true, content: [{ type: "text", text: "rejected" }] };
    assert.deepEqual(transformToolResult(failure, spec), failure);
  }
});

test("hidden filters are refused under every spelling the server would accept", () => {
  for (const [localName, spec] of Object.entries(adapterConfig.tools)) {
    const required = Object.fromEntries((spec.requireProperties ?? []).map((property) => [property, "example.com"]));
    const hidden = [...(spec.rejectProperties ?? []), ...INTERNAL_LOOKUPS];
    for (const property of hidden) {
      for (const spelling of [property, `${property}s`]) {
        const { message, error } = transformClientMessage(call(localName, { ...required, [spelling]: ["123"] }, 6), adapterConfig);
        assert.equal(message, null, `${localName}.${spelling}`);
        assert.equal(error.error.code, -32602);
      }
    }
    if (!spec.allowProperties) continue;
    // A spelling or a server alias of an allowed filter passes as sent: the server maps it
    // (and unwraps a one-item array for a string filter), also next to the canonical name.
    const allowed = spec.allowProperties.find((property) => !property.endsWith("s") && !(property in (spec.renameProperties ?? {})));
    const plural = transformClientMessage(call(localName, { ...required, [`${allowed}s`]: ["x"] }), adapterConfig);
    assert.deepEqual(plural.message.params.arguments[`${allowed}s`], ["x"], `${localName}.${allowed}s`);
    for (const [alias, target] of Object.entries(spec.aliases ?? {})) {
      const both = transformClientMessage(call(localName, { ...required, [alias]: ["x"], [target]: "y" }), adapterConfig);
      assert.deepEqual(both.message.params.arguments[alias], ["x"], `${localName}.${alias}`);
      assert.equal(both.message.params.arguments[target], "y", `${localName}.${target}`);
    }
    // A spelling of a renamed filter becomes the same spelling of the server's name.
    for (const [local, remote] of Object.entries(spec.renameProperties ?? {})) {
      const renamed = transformClientMessage(call(localName, { ...required, [`${local}s`]: ["abc"] }), adapterConfig);
      assert.deepEqual(renamed.message.params.arguments[`${remote}s`], ["abc"], `${localName}.${local}s`);
      assert.ok(!(`${local}s` in renamed.message.params.arguments));
    }
  }
});

// Tool results as the hosted server sends them: structuredContent mirrored as JSON into the text
// block, error text both in content and in structuredContent.error, hints and codes in _meta.
const answer = (structured, meta) => ({
  result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, _meta: meta }
});
const refusal = (message, { outcome, code, kind }) => ({
  result: {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, outcome, kind, retryable: false, message } },
    _meta: { "spytrend/outcome": outcome, "spytrend/error_code": code }
  }
});

// Server answers shaped like the hosted server's (field names and texts from its code) for each
// place where its internal naming reaches a result of this adapter's tools.
const AD_ROW = {
  id: "5f0c7c1e-4d0b-4a51-9a51-2b1f4f0f6a10",
  title: "Collagen gummies",
  landing_domain: "shop.example.com",
  advertiser_id: "104857600123",
  countries: ["DE", "AT"],
  days_active: 12,
  creative_id: "9a7e3d52-1c4b-4f7e-8d0e-6b5c2a1f0e33"
};
const SERVER_AD_ROW = {
  ...AD_ROW,
  webmaster_id: "3c1d9a0e-7b2f-4e8a-9c6d-5f4e3b2a1c0d",
  webmasters: [{ id: "3c1d9a0e-7b2f-4e8a-9c6d-5f4e3b2a1c0d", name: "shop.example.com", matched_by: "pixel" }]
};
const SECTION = { status: "ready", ready: true, denominator: 1200, available_count: 1, returned_count: 1, truncated: false };
const ADVERTISER_ROW = { dimension: "advertisers", key: "104857600123", label: "Glow Labs", count: 310 };
const ANALYTICS_REFUSAL =
  "get_ads_analytics requires a Pro-or-higher spytrend plan. Upgrade at https://spytrend.com/pricing; no analytics quota was charged.";
const RECORDED = [
  {
    tool: "search_facebook_ads",
    args: { query: "collagen gummies", colour: "red" },
    answer: answer(
      {
        data: [SERVER_AD_ROW],
        pagination: { limit: 10, has_more: false },
        params: {
          applied: ["query", "source"],
          normalized: [],
          ignored: [{ param: "colour", action: "ignored", reason: "unknown parameter for search_ads" }]
        }
      },
      { "spytrend/next_step": "Meta ads carry no media. Check opening_price, then use get_ad or get_media. For exact advertiser counts use get_advertiser." }
    ),
    expect: ({ result }) => {
      assert.deepEqual(result.structuredContent.data, [AD_ROW]);
      assert.deepEqual(result.structuredContent.params.applied, ["query"]);
      assert.equal(result.structuredContent.params.ignored[0].reason, "unknown parameter for search_facebook_ads");
      assert.equal(result._meta, undefined);
    }
  },
  {
    tool: "get_facebook_ad",
    args: { id: AD_ROW.id },
    answer: answer({ data: SERVER_AD_ROW }, { "spytrend/next_step": "find_similar_ads lists every ad re-using this creative. get_advertiser opens the advertiser behind it." }),
    expect: ({ result }) => assert.deepEqual(result.structuredContent, { data: AD_ROW })
  },
  {
    tool: "find_similar_facebook_ads",
    args: { ad_id: AD_ROW.id },
    answer: answer({ data: [SERVER_AD_ROW], params: { applied: ["ad_id"], normalized: [], ignored: [] } }),
    expect: ({ result }) => assert.deepEqual(result.structuredContent.data, [AD_ROW])
  },
  {
    tool: "get_facebook_ads_analytics",
    args: { query: "collagen gummies" },
    answer: answer({
      tier: "pro",
      total: 1200,
      total_status: "exact",
      advertisers: SECTION,
      webmasters: SECTION,
      data: [ADVERTISER_ROW, { dimension: "webmasters", key: "3c1d9a0e-7b2f-4e8a-9c6d-5f4e3b2a1c0d", label: "shop.example.com", count: 280 }],
      params: { applied: ["query"], normalized: [], ignored: [] }
    }),
    expect: ({ result }) => {
      assert.equal(result.structuredContent.total, 1200);
      assert.deepEqual(result.structuredContent.advertisers, SECTION);
      assert.deepEqual(result.structuredContent.data, [ADVERTISER_ROW]);
    }
  },
  {
    tool: "get_facebook_ads_analytics",
    args: { query: "collagen gummies" },
    answer: refusal(ANALYTICS_REFUSAL, { outcome: "forbidden", code: "plan_upgrade_required", kind: "permission_denied" }),
    expect: ({ result }) => assert.equal(result.content[0].text, ANALYTICS_REFUSAL.replace("get_ads_analytics", "get_facebook_ads_analytics"))
  }
];

// The hosted server calls its advertiser entities by a word this product does not use. It stays in code
// (server names the adapter must send) and never in anything a user, or the assistant, can read.
test("no server word «webmaster» in anything a user can read", async (t) => {
  const WORD = /webmaster/i;
  const checked = [];
  const check = (text, where) => {
    const value = typeof text === "string" ? text : JSON.stringify(text);
    const found = value.match(/.{0,50}webmaster.{0,50}/i);
    assert.ok(!WORD.test(value), `the server word «webmaster» reaches the user in ${where}: …${found?.[0]}…`);
    checked.push(where);
  };
  // Control: the check does see the word.
  assert.throws(() => check("Open a Webmaster card.", "control"), /server word «webmaster»/);
  checked.length = 0;

  // Package texts.
  for (const file of ["README.md", "CHANGELOG.md"]) check(await readFile(new URL(file, root), "utf8"), file);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  check(pkg.description, "package.json description");
  check(pkg.keywords ?? [], "package.json keywords");

  // Tool list as the client receives it, and the adapter's own titles and descriptions.
  check(buildLocalToolList(SERVER_TOOLS, adapterConfig), "tools/list");
  check(adapterConfig.title, "server title");
  check(adapterConfig.instructions, "adapter instructions");
  for (const [name, spec] of Object.entries(adapterConfig.tools)) {
    check([spec.title, spec.description, spec.properties ?? {}], `${name} title, description and parameter notes`);
  }
  check((await run(process.execPath, ["index.js", "--list-tools"], { cwd: root })).stdout, "--list-tools");
  check((await run(process.execPath, ["index.js", "--help"], { cwd: root })).stdout, "--help");

  // initialize: the server's own instructions never reach the client.
  const client = { input: new PassThrough(), output: new PassThrough() };
  const upstream = { input: new PassThrough(), output: new PassThrough() };
  const toServer = lines(upstream.input);
  const toClient = lines(client.output);
  createBridge({ config: adapterConfig, client, upstream, identity: IDENTITY, log: () => {} });
  client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  await toServer.next();
  upstream.output.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "server", title: "Webmaster server", version: "abc" },
      instructions: "Search webmasters, open a webmaster card."
    }
  }) + "\n");
  check((await toClient.next()).result, "initialize result");

  // Refusals and errors the adapter itself produces. A refusal repeats the caller's own
  // parameter and tool names, so none of these calls carries the word.
  const refusals = [];
  const refuse = (name, args) => {
    const { message, error } = transformClientMessage(call(name, args, 3), adapterConfig);
    assert.equal(message, null, `${name} ${JSON.stringify(args)}`);
    refusals.push(error.error.message);
  };
  refuse("search_creatives", {});
  for (const [name, spec] of Object.entries(adapterConfig.tools)) {
    const required = Object.fromEntries((spec.requireProperties ?? []).map((property) => [property, "example.com"]));
    const hidden = [...(spec.rejectProperties ?? []), ...INTERNAL_LOOKUPS].filter((property) => !WORD.test(property));
    for (const property of [...new Set(hidden)]) refuse(name, { ...required, [property]: "x" });
    if ((spec.requireProperties ?? []).length > 0) refuse(name, {});
  }
  const notProvided = transformClientMessage({ jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "x" } }, adapterConfig);
  refusals.push(notProvided.reply.error.message);
  assert.ok(refusals.length >= 4, "the refusal scan saw too little");
  check(refusals, "refusal and error messages");

  // Tool results: answers shaped like the hosted server's pass through the bridge. No server word,
  // pixel or IP name is left in content text, structuredContent or _meta, and errors stay errors.
  const callClient = { input: new PassThrough(), output: new PassThrough() };
  const callServer = { input: new PassThrough(), output: new PassThrough() };
  const toCallServer = lines(callServer.input);
  const toCallClient = lines(callClient.output);
  createBridge({ config: adapterConfig, client: callClient, upstream: callServer, identity: IDENTITY, log: () => {} });
  callClient.input.write(JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" }) + "\n");
  await toCallServer.next();
  callServer.output.write(JSON.stringify({ jsonrpc: "2.0", id: "list", result: { tools: SERVER_TOOLS } }) + "\n");
  await toCallClient.next();
  const assertClean = (value, where) => {
    const leaked = JSON.stringify(value).match(/.{0,50}(?:webmaster|pixel_id|resolved_ip).{0,50}/i);
    assert.ok(!leaked, `${where}: a server-internal name reaches the user: …${leaked?.[0]}…`);
  };
  let callId = 100;
  for (const recorded of RECORDED) {
    callClient.input.write(JSON.stringify(call(recorded.tool, recorded.args, ++callId)) + "\n");
    const forwarded = await toCallServer.next();
    callServer.output.write(JSON.stringify({ jsonrpc: "2.0", id: callId, ...recorded.answer }) + "\n");
    const reply = await toCallClient.next();
    const where = `${recorded.tool} ${JSON.stringify(recorded.args)}`;
    assertClean(reply, where);
    check(reply, `${where} result`);
    if (reply.error) {
      assert.equal(reply.error.code, recorded.answer.error.code, where);
      assert.match(reply.error.message, /[a-z]{3,} [a-z]{3,}/i, where);
    } else if (reply.result.isError) {
      assert.match(reply.result.content[0].text, /[a-z]{3,} [a-z]{3,}/i, where);
      assert.equal(reply.result.structuredContent.error.message, reply.result.content[0].text, where);
    } else if ("structuredContent" in reply.result) {
      // The text block still carries the same JSON as structuredContent.
      assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent, where);
    }
    recorded.expect(reply, forwarded.params.arguments);
  }

  // A server field no list names yet is dropped as well, unless the tool keeps it by name.
  for (const [name, spec] of Object.entries(adapterConfig.tools)) {
    const kept = Object.fromEntries((spec.keepFields ?? []).map((field) => [field, ["kept"]]));
    const row = { id: "r1", total_ads: 3, new_webmaster_score: 1, ads_with_pixel: 2, resolved_ip_country: "DE", ...kept };
    const { structuredContent } = transformToolResult({ structuredContent: { data: [row] } }, spec);
    assert.deepEqual(structuredContent.data, [{ id: "r1", total_ads: 3, ...kept }], name);
  }

  // Review findings, each checked on the same bridge.
  const UNAVAILABLE = "This parameter or option is not available in this adapter.";
  const askRaw = async (serverAnswer, tool = PINNED[0], args = SAMPLE_ARGS) => {
    callClient.input.write(JSON.stringify(call(tool, args, ++callId)) + "\n");
    await toCallServer.next();
    callServer.output.write(JSON.stringify({ jsonrpc: "2.0", id: callId, ...serverAnswer }) + "\n");
    const reply = await toCallClient.next();
    assert.equal(reply.id, callId);
    return reply;
  };
  const ask = async (serverAnswer, tool = PINNED[0], args = SAMPLE_ARGS) => {
    const reply = await askRaw(serverAnswer, tool, args);
    assertClean(reply, tool);
    return reply;
  };

  await t.test("an error whose every sentence names something internal becomes a neutral message", { timeout: 10000 }, async () => {
    const internal = "pixel_id must be numeric. Use resolved_ip only with countries.";
    const { result } = await ask(refusal(internal, { outcome: "arg_error", code: "invalid_arguments", kind: "invalid_argument" }));
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, UNAVAILABLE);
    assert.equal(result.structuredContent.error.message, UNAVAILABLE);
    const { error } = await ask({ error: { code: -32602, message: "find_similar_webmasters needs a webmaster id." } });
    assert.equal(error.code, -32602);
    assert.equal(error.message, UNAVAILABLE);
  });

  await t.test("a JSON list in a text block is cleaned like structuredContent", { timeout: 10000 }, async () => {
    const rows = [{ id: "r1", total_ads: 3, webmaster_id: "w1", webmasters: [{ id: "w1", matched_by: "pixel" }] }];
    const { result } = await ask({ result: { content: [{ type: "text", text: JSON.stringify(rows) }] } });
    assert.deepEqual(JSON.parse(result.content[0].text), [{ id: "r1", total_ads: 3 }]);
  });

  await t.test("JSON nested 5000 levels deep neither stops the bridge nor passes unread", { timeout: 10000 }, async () => {
    const deepList = "[".repeat(5000) + "]".repeat(5000);
    callClient.input.write(
      `{"jsonrpc":"2.0","id":${++callId},"method":"tools/call","params":{"name":"${PINNED[0]}","arguments":{"pixel_id":${deepList}}}}\n`
    );
    const refused = await toCallClient.next();
    assert.equal(refused.id, callId);
    assert.equal(refused.error.code, -32602);

    callClient.input.write(JSON.stringify(call(PINNED[0], SAMPLE_ARGS, ++callId)) + "\n");
    await toCallServer.next();
    const deepObject = '{"a":'.repeat(5000) + '"webmaster"' + "}".repeat(5000);
    const text = JSON.stringify("Found 1 webmaster ad.");
    callServer.output.write(
      `{"jsonrpc":"2.0","id":${callId},"result":{"content":[{"type":"text","text":${text}}],"structuredContent":{"data":${deepObject}}}}\n`
    );
    const unread = await toCallClient.next();
    assertClean(unread, "a deep answer");
    assert.equal(unread.result.isError, true);
    assert.equal(unread.result.structuredContent, undefined);
    assert.match(unread.result.content[0].text, /nested too deeply/);
    assert.equal(unread.result.content[1].text, "Found 1 advertiser ad.");

    // The bridge still answers.
    const { result } = await ask(answer({ data: [{ id: "r2" }] }));
    assert.deepEqual(result.structuredContent, { data: [{ id: "r2" }] });
  });

  await t.test("public names (brand, sponsor, company, page) are quoted as published", () => {
    const published = {
      id: "r1",
      brand: "Webmaster Solutions",
      vendor: "Webmaster Supply",
      tt_sponsors: ["Webmaster Media Ltd"],
      sponsor: "Webmaster Media Ltd",
      advertiser_name: "Webmaster Academy",
      display_name: "Webmaster Academy",
      page_name: "Webmaster Academy",
      company_name: "Webmaster Holdings",
      organization: "Webmaster Holdings",
      payer: "Webmaster Holdings",
      beneficiary: "Webmaster Holdings",
      domain: "webmaster-academy.example"
    };
    const { structuredContent } = transformToolResult({ structuredContent: { data: [published] } }, adapterConfig.tools[PINNED[0]]);
    assert.deepEqual(structuredContent.data, [published]);
  });

  await t.test("_meta of content blocks and text resources are cleaned; media data passes", { timeout: 10000 }, async () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const blob = { type: "resource", resource: { uri: "spytrend://media/1", mimeType: "video/mp4", blob: "aGVsbG8=" } };
    const { result } = await ask({
      result: {
        content: [
          { type: "text", text: "ok", _meta: { "spytrend/next_step": "Open get_webmaster.", "spytrend/pixel_ids": ["1"] } },
          { type: "resource", resource: { uri: "spytrend://ad/1", mimeType: "application/json", text: JSON.stringify({ id: "r1", webmaster_id: "w1" }) } },
          { type: "resource", resource: { uri: "spytrend://note/1", mimeType: "text/plain", text: "A webmaster card." } },
          { ...image, _meta: { pixel_id: "1" } },
          blob
        ]
      }
    });
    assert.deepEqual(result.content[0], { type: "text", text: "ok" });
    assert.deepEqual(JSON.parse(result.content[1].resource.text), { id: "r1" });
    assert.equal(result.content[2].resource.text, "An advertiser card.");
    assert.deepEqual(result.content[3], image);
    assert.deepEqual(result.content[4], blob);
  });

  await t.test("server notifications are cleaned; the adapter's own log names only its tools", { timeout: 10000 }, async () => {
    const log = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", logger: "spytrend", data: "Use get_webmaster for the webmaster card." } };
    const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1, message: "Reading webmaster cards" } };
    callServer.output.write(JSON.stringify(log) + "\n" + JSON.stringify(progress) + "\n");
    const notifications = [await toCallClient.next(), await toCallClient.next()];
    assertClean(notifications, "notifications");
    assert.equal(notifications[0].params.level, "info");
    assert.equal(notifications[1].params.message, "Reading advertiser cards");

    const logs = [];
    const quietClient = { input: new PassThrough(), output: new PassThrough() };
    const quietServer = { input: new PassThrough(), output: new PassThrough() };
    const toQuietServer = lines(quietServer.input);
    const toQuietClient = lines(quietClient.output);
    createBridge({ config: adapterConfig, client: quietClient, upstream: quietServer, identity: IDENTITY, log: (text) => logs.push(text) });
    quietClient.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await toQuietServer.next();
    quietServer.output.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\n");
    await toQuietClient.next();
    assert.equal(logs.length, Object.keys(EXPECTED_TOOLS).length);
    assertClean(logs, "the adapter's log");
  });

  await t.test("the server word is replaced in every letter case", { timeout: 10000 }, async () => {
    const { result } = await ask(answer({ data: [{ id: "r1" }], note: "WEBMASTER totals; WebMaster rows; webmaster pages." }));
    assert.equal(result.structuredContent.note, "ADVERTISER totals; Advertiser rows; advertiser pages.");
    if (!adapterConfig.vocabulary) return;
    const shouting = SERVER_TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema, description: "WEBMASTER ids and WebMaster pages." } }));
    assert.equal(buildLocalToolList(shouting, adapterConfig)[0].inputSchema.description, "ADVERTISER ids and Advertiser pages.");
  });

  await t.test("JSON inside a string value and lookalike keys are cleaned too", { timeout: 10000 }, async () => {
    const row = { id: "r1", extra: JSON.stringify({ webmaster_id: "w1", total_ads: 3 }), "Webmaſter_ID": "w1" };
    const { result } = await ask(answer({ data: [row] }));
    assert.deepEqual(result.structuredContent.data, [{ id: "r1", extra: JSON.stringify({ total_ads: 3 }) }]);
  });

  await t.test("an error whose text block is a JSON list is rewritten like structuredContent.error", { timeout: 10000 }, async () => {
    const internal = "pixel_id must be numeric.";
    const failure = refusal(internal, { outcome: "arg_error", code: "invalid_arguments", kind: "invalid_argument" });
    failure.result.content = [{ type: "text", text: JSON.stringify([internal]) }];
    const { result } = await ask(failure);
    assert.deepEqual(JSON.parse(result.content[0].text), [UNAVAILABLE]);
    assert.equal(result.structuredContent.error.message, UNAVAILABLE);
  });

  await t.test("notification correlation ids pass byte for byte", { timeout: 10000 }, async () => {
    const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "webmaster-7", progress: 1, message: "Reading webmaster cards" } };
    const cancelled = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "webmaster-call-3", reason: "Cancelled the webmaster lookup." } };
    callServer.output.write(JSON.stringify(progress) + "\n" + JSON.stringify(cancelled) + "\n");
    const [localProgress, localCancelled] = [await toCallClient.next(), await toCallClient.next()];
    assert.equal(localProgress.params.progressToken, "webmaster-7");
    assert.equal(localCancelled.params.requestId, "webmaster-call-3");
    assert.equal(localProgress.params.message, "Reading advertiser cards");
    assert.equal(localCancelled.params.reason, "Cancelled the advertiser lookup.");
  });

  await t.test("links inside a text resource are kept as they are", { timeout: 10000 }, async () => {
    const text = "Open https://webmaster-tools.example/c?ref=webmaster or write to webmaster@example.com; the webmaster card is below.";
    const { result } = await askRaw({ result: { content: [{ type: "resource", resource: { uri: "spytrend://note/2", mimeType: "text/plain", text } }] } });
    assert.equal(result.content[0].resource.text, text.replace("the webmaster card", "the advertiser card"));
  });

  await t.test("_meta of a resource is cleaned like the _meta of a block", { timeout: 10000 }, async () => {
    const meta = { "spytrend/next_step": "Open get_webmaster.", "spytrend/pixel_ids": ["1"], "spytrend/outcome": "ok" };
    const resource = { uri: "spytrend://note/3", mimeType: "text/plain", text: "ok" };
    const { result } = await ask({ result: { content: [{ type: "resource", resource: { ...resource, _meta: meta } }] } });
    assert.deepEqual(result.content[0].resource, { ...resource, _meta: { "spytrend/outcome": "ok" } });
  });

  await t.test("a JSON string in a notification is cleaned as JSON: public names stay, internal keys go", { timeout: 10000 }, async () => {
    const data = JSON.stringify({ brand: "Webmaster Solutions", name: "Webmaster Academy", webmaster_id: "w1", pixel_ids: ["1"], note: "webmaster cards" });
    callServer.output.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data } }) + "\n");
    const { params } = await toCallClient.next();
    assert.deepEqual(JSON.parse(params.data), { brand: "Webmaster Solutions", name: "Webmaster Academy", note: "advertiser cards" });
  });

  assert.ok(checked.length >= 10);
});

test("what an advertiser published is quoted as is; only server notes are reworded", () => {
  const row = {
    id: "a1",
    title: "Webmaster tools",
    body: "Hire a webmaster today",
    link_url: "https://t.example.com/c?pixel_id=12&resolved_ip=1",
    landing_domain: "webmaster-tools.example"
  };
  const payload = { data: [row], note: "Ranked by webmaster activity." };
  const { structuredContent } = transformToolResult({ structuredContent: payload }, adapterConfig.tools[PINNED[0]]);
  assert.deepEqual(structuredContent.data, [row]);
  assert.equal(structuredContent.note, "Ranked by advertiser activity.");
});

function lines(stream) {
  const queue = [];
  const waiting = [];
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (waiting.length) waiting.shift()(message);
      else queue.push(message);
    }
  });
  return { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))) };
}
