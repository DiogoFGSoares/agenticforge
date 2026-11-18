import test from "node:test";
import assert from "node:assert/strict";

import {
  LlmAdapterError,
  createLlmAdapter,
  validateLlmEndpoint
} from "../runtime/llm-adapter.mjs";

const ENDPOINT = "https://router.example/v1/chat/completions";

function config(overrides = {}) {
  return {
    provider: "mock-openai",
    endpoint: ENDPOINT,
    model: "mock-model-1",
    apiKey: "",
    ...overrides
  };
}

function response(body, status = 200, { type = "basic" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

function textPayload(content = "Hello from mock") {
  return {
    id: "chatcmpl_mock",
    object: "chat.completion",
    model: "mock-response-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
  };
}

function approval(adapter, overrides = {}) {
  return adapter.authorizeDestination({
    endpoint: ENDPOINT,
    userApproved: true,
    allowCredentials: false,
    allowSensitiveContent: false,
    ...overrides
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LlmAdapterError);
    assert.equal(error.code, code);
    return true;
  });
}

test("normalizes a valid textual Chat Completions response", async () => {
  let observed;
  const adapter = createLlmAdapter({
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return response(textPayload());
    }
  });

  const result = await adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Say hello" }],
    authorization: approval(adapter)
  });

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Hello from mock");
  assert.deepEqual(result.tool_calls, []);
  assert.equal(result.finish_reason, "stop");
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
  assert.equal(result.provider, "mock-openai");
  assert.equal(result.model, "mock-model-1");
  assert.equal(result.response_model, "mock-response-model");
  assert.equal(observed.url, ENDPOINT);
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.credentials, "omit");
  assert.equal(observed.options.redirect, "manual");
  assert.equal(observed.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(observed.options.body), {
    model: "mock-model-1",
    messages: [{ role: "user", content: "Say hello" }]
  });
});

test("parses tool calls as inert data without executing a handler", async () => {
  let handlerCalls = 0;
  const adapter = createLlmAdapter({
    fetchImpl: async () => response({
      model: "mock-model-1",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "getPageState", arguments: "{\"detail\":\"summary\"}" }
          }]
        },
        finish_reason: "tool_calls"
      }]
    })
  });

  const result = await adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Inspect state" }],
    tools: [{
      type: "function",
      function: {
        name: "getPageState",
        description: "Read state",
        parameters: { type: "object", properties: {} },
        handler() { handlerCalls += 1; }
      }
    }].map(({ function: { handler: _handler, ...definition }, ...tool }) => ({
      ...tool,
      function: definition
    })),
    authorization: approval(adapter)
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(result.tool_calls, [{
    id: "call_1",
    type: "function",
    function: { name: "getPageState", arguments: { detail: "summary" } }
  }]);
  assert.equal("execute" in result.tool_calls[0], false);
});

test("rejects a malformed successful response", async () => {
  const adapter = createLlmAdapter({ fetchImpl: async () => response({ choices: [] }) });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter)
  }), "INVALID_LLM_RESPONSE");
});

test("rejects an endpoint without an exact destination grant before fetch", async () => {
  let fetchCalls = 0;
  const adapter = createLlmAdapter({ fetchImpl: async () => {
    fetchCalls += 1;
    return response(textPayload());
  } });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: null
  }), "DESTINATION_NOT_AUTHORIZED");
  assert.equal(fetchCalls, 0);
});

test("rejects incomplete configuration before fetch", async () => {
  let fetchCalls = 0;
  const adapter = createLlmAdapter({ fetchImpl: async () => {
    fetchCalls += 1;
    return response(textPayload());
  } });
  await expectCode(adapter.infer({
    config: config({ endpoint: "" }),
    messages: [{ role: "user", content: "Hello" }],
    authorization: null
  }), "INCOMPLETE_CONFIGURATION");
  assert.equal(fetchCalls, 0);
});

for (const [status, code] of [
  [401, "HTTP_UNAUTHORIZED"],
  [403, "HTTP_FORBIDDEN"],
  [429, "RATE_LIMITED"],
  [500, "HTTP_ERROR"]
]) {
  test(`maps HTTP ${status} to ${code} without trusting the body`, async () => {
    const adapter = createLlmAdapter({
      fetchImpl: async () => response({ error: { message: "provider-private-error" } }, status)
    });
    await expectCode(adapter.infer({
      config: config(),
      messages: [{ role: "user", content: "Hello" }],
      authorization: approval(adapter)
    }), code);
    assert.equal(JSON.stringify(adapter.getTrace()).includes("provider-private-error"), false);
  });
}

test("reports network or CORS failure explicitly", async () => {
  const adapter = createLlmAdapter({
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); }
  });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter)
  }), "NETWORK_OR_CORS_ERROR");
});

test("enforces a finite timeout even when the transport ignores AbortSignal", async () => {
  const adapter = createLlmAdapter({
    fetchImpl: async () => new Promise(() => {})
  });
  const startedAt = Date.now();
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter),
    timeoutMs: 10
  }), "TIMEOUT");
  assert.ok(Date.now() - startedAt < 250);
});

