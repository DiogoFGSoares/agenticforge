import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DeclarativeLoadError,
  loadAndValidateLocalNetwork,
  validateManifest
} from "../runtime/declarative-loader.mjs";

const BASE_URL = "https://app.example/studio/index.html";

function validManifest(overrides = {}) {
  return {
    manifest_version: "0.2",
    site_name: "Test Agent Site",
    peer_policy: {
      allowed_peers: ["https://peer.example"]
    },
    networks: [
      {
        name: "test_network",
        front_man: "FrontAgent",
        hocon: "./test_network.network.json",
        links: "./links.json",
        discovered_actions: "./actions.json"
      }
    ],
    ...overrides
  };
}

function agent(name, tools = []) {
  return {
    name,
    function: {
      description: `${name} description`,
      parameters: {
        type: "object",
        properties: {
          inquiry: { type: "string" }
        },
        required: ["inquiry"]
      }
    },
    instructions: `${name} instructions`,
    tools
  };
}

function validNetwork(overrides = {}) {
  return {
    metadata: {
      network_name: "test_network",
      description: "A test network",
      front_man: "FrontAgent",
      execution_limits: {
        max_composition_depth: 3,
        max_agent_invocations: 8,
        max_remote_calls: 2,
        timeout_ms: 20000
      },
      sly_data_policy: {
        default: "deny",
        allowed_downstream_fields: []
      }
    },
    tools: [
      agent("FrontAgent", ["WorkerAgent", "getPageState", "safe_action", "approved_peer"]),
      agent("WorkerAgent")
    ],
    ...overrides
  };
}

function validActions(overrides = {}) {
  return {
    schema_version: "1.0",
    actions: [
      {
        name: "safe_action",
        selector: "#safeButton",
        effect: "read_only",
        requires_user_confirmation: false,
        input_schema: {
          type: "object",
          properties: {
            value: { type: "string" }
          }
        }
      }
    ],
    ...overrides
  };
}

function validLinks() {
  return {
    version: 1,
    networks: {
      test_network: {
        approved_peer: "https://peer.example/transit"
      }
    }
  };
}

function jsonResponse(url, body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!(url in routes)) return jsonResponse(url, { error: "not found" }, 404);
    const route = routes[url];
    return jsonResponse(url, route.body, route.status ?? 200);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function routes({ manifest = validManifest(), network = validNetwork(), actions = validActions(), links = validLinks() } = {}) {
  return {
    "https://app.example/studio/agent-manifest.json": { body: manifest },
    "https://app.example/studio/test_network.network.json": { body: network },
    "https://app.example/studio/actions.json": { body: actions },
    "https://app.example/studio/links.json": { body: links }
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeclarativeLoadError);
    assert.equal(error.code, code);
    assert.equal(typeof error.path, "string");
    return true;
  });
}

test("accepts a valid manifest", () => {
  assert.equal(validateManifest(validManifest()).networks[0].name, "test_network");
});

test("loads and validates a valid local network without credentials or execution", async () => {
  delete globalThis.__agenticForgeExecuted;
  const network = validNetwork();
  network.tools[0].instructions = "globalThis.__agenticForgeExecuted = true";
  const fetchImpl = mockFetch(routes({ network }));

  const result = await loadAndValidateLocalNetwork({
    baseUrl: BASE_URL,
    networkName: "test_network",
    fetchImpl
  });

  assert.equal(result.status, "validated");
  assert.equal(result.validation.frontMan, "FrontAgent");
  assert.deepEqual(result.validation.agentNames, ["FrontAgent", "WorkerAgent"]);
  assert.equal(globalThis.__agenticForgeExecuted, undefined);
  assert.equal(fetchImpl.calls.length, 4);
  for (const call of fetchImpl.calls) {
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, undefined);
  }
});

test("loads the repository's published local network artifacts", async () => {
  const projectRoot = new URL("../", import.meta.url);
  const fileMap = new Map([
    ["agent-manifest.json", new URL("agent-manifest.json", projectRoot)],
    ["voltedge_hardware_store.network.json", new URL("voltedge_hardware_store.network.json", projectRoot)],
    ["links.json", new URL("links.json", projectRoot)],
    ["discovered-actions.json", new URL("discovered-actions.json", projectRoot)]
  ]);
  const fetchImpl = async (url, options) => {
    const name = new URL(url).pathname.split("/").pop();
    const fileUrl = fileMap.get(name);
    if (!fileUrl) return jsonResponse(url, { error: "not found" }, 404);
    assert.equal(options.credentials, "omit");
    return jsonResponse(url, await readFile(fileUrl, "utf8"));
  };

  const result = await loadAndValidateLocalNetwork({
    baseUrl: BASE_URL,
    networkName: "voltedge_hardware_store",
    fetchImpl
  });

  assert.equal(result.status, "validated");
  assert.equal(result.validation.frontMan, "FrontDesk_Coordinator");
  assert.equal(result.validation.agentNames.length, 3);
  assert.equal(result.validation.actionNames.length, 5);
  assert.deepEqual(result.validation.linkNames, ["worldwide_agentic_web_peer"]);
});

test("rejects an invalid manifest", async () => {
  const fetchImpl = mockFetch(routes({ manifest: { manifest_version: "0.2", site_name: "Broken" } }));
  await expectCode(
    loadAndValidateLocalNetwork({ baseUrl: BASE_URL, networkName: "test_network", fetchImpl }),
    "INVALID_MANIFEST"
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test("rejects a missing network artifact", async () => {
  const fixtureRoutes = routes();
  delete fixtureRoutes["https://app.example/studio/test_network.network.json"];
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(fixtureRoutes)
    }),
    "NETWORK_NOT_FOUND"
  );
});

test("rejects a missing front agent", async () => {
  const network = validNetwork();
  network.metadata.front_man = "MissingAgent";
  const manifest = validManifest();
  manifest.networks[0].front_man = "MissingAgent";
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(routes({ manifest, network }))
    }),
    "FRONT_AGENT_NOT_FOUND"
  );
});

test("rejects an unresolved tool reference", async () => {
  const network = validNetwork();
  network.tools[0].tools.push("missing_tool");
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(routes({ network }))
    }),
    "UNRESOLVED_REFERENCE"
  );
});

test("rejects duplicate agent names", async () => {
  const network = validNetwork();
  network.tools.push(agent("WorkerAgent"));
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(routes({ network }))
    }),
    "DUPLICATE_AGENT_NAME"
  );
});

test("rejects an unauthorized manifest path before fetching", async () => {
  const fetchImpl = mockFetch({});
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      manifestUrl: "../agent-manifest.json",
      networkName: "test_network",
      fetchImpl
    }),
    "UNSAFE_URL"
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("rejects an unauthorized external link", async () => {
  const links = validLinks();
  links.networks.test_network.approved_peer = "https://evil.example/transit";
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(routes({ links }))
    }),
    "UNAUTHORIZED_EXTERNAL_REFERENCE"
  );
});

test("rejects a structurally invalid JSON Schema", async () => {
  const actions = validActions();
  actions.actions[0].input_schema = {
    type: "object",
    properties: [],
    required: ["missing"]
  };
  await expectCode(
    loadAndValidateLocalNetwork({
      baseUrl: BASE_URL,
      networkName: "test_network",
      fetchImpl: mockFetch(routes({ actions }))
    }),
    "INVALID_SCHEMA"
  );
});
