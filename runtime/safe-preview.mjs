const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const BLOCKED_ELEMENTS = new Set([
  "base",
  "applet",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "portal",
  "script",
  "style"
]);
const BLOCKED_ATTRIBUTES = new Set([
  "action",
  "archive",
  "background",
  "cite",
  "codebase",
  "data",
  "formaction",
  "href",
  "manifest",
  "longdesc",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "target",
  "xlink:href"
]);
const UNSAFE_STYLE_PATTERN = /(?:url\s*\(|@import|expression\s*\(|-moz-binding)/i;
const PREPARED_RESULTS = new WeakSet();

export const SAFE_PREVIEW_CSP = Object.freeze([
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "style-src 'unsafe-inline'"
].join("; "));

const PREVIEW_STYLE = `
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 12px; background: #f8fafc; color: #0f172a; font-size: 12px; }
  h1, h2, h3 { margin: 0 0 6px; }
  p { margin: 0 0 8px; color: #475569; }
  label { display: block; margin: 5px 0 3px; font-weight: 600; color: #334155; }
  input, select, textarea { box-sizing: border-box; width: 100%; margin-bottom: 8px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 5px; background: white; color: #0f172a; }
  button { margin: 4px 6px 0 0; padding: 6px 12px; border: 0; border-radius: 5px; background: #2563eb; color: white; font-weight: 600; }
  .danger-btn { background: #dc2626; }
  .preview-state-banner { margin-top: 8px; padding: 7px 10px; border-left: 3px solid #0284c7; border-radius: 4px; background: #e0f2fe; color: #0369a1; font-weight: 600; }
  [data-af-node="safe"] { outline: 2px dashed #0ea5e9; outline-offset: 2px; }
  [data-af-node="hitl"] { outline: 2px dashed #ef4444; outline-offset: 2px; }
`;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertDocumentApi(ownerDocument) {
  if (!ownerDocument || typeof ownerDocument.createElement !== "function") {
    throw new TypeError("A browser Document is required to prepare an imported HTML preview.");
  }
}

function sanitizeTemplateContent(template) {
  const report = {
    removedElements: 0,
    removedAttributes: 0,
    removedEventHandlers: 0,
    removedUrls: 0,
    removedActiveNamespaces: 0
  };
  const elements = [...template.content.querySelectorAll("*")];

  for (const element of elements) {
    const tagName = String(element.localName || "").toLowerCase();
    if (element.namespaceURI !== HTML_NAMESPACE) {
      report.removedElements += 1;
      report.removedActiveNamespaces += 1;
      element.remove();
      continue;
    }
    if (BLOCKED_ELEMENTS.has(tagName)) {
      report.removedElements += 1;
      element.remove();
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        report.removedAttributes += 1;
        report.removedEventHandlers += 1;
        continue;
      }
      if (BLOCKED_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
        report.removedAttributes += 1;
        report.removedUrls += 1;
        continue;
      }
      if (name === "style" && UNSAFE_STYLE_PATTERN.test(attribute.value)) {
        element.removeAttribute(attribute.name);
        report.removedAttributes += 1;
      }
    }
  }

  return Object.freeze(report);
}

export function prepareImportedHtml(rawHtml, { ownerDocument = globalThis.document } = {}) {
  assertDocumentApi(ownerDocument);
  const template = ownerDocument.createElement("template");
  template.innerHTML = String(rawHtml ?? "");
  const report = sanitizeTemplateContent(template);
  const container = ownerDocument.createElement("div");
  container.append(template.content.cloneNode(true));
  const prepared = Object.freeze({
    sanitizedHtml: container.innerHTML,
    report
  });
  PREPARED_RESULTS.add(prepared);
  return prepared;
}

export function buildSafePreviewDocument(sanitizedHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(SAFE_PREVIEW_CSP)}">
  <meta name="referrer" content="no-referrer">
  <style>${PREVIEW_STYLE}</style>
</head>
<body>${String(sanitizedHtml ?? "")}</body>
</html>`;
}

export function createSafePreviewController({ ownerDocument = globalThis.document } = {}) {
  assertDocumentApi(ownerDocument);

  function render(container, preparedOrRawHtml) {
    if (!container || typeof container.replaceChildren !== "function") {
      throw new TypeError("A preview container Element is required.");
    }
    const prepared = preparedOrRawHtml && PREPARED_RESULTS.has(preparedOrRawHtml)
      ? preparedOrRawHtml
      : prepareImportedHtml(preparedOrRawHtml, { ownerDocument });
    const frame = ownerDocument.createElement("iframe");
    frame.id = "untrustedPreviewFrame";
    frame.title = "Isolated preview of imported untrusted HTML";
    frame.className = "untrusted-preview-frame";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("allow", "");
    frame.setAttribute("credentialless", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = buildSafePreviewDocument(prepared.sanitizedHtml);
    container.replaceChildren(frame);
    return Object.freeze({ frame, prepared });
  }

  return Object.freeze({
    prepare(rawHtml) {
      return prepareImportedHtml(rawHtml, { ownerDocument });
    },
    render
  });
}
