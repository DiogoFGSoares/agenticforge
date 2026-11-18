import {
  DeclarativeLoadError,
  loadAndValidateLocalNetwork
} from "./declarative-loader.mjs";
import {
  DeclarativeExecutionError,
  createDeclarativeExecutor,
  createVoltEdgeToolRegistry
} from "./declarative-executor.mjs";
import { createSafePreviewController } from "./safe-preview.mjs";
import { createLlmAdapter } from "./llm-adapter.mjs";

const safePreview = typeof document === "undefined" || typeof document.createElement !== "function"
  ? null
  : createSafePreviewController({ ownerDocument: document });
globalThis.AgenticForgeSafePreview = safePreview;
const inference = typeof globalThis.fetch === "function"
  ? createLlmAdapter({ fetchImpl: globalThis.fetch.bind(globalThis) })
  : null;

const state = {
  status: "idle",
  result: null,
  error: null,
  executorStatus: "idle",
  executorError: null
};

function waitForDocumentReady() {
  if (typeof document === "undefined" || document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

async function initializeVoltEdgeExecutor(result) {
  if (typeof document === "undefined") return null;
  await waitForDocumentReady();
  const root = document.querySelector("#authorizedVoltEdgeHost > #techStoreRoot");
  const toolRegistry = createVoltEdgeToolRegistry({ root });
  return createDeclarativeExecutor({ validatedNetwork: result, toolRegistry });
}

async function load(options = {}) {
  state.status = "loading";
  state.result = null;
  state.error = null;
  state.executorStatus = "loading";
  state.executorError = null;
  runtime.executor = null;

  try {
    const result = await loadAndValidateLocalNetwork({
      manifestUrl: "./agent-manifest.json",
      networkName: "voltedge_hardware_store",
      baseUrl: globalThis.location?.href || import.meta.url,
      ...options
    });
    try {
      runtime.executor = await initializeVoltEdgeExecutor(result);
      state.executorStatus = runtime.executor ? "ready" : "unavailable";
      if (runtime.executor) {
        globalThis.dispatchEvent?.(new CustomEvent("agenticforge:executor-ready", {
          detail: runtime.executor.getState()
        }));
      }
    } catch (executorError) {
      const structuredExecutorError = executorError instanceof DeclarativeExecutionError
        ? executorError
        : new DeclarativeExecutionError("EXECUTOR_INITIALIZATION_FAILED", "Executor initialization failed.", {
            phase: "bootstrap",
            cause: executorError
          });
      state.executorStatus = "rejected";
      state.executorError = structuredExecutorError;
      console.error("AgenticForge declarative executor rejected", structuredExecutorError.toJSON());
    }
    state.status = "validated";
    state.result = result;
    globalThis.dispatchEvent?.(new CustomEvent("agenticforge:declarative-ready", { detail: result }));
    return result;
  } catch (error) {
    const structuredError = error instanceof DeclarativeLoadError
      ? error
      : new DeclarativeLoadError("UNEXPECTED_LOADER_ERROR", "Unexpected declarative loader failure.", {
          phase: "bootstrap",
          cause: error
        });
    state.status = "rejected";
    state.error = structuredError;
    console.error("AgenticForge declarative network rejected", structuredError.toJSON());
    globalThis.dispatchEvent?.(
      new CustomEvent("agenticforge:declarative-error", { detail: structuredError.toJSON() })
    );
    throw structuredError;
  }
}

const runtime = {
  state,
  load,
  ready: null,
  executor: null,
  inference,
  diagnostics: Object.freeze({
    getPageState() {
      if (!runtime.executor) {
        return Promise.reject(new DeclarativeExecutionError(
          "EXECUTOR_NOT_READY",
          "The VoltEdge declarative executor is not ready.",
          { phase: "diagnostic", path: "AgenticForgeDeclarativeRuntime.executor" }
        ));
      }
      return runtime.executor.executeFrontTool("getPageState", {});
    },
    getPageStateViaStateForm() {
      if (!runtime.executor) {
        return Promise.reject(new DeclarativeExecutionError(
          "EXECUTOR_NOT_READY",
          "The VoltEdge declarative executor is not ready.",
          { phase: "diagnostic", path: "AgenticForgeDeclarativeRuntime.executor" }
        ));
      }
      return runtime.executor.executeVoltEdgeDiagnostic();
    },
    getTrace() {
      return runtime.executor?.getTrace() || Object.freeze([]);
    },
    infer(request) {
      if (!runtime.inference) {
        return Promise.reject(new Error("The inference adapter is unavailable in this environment."));
      }
      return runtime.inference.infer(request);
    },
    getInferenceTrace() {
      return runtime.inference?.getTrace() || Object.freeze([]);
    }
  })
};

globalThis.AgenticForgeDeclarativeRuntime = runtime;
runtime.ready = load();

// Avoid an unhandled rejection while keeping the rejected promise available to callers.
runtime.ready.catch(() => {});

export { load, runtime, state };
