import { isValidatedLoadResult } from "./declarative-loader.mjs";

const READ_ONLY_EFFECT = "read_only";

export class DeclarativeExecutionError extends Error {
  constructor(code, message, { phase = "execution", path = "$", details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DeclarativeExecutionError";
    this.code = code;
    this.phase = phase;
    this.path = path;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      path: this.path,
      details: this.details
    };
  }
}

function fail(code, message, options) {
  throw new DeclarativeExecutionError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value, path) {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch (cause) {
    fail("NON_SERIALIZABLE_VALUE", `${path} must be JSON-serializable.`, { path, cause });
  }
}

function valueMatchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function argumentError(path, message, details = null) {
  fail("INVALID_ARGUMENTS", message, { phase: "arguments", path, details });
}

export function validateArgumentsAgainstSchema(value, schema, path = "$arguments") {
  if (!isRecord(schema) || typeof schema.type !== "string") {
    fail("INVALID_TOOL_SCHEMA", "The validated tool schema is unavailable or malformed.", {
      phase: "arguments",
      path: "$schema"
    });
  }
  if (!valueMatchesType(value, schema.type)) {
    argumentError(path, `${path} must be of type '${schema.type}'.`, {
      expected: schema.type,
      actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    });
  }

  if (schema.enum && !schema.enum.some((candidate) => sameJsonValue(candidate, value))) {
    argumentError(path, `${path} must match one of the declared enum values.`);
  }

  if (schema.type === "object") {
    const properties = schema.properties || {};
    for (const requiredName of schema.required || []) {
      if (!(requiredName in value)) {
        argumentError(`${path}.${requiredName}`, `Required argument '${requiredName}' is missing.`);
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (!(name in properties)) {
        argumentError(`${path}.${name}`, `Unexpected argument '${name}' is not declared by the tool schema.`);
      }
      validateArgumentsAgainstSchema(child, properties[name], `${path}.${name}`);
    }
  }

  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      argumentError(path, `${path} must contain at least ${schema.minItems} items.`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      argumentError(path, `${path} must contain no more than ${schema.maxItems} items.`);
    }
    value.forEach((item, index) => validateArgumentsAgainstSchema(item, schema.items, `${path}[${index}]`));
  }

  if (schema.type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      argumentError(path, `${path} must contain at least ${schema.minLength} characters.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      argumentError(path, `${path} must contain no more than ${schema.maxLength} characters.`);
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) {
      argumentError(path, `${path} does not match the declared pattern.`);
    }
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      argumentError(path, `${path} must be greater than or equal to ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      argumentError(path, `${path} must be less than or equal to ${schema.maximum}.`);
    }
  }

  return value;
}

function assertVoltEdgeRoot(root) {
  if (!root || typeof root.querySelector !== "function") {
    fail("AUTHORIZED_DOM_UNAVAILABLE", "The authorized VoltEdge DOM root is unavailable.", {
      phase: "registry",
      path: "root"
    });
  }
  if (root.id !== "techStoreRoot" || root.parentElement?.id !== "authorizedVoltEdgeHost") {
    fail("UNAUTHORIZED_DOM_ROOT", "getPageState may only bind to the known VoltEdge root.", {
      phase: "registry",
      path: "root"
    });
  }

  const selectors = {
    form: "#hardwareOrderForm",
    product: "#productSelect",
    quantity: "#quantityInput",
    promo: "#promoCodeInput",
    status: "#livePreviewStatus"
  };
  const elements = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const element = root.querySelector(selector);
    if (!element) {
      fail("AUTHORIZED_DOM_INCOMPLETE", `The authorized VoltEdge root is missing ${selector}.`, {
        phase: "registry",
        path: selector
      });
    }
    elements[name] = element;
  }
  return Object.freeze(elements);
}

