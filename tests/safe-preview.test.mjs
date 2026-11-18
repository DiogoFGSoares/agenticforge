import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SAFE_PREVIEW_CSP,
  buildSafePreviewDocument
} from "../runtime/safe-preview.mjs";

test("safe preview policy denies scripts, network, frames, forms, objects, and base URLs", () => {
  for (const directive of [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ]) {
    assert.equal(SAFE_PREVIEW_CSP.includes(directive), true, `Missing CSP directive: ${directive}`);
  }
});

test("safe preview document installs CSP before the isolated body", () => {
  const documentText = buildSafePreviewDocument("<p>Benign preview</p>");
  const policyPosition = documentText.indexOf("Content-Security-Policy");
  const bodyPosition = documentText.indexOf("<body>");
  assert.ok(policyPosition > 0);
  assert.ok(bodyPosition > policyPosition);
  assert.equal(documentText.includes("<p>Benign preview</p>"), true);
});

test("the Meta-IDE no longer inserts raw target HTML into its privileged preview container", async () => {
  const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(indexHtml.includes("previewWrap.innerHTML = rawHtml"), false);
  assert.equal(indexHtml.includes('id="authorizedVoltEdgeHost"'), true);
  assert.equal(indexHtml.includes('id="untrustedPreviewHost"'), true);
});
