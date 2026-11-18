import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadAndValidateLocalNetwork } from "../runtime/declarative-loader.mjs";
import {
  DeclarativeExecutionError,
  createDeclarativeExecutor,
  createVoltEdgeToolRegistry
} from "../runtime/declarative-executor.mjs";

const BASE_URL = "https://app.example/studio/index.html";

function schema(properties = {}, required = []) {
  return { type: "object", properties, required };
}

function agent(name, tools = []) {
  return {
    name,
    function: {
      description: `${name} description`,
      parameters: schema({ inquiry: { type: "string" } }, ["inquiry"])
    },
    instructions: `${name} instructions`,
    tools
  };
}

function registryEntry(name, handler, { effect = "read_only", timeoutMs } = {}) {
  return [name, { name, effect, handler, timeoutMs }];
}

function fixture({
  agents = [agent("FrontAgent", ["WorkerAgent"]), agent("WorkerAgent", ["getPageState"])],
  runtimeCapabilities = { getPageState: { input_schema: schema() } },
  maxDepth = 3,
  maxInvocations = 8,
  timeoutMs = 20000
} = {}) {
  const manifest = {
    manifest_version: "0.2",
    site_name: "Delegation Test",
    networks: [{
      name: "delegation_test",
      front_man: "FrontAgent",
      hocon: "./delegation_test.network.json"
    }]
  };
  const network = {
    metadata: {
      network_name: "delegation_test",
      description: "Delegation test network",
      front_man: "FrontAgent",
      execution_limits: {
        max_composition_depth: maxDepth,
        max_agent_invocations: maxInvocations,
        max_remote_calls: 1,
        timeout_ms: timeoutMs
      },
      sly_data_policy: { default: "deny", allowed_downstream_fields: [] }
    },
    tools: agents
  };
  const routes = {
    "https://app.example/studio/agent-manifest.json": manifest,
    "https://app.example/studio/delegation_test.network.json": network
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
  const configured = fixture(options);
  return loadAndValidateLocalNetwork({
    baseUrl: BASE_URL,
    networkName: "delegation_test",
    fetchImpl: configured.fetchImpl,
    runtimeCapabilities: configured.runtimeCapabilities
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

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeclarativeExecutionError);
    assert.equal(error.code, code);
    return true;
  });
}

async function loadPublishedVoltEdge() {
  const projectRoot = new URL("../", import.meta.url);
  const files = new Map([
    ["agent-manifest.json", new URL("agent-manifest.json", projectRoot)],
    ["voltedge_hardware_store.network.json", new URL("voltedge_hardware_store.network.json", projectRoot)],
    ["links.json", new URL("links.json", projectRoot)],
    ["discovered-actions.json", new URL("discovered-actions.json", projectRoot)]
  ]);
  return loadAndValidateLocalNetwork({
    baseUrl: BASE_URL,
    networkName: "voltedge_hardware_store",
    fetchImpl: async (url) => {
      const fileUrl = files.get(new URL(url).pathname.split("/").pop());
      return {
        ok: Boolean(fileUrl),
        status: fileUrl ? 200 : 404,
        url,
        async text() {
          return fileUrl ? readFile(fileUrl, "utf8") : JSON.stringify({ error: "not found" });
        }
      };
    }
  });
}

test("delegates through the published VoltEdge topology and executes getPageState", async () => {
  const validatedNetwork = await loadPublishedVoltEdge();
  const { root } = fakeVoltEdgeRoot();
  const executor = createDeclarativeExecutor({
    validatedNetwork,
    toolRegistry: createVoltEdgeToolRegistry({ root, now: () => 0 })
  });

  const result = await executor.executeVoltEdgeDiagnostic();

  assert.equal(result.status, "success");
  assert.equal(result.frontAgent, "FrontDesk_Coordinator");
  assert.equal(result.delegatedAgent, "State_Form_Specialist");
  assert.deepEqual(result.agentChain, ["FrontDesk_Coordinator", "State_Form_Specialist"]);
  assert.equal(result.toolResult.agentName, "State_Form_Specialist");
  assert.equal(result.toolResult.output.source, "authorized-volt-edge-dom");
  assert.equal(result.context.invocations_consumed, 3);
  assert.equal(result.context.budget_remaining, 5);
});

test("rejects delegation not authorized by the caller topology", async () => {
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent"), agent("WorkerAgent", ["getPageState"])]
  });
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => ({ ok: true }))
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "getPageState", arguments: {}
  }), "DELEGATION_NOT_AUTHORIZED");
  assert.equal(executor.getTrace().some((event) => event.type === "delegation.rejected"), true);
});

test("rejects a requested delegated agent that does not exist", async () => {
  const validatedNetwork = await validatedFixture();
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => ({ ok: true }))
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["MissingAgent"], toolName: "getPageState", arguments: {}
  }), "AGENT_NOT_FOUND");
});

test("blocks a tool not authorized to the delegated agent", async () => {
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent", ["WorkerAgent", "getPageState"]), agent("WorkerAgent")]
  });
  let handlerCalls = 0;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => {
      handlerCalls += 1;
      return { ok: true };
    })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "getPageState", arguments: {}
  }), "TOOL_NOT_AUTHORIZED");
  assert.equal(handlerCalls, 0);
});

