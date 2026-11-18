import test from "node:test";
import assert from "node:assert/strict";

import { loadAndValidateLocalNetwork } from "../runtime/declarative-loader.mjs";
import {
  DeclarativeExecutionError,
  createDeclarativeExecutor,
  createVoltEdgeToolRegistry
} from "../runtime/declarative-executor.mjs";

const BASE_URL = "https://app.example/studio/index.html";

function agent(name, tools = []) {
  return {
    name,
    function: {
      description: `${name} description`,
      parameters: {
        type: "object",
        properties: { inquiry: { type: "string" } },
        required: ["inquiry"]
      }
    },
    instructions: `${name} instructions`,
    tools
  };
}

function schema(properties = {}, required = []) {
  return { type: "object", properties, required };
}

function createFixture({
  frontTools = ["getPageState"],
  runtimeCapabilities = { getPageState: { input_schema: schema() } },
  maxInvocations = 8,
  timeoutMs = 20000
} = {}) {
  const manifest = {
    manifest_version: "0.2",
    site_name: "Executor Test",
    networks: [{
      name: "executor_test",
      front_man: "FrontAgent",
      hocon: "./executor_test.network.json"
    }]
  };
  const network = {
    metadata: {
      network_name: "executor_test",
      description: "Executor test network",
      front_man: "FrontAgent",
      execution_limits: {
        max_composition_depth: 2,
        max_agent_invocations: maxInvocations,
        max_remote_calls: 1,
        timeout_ms: timeoutMs
      },
      sly_data_policy: { default: "deny", allowed_downstream_fields: [] }
    },
    tools: [
      agent("FrontAgent", frontTools),
      agent("OtherAgent")
    ]
  };
  const routes = {
    "https://app.example/studio/agent-manifest.json": manifest,
    "https://app.example/studio/executor_test.network.json": network
  };
  const fetchImpl = async (url) => {
    const body = routes[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      url,
      async text() {
        return JSON.stringify(body ?? { error: "not found" });
      }
    };
  };
  return { fetchImpl, runtimeCapabilities };
}

async function validatedFixture(options = {}) {
  const fixture = createFixture(options);
  return loadAndValidateLocalNetwork({
    baseUrl: BASE_URL,
    networkName: "executor_test",
    fetchImpl: fixture.fetchImpl,
    runtimeCapabilities: fixture.runtimeCapabilities
  });
}

function fakeVoltEdgeRoot() {
  const nodes = {
    "#hardwareOrderForm": { id: "hardwareOrderForm" },
    "#productSelect": { id: "productSelect", value: "Otari Local Router Box ($299)" },
    "#quantityInput": { id: "quantityInput", value: "2" },
    "#promoCodeInput": { id: "promoCodeInput", value: "OPENWEB26" },
    "#livePreviewStatus": { id: "livePreviewStatus", textContent: "Cart total: $478.40" }
  };
  const root = {
    id: "techStoreRoot",
    parentElement: { id: "authorizedVoltEdgeHost" },
    isConnected: true,
    querySelector(selector) {
      return nodes[selector] || null;
    },
    contains(element) {
      return Object.values(nodes).includes(element);
    }
  };
  return { root, nodes };
}

function registryEntry(name, handler, { effect = "read_only", timeoutMs } = {}) {
  return [name, { name, effect, handler, timeoutMs }];
}

async function expectExecutionCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeclarativeExecutionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("executes getPageState through the validated front agent and observes authorized DOM", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root, now: () => 0 }),
    now: () => 0
  });

  const result = await executor.executeFrontTool("getPageState", {});

  assert.equal(executor.frontAgent, "FrontAgent");
  assert.equal(result.status, "success");
  assert.equal(result.output.source, "authorized-volt-edge-dom");
  assert.equal(result.output.fields.productSelect, "Otari Local Router Box ($299)");
  assert.equal(result.output.fields.quantityInput, "2");
  assert.equal(result.output.fields.promoCodeInput, "OPENWEB26");
  assert.equal(result.output.statusBanner, "Cart total: $478.40");
});

test("rejects a detached authorized DOM instead of reusing stale captured references", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root })
  });
  root.isConnected = false;

  await assert.rejects(executor.executeFrontTool("getPageState", {}), (error) => {
    assert.equal(error.code, "HANDLER_FAILED");
    assert.equal(error.cause?.code, "AUTHORIZED_DOM_DETACHED");
    return true;
  });
  assert.equal(executor.getTrace().some((event) => event.type === "tool.succeeded"), false);
});

test("does not authorize a VoltEdge-shaped root inside the imported preview boundary", () => {
  const { root } = fakeVoltEdgeRoot();
  root.parentElement = { id: "targetPreviewWrap" };
  assert.throws(
    () => createVoltEdgeToolRegistry({ root }),
    (error) => error.code === "UNAUTHORIZED_DOM_ROOT"
  );
});

test("rejects an arbitrary object that only claims to be validated", () => {
  assert.throws(
    () => createDeclarativeExecutor({ validatedNetwork: { status: "validated" }, toolRegistry: new Map() }),
    (error) => error instanceof DeclarativeExecutionError && error.code === "UNVALIDATED_NETWORK"
  );
});

