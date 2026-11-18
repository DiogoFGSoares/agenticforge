const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_TIMEOUT_MS = 120_000;
const ALLOWED_ROLES = new Set(["developer", "system", "user", "assistant", "tool"]);
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const CREDENTIAL_QUERY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth|authorization|bearer|credential|password|secret)/i;

export class LlmAdapterError extends Error {
  constructor(code, message, { phase = "inference", path = "$", details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LlmAdapterError";
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
  throw new LlmAdapterError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value, path) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    fail("NON_SERIALIZABLE_INPUT", `${path} must be JSON-serializable.`, { phase: "validation", path, cause });
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertNonEmptyString(value, path, code = "INCOMPLETE_CONFIGURATION") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${path} must be a non-empty string.`, { phase: "validation", path });
  }
  return value.trim();
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function validateLlmEndpoint(endpoint) {
  const value = assertNonEmptyString(endpoint, "$config.endpoint");
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    fail("INVALID_ENDPOINT", "The LLM endpoint must be an absolute HTTPS URL or loopback HTTP URL.", {
      phase: "validation",
      path: "$config.endpoint",
      cause
    });
  }
  if (url.username || url.password || url.hash) {
    fail("INVALID_ENDPOINT", "The LLM endpoint cannot contain credentials or a URL fragment.", {
      phase: "validation",
      path: "$config.endpoint"
    });
  }
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PATTERN.test(name)) {
      fail("CREDENTIAL_IN_URL", "Credentials must not be placed in the LLM endpoint URL.", {
        phase: "validation",
        path: "$config.endpoint"
      });
    }
  }
  const secure = url.protocol === "https:";
  const loopbackDevelopment = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (!secure && !loopbackDevelopment) {
    fail("INVALID_ENDPOINT", "HTTPS is required except for HTTP loopback development endpoints.", {
      phase: "validation",
      path: "$config.endpoint",
      details: { protocol: url.protocol }
    });
  }
  return url;
}

function normalizeConfig(config) {
  if (!isRecord(config)) {
    fail("INCOMPLETE_CONFIGURATION", "LLM configuration is required.", {
      phase: "validation",
      path: "$config"
    });
  }
  const provider = assertNonEmptyString(config.provider, "$config.provider");
  const model = assertNonEmptyString(config.model, "$config.model");
  const endpoint = validateLlmEndpoint(config.endpoint);
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
    fail("INVALID_CONFIGURATION", "$config.apiKey must be a string when provided.", {
      phase: "validation",
      path: "$config.apiKey"
    });
  }
  if (config.requiresApiKey !== undefined && typeof config.requiresApiKey !== "boolean") {
    fail("INVALID_CONFIGURATION", "$config.requiresApiKey must be boolean when provided.", {
      phase: "validation",
      path: "$config.requiresApiKey"
    });
  }
  if (config.requiresApiKey === true && !config.apiKey) {
    fail("MISSING_CREDENTIAL", "The selected inference router requires a BYOK credential.", {
      phase: "validation",
      path: "$config.apiKey"
    });
  }
  return {
    provider,
    model,
    endpoint,
    apiKey: config.apiKey || ""
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    fail("INVALID_MESSAGES", `messages must contain between 1 and ${MAX_MESSAGES} entries.`, {
      phase: "validation",
      path: "$messages"
    });
  }
  let totalCharacters = 0;
  const normalized = messages.map((message, index) => {
    const path = `$messages[${index}]`;
    if (!isRecord(message) || !ALLOWED_ROLES.has(message.role)) {
      fail("INVALID_MESSAGES", `${path}.role is not supported.`, { phase: "validation", path: `${path}.role` });
    }
    if (typeof message.content !== "string") {
      fail("INVALID_MESSAGES", `${path}.content must be a string.`, {
        phase: "validation",
        path: `${path}.content`
      });
    }
    totalCharacters += message.content.length;
    const allowedKeys = new Set(["role", "content", "name", "tool_call_id"]);
    for (const key of Object.keys(message)) {
      if (!allowedKeys.has(key)) {
        fail("INVALID_MESSAGES", `${path}.${key} is not an allowed message field.`, {
          phase: "validation",
          path: `${path}.${key}`
        });
      }
    }
    const result = { role: message.role, content: message.content };
    if (message.name !== undefined) {
      if (typeof message.name !== "string" || !IDENTIFIER_PATTERN.test(message.name)) {
        fail("INVALID_MESSAGES", `${path}.name is invalid.`, { phase: "validation", path: `${path}.name` });
      }
      result.name = message.name;
    }
    if (message.role === "tool") {
      result.tool_call_id = assertNonEmptyString(message.tool_call_id, `${path}.tool_call_id`, "INVALID_MESSAGES");
    } else if (message.tool_call_id !== undefined) {
      fail("INVALID_MESSAGES", `${path}.tool_call_id is only allowed for tool messages.`, {
        phase: "validation",
        path: `${path}.tool_call_id`
      });
    }
    return result;
  });
  if (totalCharacters > MAX_MESSAGE_CHARS) {
    fail("INVALID_MESSAGES", `Total message content exceeds ${MAX_MESSAGE_CHARS} characters.`, {
      phase: "validation",
      path: "$messages"
    });
  }
  return deepFreeze(normalized);
}

function normalizeTools(tools) {
  if (tools === undefined) return Object.freeze([]);
  if (!Array.isArray(tools)) {
    fail("INVALID_TOOLS", "tools must be an array.", { phase: "validation", path: "$tools" });
  }
  const names = new Set();
  const normalized = tools.map((tool, index) => {
    const path = `$tools[${index}]`;
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      fail("INVALID_TOOLS", `${path} must be an OpenAI-compatible function tool definition.`, {
        phase: "validation",
        path
      });
    }
    for (const key of Object.keys(tool)) {
      if (key !== "type" && key !== "function") {
        fail("INVALID_TOOLS", `${path}.${key} is not an allowed tool field.`, {
          phase: "validation",
          path: `${path}.${key}`
        });
      }
    }
    for (const key of Object.keys(tool.function)) {
      if (!["name", "description", "parameters", "strict"].includes(key)) {
        fail("INVALID_TOOLS", `${path}.function.${key} is not an allowed function field.`, {
          phase: "validation",
          path: `${path}.function.${key}`
        });
      }
    }
    const name = tool.function.name;
    if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name) || names.has(name)) {
      fail("INVALID_TOOLS", `${path}.function.name is invalid or duplicated.`, {
        phase: "validation",
        path: `${path}.function.name`
      });
    }
    names.add(name);
    if (tool.function.description !== undefined && typeof tool.function.description !== "string") {
      fail("INVALID_TOOLS", `${path}.function.description must be a string.`, {
        phase: "validation",
        path: `${path}.function.description`
      });
    }
    if (!isRecord(tool.function.parameters)) {
      fail("INVALID_TOOLS", `${path}.function.parameters must be a JSON Schema object.`, {
        phase: "validation",
        path: `${path}.function.parameters`
      });
    }
    if (tool.function.parameters.type !== "object" || !isRecord(tool.function.parameters.properties || {})) {
      fail("INVALID_TOOLS", `${path}.function.parameters must declare an object schema with properties.`, {
        phase: "validation",
        path: `${path}.function.parameters`
      });
    }
    if (tool.function.parameters.required !== undefined) {
      if (!Array.isArray(tool.function.parameters.required)
        || tool.function.parameters.required.some((requiredName) => (
          typeof requiredName !== "string" || !(requiredName in (tool.function.parameters.properties || {}))
        ))) {
        fail("INVALID_TOOLS", `${path}.function.parameters.required is invalid.`, {
          phase: "validation",
          path: `${path}.function.parameters.required`
        });
      }
    }
    if (tool.function.strict !== undefined && typeof tool.function.strict !== "boolean") {
      fail("INVALID_TOOLS", `${path}.function.strict must be boolean.`, {
        phase: "validation",
        path: `${path}.function.strict`
      });
    }
    return cloneJson(tool, path);
  });
  return deepFreeze(normalized);
}

function normalizeToolCalls(toolCalls) {
  if (toolCalls === undefined) return Object.freeze([]);
  if (!Array.isArray(toolCalls)) {
    fail("INVALID_LLM_RESPONSE", "message.tool_calls must be an array.", {
      phase: "response",
      path: "$response.choices[0].message.tool_calls"
    });
  }
  return deepFreeze(toolCalls.map((call, index) => {
    const path = `$response.choices[0].message.tool_calls[${index}]`;
    if (!isRecord(call) || call.type !== "function" || !isRecord(call.function)) {
      fail("INVALID_LLM_RESPONSE", `${path} is malformed.`, { phase: "response", path });
    }
    const id = assertNonEmptyString(call.id, `${path}.id`, "INVALID_LLM_RESPONSE");
    const name = call.function.name;
    if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) {
      fail("INVALID_LLM_RESPONSE", `${path}.function.name is invalid.`, {
        phase: "response",
        path: `${path}.function.name`
      });
    }
    if (typeof call.function.arguments !== "string") {
      fail("INVALID_LLM_RESPONSE", `${path}.function.arguments must be a JSON string.`, {
        phase: "response",
        path: `${path}.function.arguments`
      });
    }
    let parsedArguments;
    try {
      parsedArguments = JSON.parse(call.function.arguments);
    } catch (cause) {
      fail("INVALID_LLM_RESPONSE", `${path}.function.arguments is not valid JSON.`, {
        phase: "response",
        path: `${path}.function.arguments`,
        cause
      });
    }
    if (!isRecord(parsedArguments)) {
      fail("INVALID_LLM_RESPONSE", `${path}.function.arguments must decode to an object.`, {
        phase: "response",
        path: `${path}.function.arguments`
      });
    }
    return {
      id,
      type: "function",
      function: {
        name,
        arguments: deepFreeze(parsedArguments)
      }
    };
  }));
}

function normalizeUsage(usage) {
  if (usage === undefined) return null;
  if (!isRecord(usage)) {
    fail("INVALID_LLM_RESPONSE", "usage must be an object when provided.", {
      phase: "response",
      path: "$response.usage"
    });
  }
  const normalized = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] ) {
    if (usage[key] !== undefined) {
      if (!Number.isInteger(usage[key]) || usage[key] < 0) {
        fail("INVALID_LLM_RESPONSE", `usage.${key} must be a non-negative integer.`, {
          phase: "response",
          path: `$response.usage.${key}`
        });
      }
      normalized[key] = usage[key];
    }
  }
  return deepFreeze(normalized);
}

function normalizeResponse(payload, config) {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    fail("INVALID_LLM_RESPONSE", "The response does not contain a valid choices array.", {
      phase: "response",
      path: "$response.choices"
    });
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || choice.message.role !== "assistant") {
    fail("INVALID_LLM_RESPONSE", "The first choice must contain an assistant message.", {
      phase: "response",
      path: "$response.choices[0].message"
    });
  }
  const toolCalls = normalizeToolCalls(choice.message.tool_calls);
  const content = choice.message.content;
  if (content !== null && typeof content !== "string") {
    fail("INVALID_LLM_RESPONSE", "Assistant content must be a string or null.", {
      phase: "response",
      path: "$response.choices[0].message.content"
    });
  }
  if ((content === null || content === "") && toolCalls.length === 0) {
    fail("INVALID_LLM_RESPONSE", "The assistant response contains neither content nor tool calls.", {
      phase: "response",
      path: "$response.choices[0].message"
    });
  }
  if (choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
    fail("INVALID_LLM_RESPONSE", "finish_reason must be a string or null.", {
      phase: "response",
      path: "$response.choices[0].finish_reason"
    });
  }
  return deepFreeze({
    status: "completed",
    content,
    tool_calls: toolCalls,
    finish_reason: choice.finish_reason ?? null,
    usage: normalizeUsage(payload.usage),
    provider: config.provider,
    model: config.model,
    response_model: typeof payload.model === "string" ? payload.model : null
  });
}

function httpError(response) {
  if (response.status === 401) {
    return new LlmAdapterError("HTTP_UNAUTHORIZED", "The inference router rejected the supplied credential.", {
      phase: "transport", details: { status: 401 }
    });
  }
  if (response.status === 403) {
    return new LlmAdapterError("HTTP_FORBIDDEN", "The inference router denied this request.", {
      phase: "transport", details: { status: 403 }
    });
  }
  if (response.status === 429) {
    return new LlmAdapterError("RATE_LIMITED", "The inference router rate limit was exceeded.", {
      phase: "transport", details: { status: 429 }
    });
  }
  return new LlmAdapterError("HTTP_ERROR", `The inference router returned HTTP ${response.status}.`, {
    phase: "transport", details: { status: response.status }
  });
}

export function createLlmAdapter({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  defaultTimeoutMs = 20_000
} = {}) {
  if (typeof fetchImpl !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    fail("INVALID_ADAPTER_ENVIRONMENT", "The LLM adapter requires fetch and timer functions.", {
      phase: "initialization"
    });
  }
  if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0 || defaultTimeoutMs > MAX_TIMEOUT_MS) {
    fail("INVALID_TIMEOUT", `defaultTimeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`, {
      phase: "initialization", path: "$defaultTimeoutMs"
    });
  }

  const grants = new WeakMap();
  const trace = [];
  let eventSequence = 0;
  let requestSequence = 0;

  function emit(type, details = null) {
    const event = deepFreeze({
      sequence: ++eventSequence,
      type,
      timestamp: new Date(now()).toISOString(),
      details: details === null ? null : cloneJson(details, "$trace.details")
    });
    trace.push(event);
    return event;
  }

  function authorizeDestination({
    endpoint,
    userApproved = false,
    allowCredentials = false,
    allowSensitiveContent = false
  } = {}) {
    const url = validateLlmEndpoint(endpoint);
    if (userApproved !== true) {
      fail("CONSENT_REQUIRED", "Explicit user approval is required for the inference destination.", {
        phase: "authorization",
        path: "$authorization.userApproved"
      });
    }
    const grant = Object.freeze({});
    grants.set(grant, {
      endpoint: url.href,
      allowCredentials: allowCredentials === true,
      allowSensitiveContent: allowSensitiveContent === true,
      consumed: false
    });
    emit("destination.authorized", {
      origin: url.origin,
      path: url.pathname,
      allowCredentials: allowCredentials === true,
      allowSensitiveContent: allowSensitiveContent === true
    });
    return grant;
  }

  async function infer({
    config,
    messages,
    tools,
    authorization,
    sensitive = false,
    timeoutMs = defaultTimeoutMs,
    maxTokens = null,
    signal = null
  } = {}) {
    const normalizedConfig = normalizeConfig(config);
    const normalizedMessages = normalizeMessages(messages);
    const normalizedTools = normalizeTools(tools);
    if (typeof sensitive !== "boolean") {
      fail("INVALID_REQUEST", "sensitive must be boolean.", { phase: "validation", path: "$sensitive" });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      fail("INVALID_TIMEOUT", `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`, {
        phase: "validation", path: "$timeoutMs"
      });
    }
    if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 4096)) {
      fail("INVALID_REQUEST", "maxTokens must be null or an integer between 1 and 4096.", {
        phase: "validation",
        path: "$maxTokens"
      });
    }
    if (signal !== null && !(signal instanceof AbortSignal)) {
      fail("INVALID_ABORT_SIGNAL", "signal must be an AbortSignal.", {
        phase: "validation", path: "$signal"
      });
    }

    const grant = grants.get(authorization);
    if (!grant || grant.consumed || grant.endpoint !== normalizedConfig.endpoint.href) {
      fail("DESTINATION_NOT_AUTHORIZED", "A valid unused authorization for this exact endpoint is required.", {
        phase: "authorization", path: "$authorization"
      });
    }
    if (normalizedConfig.apiKey && !grant.allowCredentials) {
      fail("CREDENTIAL_NOT_AUTHORIZED", "The destination grant does not authorize credential disclosure.", {
        phase: "authorization", path: "$authorization.allowCredentials"
      });
    }
    if (sensitive && !grant.allowSensitiveContent) {
      fail("SENSITIVE_CONTENT_NOT_AUTHORIZED", "The destination grant does not authorize sensitive content.", {
        phase: "authorization", path: "$authorization.allowSensitiveContent"
      });
    }
    if (signal?.aborted) {
      fail("CANCELLED", "The inference request was cancelled before contact.", {
        phase: "cancellation", path: "$signal"
      });
    }
    grant.consumed = true;

    const requestId = `llm_${++requestSequence}`;
    const traceContext = {
      requestId,
      provider: normalizedConfig.provider,
      model: normalizedConfig.model,
      origin: normalizedConfig.endpoint.origin,
      path: normalizedConfig.endpoint.pathname
    };
    emit("inference.started", {
      ...traceContext,
      messageCount: normalizedMessages.length,
      toolDefinitionCount: normalizedTools.length,
      credentialAttached: Boolean(normalizedConfig.apiKey),
      sensitive
    });

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    let rejectCancellation;
    const cancellationPromise = new Promise((_, reject) => {
      rejectCancellation = reject;
    });
    const onExternalAbort = () => {
      cancelled = true;
      controller.abort();
      rejectCancellation(new LlmAdapterError("CANCELLED", "Inference was cancelled.", {
        phase: "cancellation"
      }));
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timerId = setTimer(() => {
      timedOut = true;
      controller.abort();
      rejectCancellation(new LlmAdapterError("TIMEOUT", `Inference exceeded the ${timeoutMs}ms timeout.`, {
        phase: "timeout", details: { timeoutMs }
      }));
    }, timeoutMs);

    try {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (normalizedConfig.apiKey) headers.Authorization = `Bearer ${normalizedConfig.apiKey}`;
      const body = {
        model: normalizedConfig.model,
        messages: normalizedMessages
      };
      if (normalizedTools.length > 0) body.tools = normalizedTools;
      if (maxTokens !== null) body.max_tokens = maxTokens;

      let response;
      try {
        response = await Promise.race([fetchImpl(normalizedConfig.endpoint.href, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          credentials: "omit",
          cache: "no-store",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        }), cancellationPromise]);
      } catch (cause) {
        if (timedOut) throw new LlmAdapterError("TIMEOUT", `Inference exceeded the ${timeoutMs}ms timeout.`, {
          phase: "timeout", details: { timeoutMs }, cause
        });
        if (cancelled || signal?.aborted) throw new LlmAdapterError("CANCELLED", "Inference was cancelled.", {
          phase: "cancellation", cause
        });
        throw new LlmAdapterError("NETWORK_OR_CORS_ERROR", "Inference failed due to a network or browser CORS error.", {
          phase: "transport", cause
        });
      }

      if (!response || typeof response.status !== "number") {
        throw new LlmAdapterError("INVALID_TRANSPORT_RESPONSE", "The inference transport returned an invalid response object.", {
          phase: "transport"
        });
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new LlmAdapterError("REDIRECT_NOT_AUTHORIZED", "Inference redirects are not followed without a new destination authorization.", {
          phase: "authorization", details: { status: response.status }
        });
      }
      if (response.ok !== true) throw httpError(response);

      emit("inference.http_response", { ...traceContext, status: response.status });
      let responseText;
      try {
        responseText = await Promise.race([response.text(), cancellationPromise]);
      } catch (cause) {
        if (timedOut) throw new LlmAdapterError("TIMEOUT", `Inference exceeded the ${timeoutMs}ms timeout.`, {
          phase: "timeout", details: { timeoutMs }, cause
        });
        if (cancelled || signal?.aborted) throw new LlmAdapterError("CANCELLED", "Inference was cancelled.", {
          phase: "cancellation", cause
        });
        throw new LlmAdapterError("NETWORK_OR_CORS_ERROR", "The response body failed due to a network or CORS error.", {
          phase: "transport", cause
        });
      }
      if (responseText.length > MAX_RESPONSE_BYTES) {
        throw new LlmAdapterError("RESPONSE_TOO_LARGE", `Inference response exceeds ${MAX_RESPONSE_BYTES} bytes.`, {
          phase: "response"
        });
      }
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch (cause) {
        throw new LlmAdapterError("INVALID_JSON_RESPONSE", "The inference response is not valid JSON.", {
          phase: "response", cause
        });
      }
      const result = normalizeResponse(payload, normalizedConfig);
      emit("inference.completed", {
        ...traceContext,
        finishReason: result.finish_reason,
        toolCallCount: result.tool_calls.length,
        usagePresent: result.usage !== null
      });
      return result;
    } catch (error) {
      const structured = error instanceof LlmAdapterError
        ? error
        : new LlmAdapterError("UNEXPECTED_INFERENCE_ERROR", "Inference failed unexpectedly.", {
            phase: "inference", cause: error
          });
      emit("inference.failed", { ...traceContext, code: structured.code });
      throw structured;
    } finally {
      clearTimer(timerId);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function getTrace() {
    return Object.freeze([...trace]);
  }

  return Object.freeze({ authorizeDestination, infer, getTrace });
}