test("returns the delegated tool result to the front agent", async () => {
  const validatedNetwork = await validatedFixture();
  const output = { observed: true, value: "from-worker" };
  let handlerContext;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async (_arguments, { executionContext }) => {
      handlerContext = executionContext;
      return output;
    })
  ]) });

  const result = await executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "getPageState", arguments: {}
  });
  assert.deepEqual(result.toolResult.output, output);
  assert.equal(handlerContext.execution_id, result.executionId);
  assert.equal(handlerContext.current_agent, "WorkerAgent");
  assert.deepEqual(handlerContext.agent_chain, ["FrontAgent", "WorkerAgent"]);
  assert.equal(handlerContext.depth, 1);
  assert.equal(handlerContext.invocations_consumed, 3);
  assert.equal(handlerContext.budget_remaining, 5);
  assert.equal(typeof handlerContext.deadline, "string");
  assert.equal(handlerContext.signal.aborted, false);
  const completions = result.context.trace.filter((event) => event.type === "agent.completed");
  assert.deepEqual(completions.map((event) => event.agentName), ["WorkerAgent", "FrontAgent"]);
});

test("blocks delegation beyond max_composition_depth", async () => {
  const validatedNetwork = await validatedFixture({
    maxDepth: 1,
    agents: [
      agent("FrontAgent", ["MiddleAgent"]),
      agent("MiddleAgent", ["LeafAgent"]),
      agent("LeafAgent", ["getPageState"])
    ]
  });
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => ({ ok: true }))
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["MiddleAgent", "LeafAgent"], toolName: "getPageState", arguments: {}
  }), "MAX_DEPTH_EXCEEDED");
});

test("shares the invocation budget across agents and the delegated tool", async () => {
  const validatedNetwork = await validatedFixture({ maxInvocations: 2 });
  let handlerCalls = 0;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => {
      handlerCalls += 1;
      return { ok: true };
    })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "getPageState", arguments: {}
  }), "BUDGET_EXCEEDED");
  assert.equal(handlerCalls, 0);
  const started = executor.getTrace().filter((event) => event.type === "agent.started");
  assert.equal(started.at(-1).details.budgetRemaining, 0);
});

test("detects an internal delegation cycle before re-entering an agent", async () => {
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent", ["WorkerAgent"]), agent("WorkerAgent", ["FrontAgent", "getPageState"])]
  });
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => ({ ok: true }))
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent", "FrontAgent"], toolName: "getPageState", arguments: {}
  }), "DELEGATION_CYCLE");
  assert.equal(executor.getTrace().some((event) => (
    event.type === "delegation.rejected" && event.details.code === "DELEGATION_CYCLE"
  )), true);
});

test("propagates delegation timeout and ignores a late tool success", async () => {
  const runtimeCapabilities = { slow_read: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent", ["WorkerAgent"]), agent("WorkerAgent", ["slow_read"])],
    runtimeCapabilities,
    timeoutMs: 10
  });
  let resolvedLate = false;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("slow_read", async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      resolvedLate = true;
      return { late: true };
    })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "slow_read", arguments: {}
  }), "TIMEOUT");
  const traceLengthAtTimeout = executor.getTrace().length;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(resolvedLate, true);
  assert.equal(executor.getTrace().length, traceLengthAtTimeout);
  assert.equal(executor.getTrace().some((event) => event.type === "tool.succeeded"), false);
  assert.equal(executor.getTrace().some((event) => event.type === "agent.completed"), false);
  assert.equal(executor.getTrace().filter((event) => event.type === "agent.failed").length, 2);
});

test("propagates a delegated handler failure without false success", async () => {
  const runtimeCapabilities = { failing_read: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent", ["WorkerAgent"]), agent("WorkerAgent", ["failing_read"])],
    runtimeCapabilities
  });
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("failing_read", async () => {
      throw new Error("controlled failure");
    })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "failing_read", arguments: {}
  }), "HANDLER_FAILED");
  assert.equal(executor.getTrace().some((event) => event.type === "agent.completed"), false);
  assert.equal(executor.getTrace().filter((event) => event.type === "agent.failed").length, 2);
});

test("does not let a delegated agent inherit the front agent's permissions", async () => {
  const runtimeCapabilities = { privileged_read: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    agents: [
      agent("FrontAgent", ["WorkerAgent", "privileged_read"]),
      agent("WorkerAgent")
    ],
    runtimeCapabilities
  });
  let handlerCalls = 0;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("privileged_read", async () => {
      handlerCalls += 1;
      return { secret: true };
    })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "privileged_read", arguments: {}
  }), "TOOL_NOT_AUTHORIZED");
  assert.equal(handlerCalls, 0);
});

test("continues to block write tools inside a valid delegation", async () => {
  const runtimeCapabilities = { write_tool: { input_schema: schema() } };
  const validatedNetwork = await validatedFixture({
    agents: [agent("FrontAgent", ["WorkerAgent"]), agent("WorkerAgent", ["write_tool"])],
    runtimeCapabilities
  });
  let handlerCalls = 0;
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("write_tool", async () => {
      handlerCalls += 1;
      return { changed: true };
    }, { effect: "reversible_write" })
  ]) });

  await expectCode(executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "write_tool", arguments: {}
  }), "WRITE_TOOL_NOT_ALLOWED");
  assert.equal(handlerCalls, 0);
});

test("emits a real two-agent trace in execution order", async () => {
  const validatedNetwork = await validatedFixture();
  const executor = createDeclarativeExecutor({ validatedNetwork, toolRegistry: new Map([
    registryEntry("getPageState", async () => ({ observed: true }))
  ]) });

  const result = await executor.executeDelegationPath({
    agentPath: ["WorkerAgent"], toolName: "getPageState", arguments: {}
  });

  assert.deepEqual(result.context.trace.map((event) => event.type), [
    "agent.started",
    "agent.delegated",
    "agent.started",
    "invocation.started",
    "arguments.validated",
    "tool.started",
    "tool.succeeded",
    "agent.completed",
    "agent.completed"
  ]);
  assert.equal(result.context.trace.every((event) => event.executionId === result.executionId), true);
  assert.equal("prompt" in executor, false);
});