test("does not emit a late completion after timeout", async () => {
  const adapter = createLlmAdapter({
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return response(textPayload("late-private-response"));
    }
  });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter),
    timeoutMs: 10
  }), "TIMEOUT");
  const traceLengthAtTimeout = adapter.getTrace().length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(adapter.getTrace().length, traceLengthAtTimeout);
  assert.equal(adapter.getTrace().some((event) => event.type === "inference.completed"), false);
});

test("propagates caller cancellation through AbortSignal", async () => {
  const adapter = createLlmAdapter({
    fetchImpl: async () => new Promise(() => {})
  });
  const controller = new AbortController();
  const promise = adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter),
    signal: controller.signal
  });
  controller.abort();
  await expectCode(promise, "CANCELLED");
});

test("never includes credentials, prompts, or private responses in technical traces and errors", async () => {
  const secret = "UNIT_TEST_BYOK_SECRET_DO_NOT_LOG";
  const privatePrompt = "UNIT_TEST_PRIVATE_PROMPT_DO_NOT_LOG";
  const privateResponse = "UNIT_TEST_PRIVATE_RESPONSE_DO_NOT_LOG";
  let authorizationHeader;
  const adapter = createLlmAdapter({
    fetchImpl: async (_url, options) => {
      authorizationHeader = options.headers.Authorization;
      return response(textPayload(privateResponse));
    }
  });
  const result = await adapter.infer({
    config: config({ apiKey: secret }),
    messages: [{ role: "user", content: privatePrompt }],
    authorization: approval(adapter, { allowCredentials: true })
  });

  assert.equal(authorizationHeader, `Bearer ${secret}`);
  assert.equal(result.content, privateResponse);
  const serializedTrace = JSON.stringify(adapter.getTrace());
  assert.equal(serializedTrace.includes(secret), false);
  assert.equal(serializedTrace.includes(privatePrompt), false);
  assert.equal(serializedTrace.includes(privateResponse), false);
  assert.equal(serializedTrace.includes("prompt_tokens"), false);
});

test("requires separate authorization for credentials and sensitive content", async () => {
  const adapter = createLlmAdapter({ fetchImpl: async () => response(textPayload()) });
  await expectCode(adapter.infer({
    config: config({ apiKey: "credential" }),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter)
  }), "CREDENTIAL_NOT_AUTHORIZED");

  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Sensitive" }],
    authorization: approval(adapter),
    sensitive: true
  }), "SENSITIVE_CONTENT_NOT_AUTHORIZED");
});

test("rejects private-context fields and executable handler fields instead of transmitting them", async () => {
  let fetchCalls = 0;
  const adapter = createLlmAdapter({ fetchImpl: async () => {
    fetchCalls += 1;
    return response(textPayload());
  } });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello", sly_data: { credential: "hidden" } }],
    authorization: approval(adapter)
  }), "INVALID_MESSAGES");

  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    tools: [{
      type: "function",
      function: {
        name: "unsafeTool",
        parameters: { type: "object", properties: {} },
        handler: "do-not-send"
      }
    }],
    authorization: approval(adapter)
  }), "INVALID_TOOLS");
  assert.equal(fetchCalls, 0);
});

test("stops before contact when the selected router declares that a credential is required", async () => {
  let fetchCalls = 0;
  const adapter = createLlmAdapter({ fetchImpl: async () => {
    fetchCalls += 1;
    return response(textPayload());
  } });
  await expectCode(adapter.infer({
    config: config({ requiresApiKey: true }),
    messages: [{ role: "user", content: "Hello" }],
    authorization: null
  }), "MISSING_CREDENTIAL");
  assert.equal(fetchCalls, 0);
});

test("destination grants are exact and single-use", async () => {
  let fetchCalls = 0;
  const adapter = createLlmAdapter({ fetchImpl: async () => {
    fetchCalls += 1;
    return response(textPayload());
  } });
  const grant = approval(adapter);
  await adapter.infer({
    config: config(), messages: [{ role: "user", content: "First" }], authorization: grant
  });
  await expectCode(adapter.infer({
    config: config(), messages: [{ role: "user", content: "Second" }], authorization: grant
  }), "DESTINATION_NOT_AUTHORIZED");
  assert.equal(fetchCalls, 1);
});

test("rejects redirects rather than forwarding authorization to a new destination", async () => {
  const adapter = createLlmAdapter({
    fetchImpl: async () => response("", 302)
  });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter)
  }), "REDIRECT_NOT_AUTHORIZED");
});

test("accepts HTTP only for loopback development and rejects credentials in URLs", () => {
  assert.equal(validateLlmEndpoint("http://127.0.0.1:8080/v1/chat/completions").hostname, "127.0.0.1");
  assert.equal(validateLlmEndpoint("http://[::1]:8080/v1/chat/completions").hostname, "[::1]");
  assert.throws(
    () => validateLlmEndpoint("http://router.example/v1/chat/completions"),
    (error) => error.code === "INVALID_ENDPOINT"
  );
  assert.throws(
    () => validateLlmEndpoint("https://router.example/v1/chat/completions?api_key=secret"),
    (error) => error.code === "CREDENTIAL_IN_URL"
  );
});

test("rejects HTTP 200 with invalid JSON", async () => {
  const adapter = createLlmAdapter({ fetchImpl: async () => response("not-json") });
  await expectCode(adapter.infer({
    config: config(),
    messages: [{ role: "user", content: "Hello" }],
    authorization: approval(adapter)
  }), "INVALID_JSON_RESPONSE");
});