function assertCapturedDomStillAuthorized(root, elements) {
  if (root.isConnected === false) {
    fail("AUTHORIZED_DOM_DETACHED", "The authorized VoltEdge DOM root is no longer connected.", {
      phase: "handler",
      path: "#techStoreRoot"
    });
  }
  if (root.parentElement?.id !== "authorizedVoltEdgeHost") {
    fail("AUTHORIZED_DOM_REPARENTED", "The captured VoltEdge root left its authorized host.", {
      phase: "handler",
      path: "#authorizedVoltEdgeHost > #techStoreRoot"
    });
  }
  if (typeof root.contains === "function") {
    for (const [name, element] of Object.entries(elements)) {
      if (!root.contains(element)) {
        fail("AUTHORIZED_DOM_CHANGED", `The captured VoltEdge '${name}' node is no longer inside the authorized root.`, {
          phase: "handler",
          path: `#techStoreRoot.${name}`
        });
      }
    }
  }
}

export function createVoltEdgeToolRegistry({ root, now = () => Date.now() } = {}) {
  const elements = assertVoltEdgeRoot(root);
  const registry = new Map();

  registry.set("getPageState", Object.freeze({
    name: "getPageState",
    effect: READ_ONLY_EFFECT,
    timeoutMs: 1000,
    async handler(_arguments, { signal }) {
      if (signal.aborted) {
        fail("TOOL_ABORTED", "getPageState was aborted before reading the authorized DOM.", {
          phase: "handler",
          path: "getPageState"
        });
      }
      assertCapturedDomStillAuthorized(root, elements);
      const snapshot = {
        observedAt: new Date(now()).toISOString(),
        source: "authorized-volt-edge-dom",
        fields: {
          productSelect: String(elements.product.value ?? ""),
          quantityInput: String(elements.quantity.value ?? ""),
          promoCodeInput: String(elements.promo.value ?? "")
        },
        statusBanner: String(elements.status.textContent ?? "").trim()
      };
      if (signal.aborted) {
        fail("TOOL_ABORTED", "getPageState was aborted while reading the authorized DOM.", {
          phase: "handler",
          path: "getPageState"
        });
      }
      return deepFreeze(snapshot);
    }
  }));

  return registry;
}

function normalizeToolRegistry(toolRegistry) {
  if (!(toolRegistry instanceof Map)) {
    fail("INVALID_TOOL_REGISTRY", "toolRegistry must be an explicit Map of tool descriptors.", {
      phase: "initialization",
      path: "toolRegistry"
    });
  }
  const normalized = new Map();
  for (const [name, descriptor] of toolRegistry) {
    if (typeof name !== "string" || name.trim() === "" || !isRecord(descriptor)) {
      fail("INVALID_TOOL_REGISTRY", "Every tool registry entry must have a name and descriptor object.", {
        phase: "initialization",
        path: `toolRegistry.${String(name)}`
      });
    }
    if (typeof descriptor.handler !== "function") {
      fail("INVALID_TOOL_REGISTRY", `Tool '${name}' must provide a handler function.`, {
        phase: "initialization",
        path: `toolRegistry.${name}.handler`
      });
    }
    if (typeof descriptor.effect !== "string") {
      fail("INVALID_TOOL_REGISTRY", `Tool '${name}' must declare its effect.`, {
        phase: "initialization",
        path: `toolRegistry.${name}.effect`
      });
    }
    normalized.set(name, Object.freeze({ ...descriptor, name }));
  }
  return normalized;
}

