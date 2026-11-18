import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

const projectRoot = resolve(new URL("../", import.meta.url).pathname);
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);
let leakRequests = 0;
let mockInferenceRequests = 0;
let mockAuthorizationHeader = null;
let mockRequestBody = null;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/leak") {
      leakRequests += 1;
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/mock/v1/chat/completions") {
      mockInferenceRequests += 1;
      mockAuthorizationHeader = request.headers.authorization || null;
      let body = "";
      for await (const chunk of request) body += chunk;
      mockRequestBody = JSON.parse(body);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({
        model: "mock-browser-model",
        choices: [{
          message: {
            role: "assistant",
            content: "TEST_BROWSER_PRIVATE_RESPONSE",
            tool_calls: [{
              id: "browser_call_1",
              type: "function",
              function: { name: "getPageState", arguments: "{}" }
            }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }));
      return;
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = resolve(projectRoot, `.${requestedPath}`);
    if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404);
    response.end("Not found");
  }
});

await new Promise((resolveServer, rejectServer) => {
  server.once("error", rejectServer);
  server.listen(0, "127.0.0.1", resolveServer);
});

const address = server.address();
const profileDirectory = await mkdtemp(`${tmpdir()}/agenticforge-chrome-`);
const pageUrl = `http://127.0.0.1:${address.port}/tests/safe-preview-browser.html`;

try {
  const output = await new Promise((resolveChrome, rejectChrome) => {
    const child = spawn(chromePath, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-sandbox",
      `--user-data-dir=${profileDirectory}`,
      "--virtual-time-budget=10000",
      "--dump-dom",
      pageUrl
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectChrome(new Error("Chrome browser security test timed out."));
    }, 20000);
    child.once("error", rejectChrome);
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectChrome(new Error(`Chrome exited with ${code}: ${stderr.slice(-1000)}`));
        return;
      }
      resolveChrome(stdout);
    });
  });

  const encodedResult = output.match(/id="result" data-result="([^"]+)"/)?.[1];
  assert.ok(encodedResult && encodedResult !== "pending", "Browser harness did not publish a result.");
  const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
  assert.equal(result.error, undefined, result.error || "Browser harness failed.");
  for (const [name, passed] of Object.entries(result)) {
    assert.equal(passed, true, `Browser security assertion failed: ${name}`);
  }
  assert.equal(leakRequests, 0, "Imported HTML caused an unauthorized external request.");
  assert.equal(mockInferenceRequests, 1, "Browser adapter did not call the local mock exactly once.");
  assert.equal(mockAuthorizationHeader, "Bearer TEST_BROWSER_LLM_KEY");
  assert.equal(mockRequestBody.model, "mock-browser-model");
  assert.equal(mockRequestBody.messages[0].content, "TEST_BROWSER_PRIVATE_PROMPT");
  process.stdout.write(`${JSON.stringify({
    ...result,
    unauthorizedExternalRequests: leakRequests,
    localMockInferenceRequests: mockInferenceRequests
  }, null, 2)}\n`);
} finally {
  await new Promise(resolveServer => server.close(resolveServer));
  await rm(profileDirectory, { recursive: true, force: true });
}