test("rejects a missing agent", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root })
  });
  await expectExecutionCode(
    executor.dispatch({ agentName: "MissingAgent", toolName: "getPageState", arguments: {} }),
    "AGENT_NOT_FOUND"
  );
});

test("rejects a tool that is not present in the explicit registry", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root })
  });
  await expectExecutionCode(
    executor.dispatch({ agentName: "FrontAgent", toolName: "missing_tool", arguments: {} }),
    "TOOL_NOT_FOUND"
  );
});

test("blocks a tool that is registered but not authorized for the active agent", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root })
  });
  await expectExecutionCode(
    executor.dispatch({ agentName: "OtherAgent", toolName: "getPageState", arguments: {} }),
    "TOOL_NOT_AUTHORIZED"
  );
});

test("rejects arguments incompatible with the validated tool schema before the handler", async () => {
  const validatedNetwork = await validatedFixture();
  let handlerCalls = 0;
  const registry = new Map([
    registryEntry("getPageState", async () => {
      handlerCalls += 1;
      return {};
    })
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  await expectExecutionCode(
    executor.executeFrontTool("getPageState", { unexpected: true }),
    "INVALID_ARGUMENTS"
  );
  assert.equal(handlerCalls, 0);
});

test("enforces the invocation budget instead of only updating counters", async () => {
  const validatedNetwork = await validatedFixture({ maxInvocations: 1 });
  let handlerCalls = 0;
  const registry = new Map([
    registryEntry("getPageState", async () => {
      handlerCalls += 1;
      return { ok: true };
    })
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  await executor.executeFrontTool("getPageState", {});
  await expectExecutionCode(executor.executeFrontTool("getPageState", {}), "BUDGET_EXCEEDED");
  assert.equal(handlerCalls, 1);
  assert.equal(executor.getState().stats.invocations, 1);
});

test("times out an asynchronous tool and ignores its late success", async () => {
  const runtimeCapabilities = {
    slow_read: { input_schema: schema() }
  };
  const validatedNetwork = await validatedFixture({
    frontTools: ["slow_read"],
    runtimeCapabilities,
    timeoutMs: 10
  });
  let handlerResolved = false;
  const registry = new Map([
    registryEntry("slow_read", async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      handlerResolved = true;
      return { late: true };
    })
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  await expectExecutionCode(executor.executeFrontTool("slow_read", {}), "TIMEOUT");
  const traceLengthAtTimeout = executor.getTrace().length;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(handlerResolved, true);
  assert.equal(executor.getTrace().length, traceLengthAtTimeout);
  assert.equal(executor.getTrace().some((event) => event.type === "tool.succeeded"), false);
  assert.deepEqual(executor.getState().stats, {
    invocations: 1,
    completed: 0,
    rejected: 0,
    failed: 0,
    timedOut: 1,
    active: 0
  });
});

test("wraps a controlled handler failure", async () => {
  const runtimeCapabilities = { failing_read: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    frontTools: ["failing_read"],
    runtimeCapabilities
  });
  const registry = new Map([
    registryEntry("failing_read", async () => {
      throw new Error("internal detail");
    })
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  await expectExecutionCode(executor.executeFrontTool("failing_read", {}), "HANDLER_FAILED");
  assert.equal(executor.getTrace().at(-1).type, "tool.failed");
});

test("blocks write tools before their handlers run", async () => {
  const runtimeCapabilities = { write_tool: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    frontTools: ["write_tool"],
    runtimeCapabilities
  });
  let handlerCalls = 0;
  const registry = new Map([
    registryEntry("write_tool", async () => {
      handlerCalls += 1;
      return { changed: true };
    }, { effect: "irreversible_write" })
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  await expectExecutionCode(executor.executeFrontTool("write_tool", {}), "WRITE_TOOL_NOT_ALLOWED");
  assert.equal(handlerCalls, 0);
});

test("trace contains only events emitted by exact dispatcher invocations", async () => {
  const validatedNetwork = await validatedFixture();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root, now: () => 0 }),
    now: () => 0
  });

  await executor.dispatch({ agentName: "FrontAgent", toolName: "getPageState", arguments: {} });
  const trace = executor.getTrace();
  assert.deepEqual(trace.map((event) => event.type), [
    "executor.initialized",
    "invocation.started",
    "arguments.validated",
    "tool.started",
    "tool.succeeded"
  ]);
  assert.equal(trace.slice(1).every((event) => event.agentName === "FrontAgent"), true);
  assert.equal(trace.slice(1).every((event) => event.toolName === "getPageState"), true);
});

test("executes by exact agent and tool identifiers without keyword input", async () => {
  const validatedNetwork = await validatedFixture();
  const registry = new Map([
    registryEntry("getPageState", async () => ({ observed: true }))
  ]);
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: registry });

  assert.equal("prompt" in executor, false);
  const result = await executor.dispatch({
    agentName: "FrontAgent",
    toolName: "getPageState",
    arguments: {}
  });
  assert.deepEqual(result.output, { observed: true });
});