export function createDeclarativeExecutor({
  validatedNetwork,
  toolRegistry,
  now = () => Date.now(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
} = {}) {
  if (!isValidatedLoadResult(validatedNetwork)) {
    fail("UNVALIDATED_NETWORK", "Executor requires the exact immutable result returned by the declarative loader.", {
      phase: "initialization",
      path: "validatedNetwork"
    });
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    fail("INVALID_TIMER_API", "Executor requires timer functions.", {
      phase: "initialization",
      path: "timers"
    });
  }

  const registry = normalizeToolRegistry(toolRegistry);
  const agents = new Map(validatedNetwork.network.tools.map((agent) => [agent.name, agent]));
  const schemas = validatedNetwork.validation.runtimeToolSchemas;
  const limits = validatedNetwork.network.metadata.execution_limits || {};
  const maxDepth = limits.max_depth ?? limits.max_composition_depth;
  const maxInvocations = limits.max_agent_invocations;
  const executionTimeoutMs = limits.timeout_ms;
  if (
    !Number.isInteger(maxDepth) || maxDepth <= 0
    || !Number.isInteger(maxInvocations) || maxInvocations <= 0
    || !Number.isInteger(executionTimeoutMs) || executionTimeoutMs <= 0
  ) {
    fail("INVALID_EXECUTION_LIMITS", "Validated network does not provide usable invocation and timeout limits.", {
      phase: "initialization",
      path: "$network.metadata.execution_limits"
    });
  }

  const trace = [];
  let eventSequence = 0;
  let invocationSequence = 0;
  let executionSequence = 0;
  let sessionStartedAt = null;
  let directExecution = null;
  const executions = new Map();
  const stats = {
    invocations: 0,
    completed: 0,
    rejected: 0,
    failed: 0,
    timedOut: 0,
    active: 0
  };

  function emit(type, {
    execution = null,
    invocationId = null,
    agentName = null,
    toolName = null,
    details = null
  } = {}) {
    const event = deepFreeze({
      sequence: ++eventSequence,
      type,
      timestamp: new Date(now()).toISOString(),
      executionId: execution?.executionId ?? null,
      depth: execution ? Math.max(0, execution.agentChain.length - 1) : null,
      invocationId,
      agentName,
      toolName,
      details: details === null ? null : cloneJson(details, "$trace.details")
    });
    trace.push(event);
    return event;
  }

  function rejectInvocation(error, context = {}) {
    stats.rejected += 1;
    emit("invocation.rejected", {
      ...context,
      details: { code: error.code, path: error.path }
    });
    throw error;
  }

  emit("executor.initialized", {
    agentName: validatedNetwork.validation.frontMan,
    details: {
      networkName: validatedNetwork.selectedNetwork,
      maxDepth,
      maxInvocations,
      timeoutMs: executionTimeoutMs,
      registeredTools: [...registry.keys()]
    }
  });

  function createExecutionContext() {
    const startedAt = now();
    const execution = {
      executionId: `exec_${++executionSequence}`,
      startedAt,
      deadlineAt: startedAt + executionTimeoutMs,
      abortController: new AbortController(),
      currentAgent: null,
      agentChain: [],
      invocationsConsumed: 0,
      activeInvocations: 0
    };
    executions.set(execution.executionId, execution);
    if (sessionStartedAt === null) sessionStartedAt = startedAt;
    return execution;
  }

  function getDirectExecution() {
    if (!directExecution) directExecution = createExecutionContext();
    return directExecution;
  }

  function executionTrace(executionId) {
    return Object.freeze(trace.filter((event) => event.executionId === executionId));
  }

  function snapshotExecution(execution) {
    return Object.freeze({
      execution_id: execution.executionId,
      current_agent: execution.currentAgent,
      agent_chain: Object.freeze([...execution.agentChain]),
      depth: Math.max(0, execution.agentChain.length - 1),
      invocations_consumed: execution.invocationsConsumed,
      budget_remaining: Math.max(0, maxInvocations - execution.invocationsConsumed),
      deadline: new Date(execution.deadlineAt).toISOString(),
      signal: execution.abortController.signal,
      trace: executionTrace(execution.executionId)
    });
  }

  function timeoutError(message = "The shared execution deadline has expired.") {
    return new DeclarativeExecutionError("TIMEOUT", message, {
      phase: "timeout",
      path: "$network.metadata.execution_limits.timeout_ms",
      details: { timeoutMs: executionTimeoutMs }
    });
  }

  function assertExecutionActive(execution) {
    if (execution.abortController.signal.aborted || now() >= execution.deadlineAt) {
      if (!execution.abortController.signal.aborted) execution.abortController.abort();
      throw timeoutError();
    }
  }

  function consumeInvocation(execution, context = {}) {
    if (execution.invocationsConsumed >= maxInvocations) {
      const error = new DeclarativeExecutionError(
        "BUDGET_EXCEEDED",
        `Shared execution budget ${maxInvocations} has been exhausted.`,
        { phase: "budget", path: "$network.metadata.execution_limits.max_agent_invocations" }
      );
      emit("budget.exceeded", {
        execution,
        ...context,
        details: { maxInvocations, invocationsConsumed: execution.invocationsConsumed }
      });
      throw error;
    }
    execution.invocationsConsumed += 1;
  }

  async function dispatchInternal(
    { agentName, toolName, arguments: rawArguments = {} } = {},
    execution = null
  ) {
    const invocationId = `inv_${++invocationSequence}`;
    const activeExecution = execution || getDirectExecution();
    const context = {
      execution: activeExecution,
      invocationId,
      agentName: agentName ?? null,
      toolName: toolName ?? null
    };
    const agent = agents.get(agentName);
    if (!agent) {
      return rejectInvocation(new DeclarativeExecutionError(
        "AGENT_NOT_FOUND",
        `Agent '${String(agentName)}' is not defined in the validated network.`,
        { path: "agentName", details: { agentName } }
      ), context);
    }

    const tool = registry.get(toolName);
    if (!tool) {
      return rejectInvocation(new DeclarativeExecutionError(
        "TOOL_NOT_FOUND",
        `Tool '${String(toolName)}' is not registered for execution.`,
        { path: "toolName", details: { toolName } }
      ), context);
    }
    if (!agent.tools.includes(toolName)) {
      return rejectInvocation(new DeclarativeExecutionError(
        "TOOL_NOT_AUTHORIZED",
        `Agent '${agentName}' is not authorized to invoke '${toolName}'.`,
        { path: `$network.tools.${agentName}.tools`, details: { agentName, toolName } }
      ), context);
    }
    if (tool.effect !== READ_ONLY_EFFECT) {
      return rejectInvocation(new DeclarativeExecutionError(
        "WRITE_TOOL_NOT_ALLOWED",
        `Tool '${toolName}' has effect '${tool.effect}' and cannot run in the read-only executor.`,
        { path: `toolRegistry.${toolName}.effect`, details: { effect: tool.effect } }
      ), context);
    }

    const schema = schemas[toolName];
    if (!schema) {
      return rejectInvocation(new DeclarativeExecutionError(
        "TOOL_SCHEMA_NOT_VALIDATED",
        `Tool '${toolName}' has no schema in the validated runtime capability registry.`,
        { path: `$runtimeCapabilities.${toolName}.input_schema` }
      ), context);
    }
    let safeArguments;
    try {
      safeArguments = deepFreeze(cloneJson(rawArguments, "$arguments"));
      validateArgumentsAgainstSchema(safeArguments, schema);
    } catch (error) {
      const structured = error instanceof DeclarativeExecutionError
        ? error
        : new DeclarativeExecutionError("INVALID_ARGUMENTS", "Tool arguments failed validation.", {
            phase: "arguments",
            path: "$arguments",
            cause: error
          });
      return rejectInvocation(structured, context);
    }

    try {
      assertExecutionActive(activeExecution);
      consumeInvocation(activeExecution, context);
    } catch (error) {
      if (error.code === "TIMEOUT") {
        emit("tool.timed_out", { ...context, details: { timeoutMs: executionTimeoutMs } });
        stats.timedOut += 1;
      }
      return rejectInvocation(error, context);
    }

    const remainingSessionMs = activeExecution.deadlineAt - now();
    if (remainingSessionMs <= 0) {
      const error = timeoutError("Execution time budget expired before the tool could start.");
      activeExecution.abortController.abort();
      emit("tool.timed_out", { ...context, details: { timeoutMs: executionTimeoutMs } });
      stats.timedOut += 1;
      return rejectInvocation(error, context);
    }

    const descriptorTimeout = Number.isInteger(tool.timeoutMs) && tool.timeoutMs > 0
      ? tool.timeoutMs
      : executionTimeoutMs;
    const timeoutMs = Math.min(remainingSessionMs, descriptorTimeout);
    const startedAt = now();
    stats.invocations += 1;
    stats.active += 1;
    activeExecution.activeInvocations += 1;
    emit("invocation.started", { ...context, details: { invocationNumber: stats.invocations } });
    emit("arguments.validated", { ...context, details: { argumentNames: Object.keys(safeArguments) } });
    emit("tool.started", { ...context, details: { effect: tool.effect, timeoutMs } });

    let timerId;
    let timeoutTriggered = false;
    const handlerPromise = Promise.resolve().then(() => tool.handler(safeArguments, {
      signal: activeExecution.abortController.signal,
      invocationId,
      agentName,
      toolName,
      executionContext: snapshotExecution(activeExecution)
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimer(() => {
        timeoutTriggered = true;
        activeExecution.abortController.abort();
        reject(new DeclarativeExecutionError(
          "TIMEOUT",
          `Tool '${toolName}' exceeded its ${timeoutMs}ms execution budget.`,
          { phase: "timeout", path: `toolRegistry.${toolName}`, details: { timeoutMs } }
        ));
      }, timeoutMs);
    });

    try {
      const output = await Promise.race([handlerPromise, timeoutPromise]);
      const safeOutput = deepFreeze(cloneJson(output, "$result.output"));
      stats.completed += 1;
      const durationMs = Math.max(0, now() - startedAt);
      emit("tool.succeeded", { ...context, details: { durationMs } });
      return deepFreeze({
        status: "success",
        invocationId,
        agentName,
        toolName,
        output: safeOutput,
        durationMs
      });
    } catch (error) {
      if (timeoutTriggered || (error instanceof DeclarativeExecutionError && error.code === "TIMEOUT")) {
        stats.timedOut += 1;
        emit("tool.timed_out", { ...context, details: { timeoutMs } });
        throw error instanceof DeclarativeExecutionError
          ? error
          : new DeclarativeExecutionError("TIMEOUT", `Tool '${toolName}' timed out.`, {
              phase: "timeout",
              path: `toolRegistry.${toolName}`,
              cause: error
            });
      }
      stats.failed += 1;
      const structured = new DeclarativeExecutionError(
        "HANDLER_FAILED",
        `Tool '${toolName}' failed without producing a successful result.`,
        {
          phase: "handler",
          path: `toolRegistry.${toolName}.handler`,
          details: { errorName: error?.name || "Error" },
          cause: error
        }
      );
      emit("tool.failed", { ...context, details: { code: structured.code } });
      throw structured;
    } finally {
      clearTimer(timerId);
      stats.active = Math.max(0, stats.active - 1);
      activeExecution.activeInvocations = Math.max(0, activeExecution.activeInvocations - 1);
    }
  }

  function dispatch(request) {
    return dispatchInternal(request);
  }

  function delegationError(execution, code, message, path, details) {
    const error = new DeclarativeExecutionError(code, message, {
      phase: "delegation",
      path,
      details
    });
    emit("delegation.rejected", {
      execution,
      agentName: execution.currentAgent,
      details: { code, path, ...details }
    });
    throw error;
  }

  function startAgent(execution, agentName) {
    assertExecutionActive(execution);
    consumeInvocation(execution, { agentName });
    execution.agentChain.push(agentName);
    execution.currentAgent = agentName;
    emit("agent.started", {
      execution,
      agentName,
      details: {
        agentChain: [...execution.agentChain],
        invocationsConsumed: execution.invocationsConsumed,
        budgetRemaining: maxInvocations - execution.invocationsConsumed
      }
    });
  }

  function delegateAgent(execution, targetAgentName) {
    const sourceAgentName = execution.currentAgent;
    const sourceAgent = agents.get(sourceAgentName);
    if (!agents.has(targetAgentName)) {
      delegationError(
        execution,
        "AGENT_NOT_FOUND",
        `Delegated agent '${String(targetAgentName)}' is not defined in the validated network.`,
        "delegateAgent",
        { sourceAgent: sourceAgentName, targetAgent: targetAgentName }
      );
    }
    if (!sourceAgent.tools.includes(targetAgentName)) {
      delegationError(
        execution,
        "DELEGATION_NOT_AUTHORIZED",
        `Agent '${sourceAgentName}' is not authorized to delegate to '${targetAgentName}'.`,
        `$network.tools.${sourceAgentName}.tools`,
        { sourceAgent: sourceAgentName, targetAgent: targetAgentName }
      );
    }
    if (execution.agentChain.includes(targetAgentName)) {
      delegationError(
        execution,
        "DELEGATION_CYCLE",
        `Delegation to '${targetAgentName}' would create an agent cycle.`,
        "agent_chain",
        { agentChain: [...execution.agentChain], targetAgent: targetAgentName }
      );
    }
    const nextDepth = execution.agentChain.length;
    if (nextDepth > maxDepth) {
      delegationError(
        execution,
        "MAX_DEPTH_EXCEEDED",
        `Delegation depth ${nextDepth} exceeds the declared maximum ${maxDepth}.`,
        "$network.metadata.execution_limits.max_composition_depth",
        { maxDepth, attemptedDepth: nextDepth }
      );
    }
    try {
      assertExecutionActive(execution);
      consumeInvocation(execution, { agentName: sourceAgentName });
    } catch (error) {
      emit("delegation.rejected", {
        execution,
        agentName: sourceAgentName,
        details: { code: error.code, targetAgent: targetAgentName }
      });
      throw error;
    }
    emit("agent.delegated", {
      execution,
      agentName: sourceAgentName,
      details: { fromAgent: sourceAgentName, toAgent: targetAgentName }
    });
    execution.agentChain.push(targetAgentName);
    execution.currentAgent = targetAgentName;
    emit("agent.started", {
      execution,
      agentName: targetAgentName,
      details: {
        agentChain: [...execution.agentChain],
        invocationsConsumed: execution.invocationsConsumed,
        budgetRemaining: maxInvocations - execution.invocationsConsumed
      }
    });
  }

  async function executeDelegationPath({ agentPath, toolName, arguments: argumentsValue = {} } = {}) {
    if (!Array.isArray(agentPath) || agentPath.length === 0 || agentPath.some((name) => typeof name !== "string" || name.trim() === "")) {
      throw new DeclarativeExecutionError(
        "INVALID_DELEGATION_PATH",
        "agentPath must be a non-empty array of exact agent names.",
        { phase: "delegation", path: "agentPath" }
      );
    }
    const execution = createExecutionContext();
    const startedAgents = [];
    try {
      const frontAgentName = validatedNetwork.validation.frontMan;
      startAgent(execution, frontAgentName);
      startedAgents.push(frontAgentName);
      for (const targetAgentName of agentPath) {
        delegateAgent(execution, targetAgentName);
        startedAgents.push(targetAgentName);
      }

      const toolResult = await dispatchInternal({
        agentName: execution.currentAgent,
        toolName,
        arguments: argumentsValue
      }, execution);

      for (let index = startedAgents.length - 1; index >= 0; index -= 1) {
        const agentName = startedAgents[index];
        execution.currentAgent = agentName;
        emit("agent.completed", {
          execution,
          agentName,
          details: {
            returnedFrom: index + 1 < startedAgents.length ? startedAgents[index + 1] : toolName
          }
        });
      }
      execution.currentAgent = null;
      return Object.freeze({
        status: "success",
        executionId: execution.executionId,
        frontAgent: validatedNetwork.validation.frontMan,
        delegatedAgent: startedAgents.at(-1),
        agentChain: Object.freeze([...startedAgents]),
        toolResult,
        context: snapshotExecution(execution)
      });
    } catch (error) {
      for (let index = startedAgents.length - 1; index >= 0; index -= 1) {
        const agentName = startedAgents[index];
        execution.currentAgent = agentName;
        emit("agent.failed", {
          execution,
          agentName,
          details: { code: error?.code || "UNEXPECTED_EXECUTION_ERROR" }
        });
      }
      execution.currentAgent = null;
      throw error;
    }
  }

  function executeVoltEdgeDiagnostic() {
    return executeDelegationPath({
      agentPath: ["State_Form_Specialist"],
      toolName: "getPageState",
      arguments: {}
    });
  }

  function executeFrontTool(toolName, argumentsValue = {}) {
    return dispatch({
      agentName: validatedNetwork.validation.frontMan,
      toolName,
      arguments: argumentsValue
    });
  }

  function getTrace() {
    return Object.freeze([...trace]);
  }

  function getExecutionContext(executionId) {
    const execution = executions.get(executionId);
    return execution ? snapshotExecution(execution) : null;
  }

  function getState() {
    return deepFreeze({
      networkName: validatedNetwork.selectedNetwork,
      frontAgent: validatedNetwork.validation.frontMan,
      limits: { maxDepth, maxInvocations, timeoutMs: executionTimeoutMs },
      stats: { ...stats },
      sessionStartedAt
    });
  }

  return Object.freeze({
    networkName: validatedNetwork.selectedNetwork,
    frontAgent: validatedNetwork.validation.frontMan,
    dispatch,
    executeFrontTool,
    executeDelegationPath,
    executeVoltEdgeDiagnostic,
    getTrace,
    getExecutionContext,
    getState
  });
}
