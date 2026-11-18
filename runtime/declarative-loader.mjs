const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const JSON_MEDIA_PATTERN = /\.json$/i;
const MAX_JSON_BYTES = 1_000_000;
const ALLOWED_EFFECTS = new Set(["read_only", "reversible_write", "irreversible_write"]);
const ALLOWED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "description",
  "title",
  "default",
  "examples",
  "enum",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "items"
]);
const VALIDATED_LOAD_RESULTS = new WeakSet();

export const DEFAULT_RUNTIME_CAPABILITIES = Object.freeze({
  getPageState: Object.freeze({
    input_schema: Object.freeze({
      type: "object",
      properties: Object.freeze({})
    })
  })
});

export class DeclarativeLoadError extends Error {
  constructor(code, message, { phase = "validation", path = "$", details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DeclarativeLoadError";
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
  throw new DeclarativeLoadError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreezeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeJson(child, seen);
  return Object.freeze(value);
}

export function isValidatedLoadResult(value) {
  return isRecord(value) && VALIDATED_LOAD_RESULTS.has(value);
}

function assertRecord(value, path, code = "INVALID_STRUCTURE") {
  if (!isRecord(value)) {
    fail(code, `${path} must be an object.`, { path });
  }
}

function assertNonEmptyString(value, path, code = "INVALID_STRUCTURE") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${path} must be a non-empty string.`, { path });
  }
  return value.trim();
}

function assertIdentifier(value, path, code = "INVALID_IDENTIFIER") {
  const identifier = assertNonEmptyString(value, path, code);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    fail(code, `${path} must contain only letters, numbers, underscores, or hyphens and start with a letter.`, {
      path,
      details: { value: identifier }
    });
  }
  return identifier;
}

function assertUniqueStrings(values, path, code) {
  if (!Array.isArray(values)) {
    fail(code, `${path} must be an array.`, { path });
  }
  const seen = new Set();
  values.forEach((value, index) => {
    const itemPath = `${path}[${index}]`;
    const stringValue = assertNonEmptyString(value, itemPath, code);
    if (seen.has(stringValue)) {
      fail(code, `${itemPath} duplicates '${stringValue}'.`, {
        path: itemPath,
        details: { duplicate: stringValue }
      });
    }
    seen.add(stringValue);
  });
  return seen;
}

function decodePathSegment(segment, path) {
  try {
    return decodeURIComponent(segment);
  } catch (cause) {
    fail("UNSAFE_URL", `${path} contains invalid URL encoding.`, { path, cause });
  }
}

function assertSafeRelativeReference(value, path, { requireJson = false } = {}) {
  const reference = assertNonEmptyString(value, path, "UNSAFE_URL");
  if (
    reference.startsWith("/") ||
    reference.startsWith("\\") ||
    reference.startsWith("//") ||
    reference.includes("\\") ||
    reference.includes("?") ||
    reference.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
  ) {
    fail("UNSAFE_URL", `${path} must be a same-directory relative path without a scheme, query, or fragment.`, {
      path,
      details: { reference }
    });
  }

  for (const rawSegment of reference.split("/")) {
    const segment = decodePathSegment(rawSegment, path);
    if (segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      fail("UNSAFE_URL", `${path} contains a forbidden path segment.`, {
        path,
        details: { reference }
      });
    }
  }

  if (requireJson && !JSON_MEDIA_PATTERN.test(reference)) {
    fail("UNSUPPORTED_ARTIFACT", `${path} must reference a resolved JSON document.`, {
      path,
      details: { reference }
    });
  }

  return reference;
}

function assertHttpProtocol(url, path) {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  fail("UNSAFE_URL", `${path} must use HTTPS (HTTP is allowed only on loopback hosts).`, {
    path,
    details: { url: url.href }
  });
}

function directoryUrl(url) {
  return new URL("./", url);
}

function assertUrlWithinDirectory(url, directory, path) {
  if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname)) {
    fail("UNSAFE_URL", `${path} escapes the authorized local artifact directory.`, {
      path,
      details: { url: url.href, authorizedDirectory: directory.href }
    });
  }
}

function resolveLocalJsonReference(reference, baseUrl, authorizedDirectory, path) {
  const safeReference = assertSafeRelativeReference(reference, path, { requireJson: true });
  const resolved = new URL(safeReference, baseUrl);
  assertHttpProtocol(resolved, path);
  if (resolved.username || resolved.password) {
    fail("UNSAFE_URL", `${path} must not contain credentials.`, { path });
  }
  assertUrlWithinDirectory(resolved, authorizedDirectory, path);
  return resolved;
}

function resolveManifestUrl(manifestUrl, pageUrl) {
  const page = new URL(pageUrl);
  assertHttpProtocol(page, "baseUrl");
  const authorizedDirectory = directoryUrl(page);

  let resolved;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(manifestUrl)) {
    resolved = new URL(manifestUrl);
  } else {
    const safeReference = assertSafeRelativeReference(manifestUrl, "manifestUrl", { requireJson: true });
    resolved = new URL(safeReference, page);
  }

  assertHttpProtocol(resolved, "manifestUrl");
  if (resolved.username || resolved.password) {
    fail("UNSAFE_URL", "manifestUrl must not contain credentials.", { path: "manifestUrl" });
  }
  assertUrlWithinDirectory(resolved, authorizedDirectory, "manifestUrl");
  return { manifestUrl: resolved, authorizedDirectory };
}

function assertJsonValue(value, path) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`));
    return;
  }
  fail("INVALID_SCHEMA", `${path} is not JSON-serializable.`, { path });
}

export function validateJsonSchema(schema, path = "$schema") {
  assertRecord(schema, path, "INVALID_SCHEMA");

  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      fail("INVALID_SCHEMA", `${path}.${key} is not supported by the declarative runtime schema subset.`, {
        path: `${path}.${key}`,
        details: { keyword: key }
      });
    }
  }

  if (!ALLOWED_SCHEMA_TYPES.has(schema.type)) {
    fail("INVALID_SCHEMA", `${path}.type must be a supported JSON Schema type.`, {
      path: `${path}.type`,
      details: { value: schema.type }
    });
  }

  if (schema.description !== undefined && typeof schema.description !== "string") {
    fail("INVALID_SCHEMA", `${path}.description must be a string.`, { path: `${path}.description` });
  }
  if (schema.title !== undefined && typeof schema.title !== "string") {
    fail("INVALID_SCHEMA", `${path}.title must be a string.`, { path: `${path}.title` });
  }
  if (schema.format !== undefined && typeof schema.format !== "string") {
    fail("INVALID_SCHEMA", `${path}.format must be a string.`, { path: `${path}.format` });
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      fail("INVALID_SCHEMA", `${path}.pattern must be a string.`, { path: `${path}.pattern` });
    }
    try {
      new RegExp(schema.pattern);
    } catch (cause) {
      fail("INVALID_SCHEMA", `${path}.pattern is not a valid regular expression.`, {
        path: `${path}.pattern`,
        cause
      });
    }
  }

  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      fail("INVALID_SCHEMA", `${path}.${key} must be a finite number.`, { path: `${path}.${key}` });
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      fail("INVALID_SCHEMA", `${path}.${key} must be a non-negative integer.`, { path: `${path}.${key}` });
    }
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      fail("INVALID_SCHEMA", `${path}.enum must be a non-empty array.`, { path: `${path}.enum` });
    }
    schema.enum.forEach((value, index) => assertJsonValue(value, `${path}.enum[${index}]`));
  }
  if (schema.default !== undefined) assertJsonValue(schema.default, `${path}.default`);
  if (schema.examples !== undefined) {
    if (!Array.isArray(schema.examples)) {
      fail("INVALID_SCHEMA", `${path}.examples must be an array.`, { path: `${path}.examples` });
    }
    schema.examples.forEach((value, index) => assertJsonValue(value, `${path}.examples[${index}]`));
  }

  if (schema.type === "object") {
    if (!isRecord(schema.properties)) {
      fail("INVALID_SCHEMA", `${path}.properties must be an object for object schemas.`, {
        path: `${path}.properties`
      });
    }
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      if (propertyName.trim() === "") {
        fail("INVALID_SCHEMA", `${path}.properties contains an empty property name.`, {
          path: `${path}.properties`
        });
      }
      validateJsonSchema(propertySchema, `${path}.properties.${propertyName}`);
    }
    if (schema.required !== undefined) {
      const required = assertUniqueStrings(schema.required, `${path}.required`, "INVALID_SCHEMA");
      for (const propertyName of required) {
        if (!(propertyName in schema.properties)) {
          fail("INVALID_SCHEMA", `${path}.required references missing property '${propertyName}'.`, {
            path: `${path}.required`,
            details: { propertyName }
          });
        }
      }
    }
  } else if (schema.properties !== undefined || schema.required !== undefined) {
    fail("INVALID_SCHEMA", `${path}.properties and required are only valid for object schemas.`, { path });
  }

  if (schema.type === "array") {
    if (!isRecord(schema.items)) {
      fail("INVALID_SCHEMA", `${path}.items must be a schema object for array schemas.`, {
        path: `${path}.items`
      });
    }
    validateJsonSchema(schema.items, `${path}.items`);
  } else if (schema.items !== undefined) {
    fail("INVALID_SCHEMA", `${path}.items is only valid for array schemas.`, { path: `${path}.items` });
  }

  return schema;
}

function validateAgentParameters(schema, path) {
  validateJsonSchema(schema, path);
  if (schema.type !== "object") {
    fail("INVALID_SCHEMA", `${path} must use type 'object' for Neuro SAN function parameters.`, {
      path: `${path}.type`
    });
  }
}

export function validateManifest(manifest) {
  assertRecord(manifest, "$manifest", "INVALID_MANIFEST");
  assertNonEmptyString(manifest.manifest_version, "$manifest.manifest_version", "INVALID_MANIFEST");
  assertNonEmptyString(manifest.site_name, "$manifest.site_name", "INVALID_MANIFEST");

  if (!Array.isArray(manifest.networks) || manifest.networks.length === 0) {
    fail("INVALID_MANIFEST", "$manifest.networks must be a non-empty array.", {
      path: "$manifest.networks"
    });
  }

  const networkNames = new Set();
  manifest.networks.forEach((entry, index) => {
    const path = `$manifest.networks[${index}]`;
    assertRecord(entry, path, "INVALID_MANIFEST");
    const name = assertIdentifier(entry.name, `${path}.name`, "INVALID_MANIFEST");
    if (networkNames.has(name)) {
      fail("DUPLICATE_NETWORK_NAME", `${path}.name duplicates '${name}'.`, {
        path: `${path}.name`,
        details: { duplicate: name }
      });
    }
    networkNames.add(name);
    assertIdentifier(entry.front_man, `${path}.front_man`, "INVALID_MANIFEST");
    assertSafeRelativeReference(entry.hocon, `${path}.hocon`, { requireJson: true });
    if (entry.links !== undefined) {
      assertSafeRelativeReference(entry.links, `${path}.links`, { requireJson: true });
    }
    if (entry.discovered_actions !== undefined) {
      assertSafeRelativeReference(entry.discovered_actions, `${path}.discovered_actions`, { requireJson: true });
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      fail("INVALID_MANIFEST", `${path}.description must be a string.`, { path: `${path}.description` });
    }
  });

  if (manifest.peer_policy !== undefined) {
    assertRecord(manifest.peer_policy, "$manifest.peer_policy", "INVALID_MANIFEST");
    if (manifest.peer_policy.allowed_peers !== undefined) {
      assertUniqueStrings(
        manifest.peer_policy.allowed_peers,
        "$manifest.peer_policy.allowed_peers",
        "INVALID_MANIFEST"
      );
    }
    for (const key of [
      "allow_cross_origin_peers",
      "require_user_consent",
      "router_only_disclosure"
    ]) {
      if (manifest.peer_policy[key] !== undefined && typeof manifest.peer_policy[key] !== "boolean") {
        fail("INVALID_MANIFEST", `$manifest.peer_policy.${key} must be boolean.`, {
          path: `$manifest.peer_policy.${key}`
        });
      }
    }
    if (
      manifest.peer_policy.sly_data_default !== undefined &&
      manifest.peer_policy.sly_data_default !== "deny"
    ) {
      fail("INVALID_MANIFEST", "$manifest.peer_policy.sly_data_default must be 'deny'.", {
        path: "$manifest.peer_policy.sly_data_default"
      });
    }
    allowedPeerOrigins(manifest);
  }

  return manifest;
}

function allowedPeerOrigins(manifest) {
  const origins = new Set();
  for (const [index, peer] of (manifest.peer_policy?.allowed_peers || []).entries()) {
    let url;
    try {
      url = new URL(peer);
    } catch (cause) {
      fail("INVALID_MANIFEST", `$manifest.peer_policy.allowed_peers[${index}] is not a valid URL.`, {
        path: `$manifest.peer_policy.allowed_peers[${index}]`,
        cause
      });
    }
    assertHttpProtocol(url, `$manifest.peer_policy.allowed_peers[${index}]`);
    if (url.username || url.password) {
      fail("INVALID_MANIFEST", "Allowed peer URLs must not contain credentials.", {
        path: `$manifest.peer_policy.allowed_peers[${index}]`
      });
    }
    origins.add(url.origin);
  }
  return origins;
}

export function validateLinks(links, { manifest, networkName } = {}) {
  if (!manifest || !isRecord(manifest)) {
    fail("INVALID_MANIFEST", "A validated manifest is required to validate links.", {
      path: "$manifest"
    });
  }
  assertRecord(links, "$links", "INVALID_LINKS");
  if (links.version !== 1) {
    fail("INVALID_LINKS", "$links.version must be 1.", { path: "$links.version" });
  }
  assertRecord(links.networks, "$links.networks", "INVALID_LINKS");

  const bindings = links.networks[networkName] ?? {};
  assertRecord(bindings, `$links.networks.${networkName}`, "INVALID_LINKS");
  const allowedOrigins = allowedPeerOrigins(manifest);

  for (const [name, target] of Object.entries(bindings)) {
    const path = `$links.networks.${networkName}.${name}`;
    assertIdentifier(name, path, "INVALID_LINKS");
    const targetValue = assertNonEmptyString(target, path, "INVALID_LINKS");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(targetValue)) {
      let url;
      try {
        url = new URL(targetValue);
      } catch (cause) {
        fail("INVALID_LINKS", `${path} is not a valid URL.`, { path, cause });
      }
      assertHttpProtocol(url, path);
      if (url.username || url.password) {
        fail("UNSAFE_URL", `${path} must not contain credentials.`, { path });
      }
      if (!allowedOrigins.has(url.origin)) {
        fail("UNAUTHORIZED_EXTERNAL_REFERENCE", `${path} points to an origin not listed in peer_policy.allowed_peers.`, {
          path,
          details: { origin: url.origin }
        });
      }
    } else {
      assertSafeRelativeReference(targetValue, path);
    }
  }

  return Object.freeze({ bindings: Object.freeze({ ...bindings }), names: Object.freeze(Object.keys(bindings)) });
}

export function validateActionCatalog(catalog) {
  assertRecord(catalog, "$actions", "INVALID_ACTION_CATALOG");
  assertNonEmptyString(catalog.schema_version, "$actions.schema_version", "INVALID_ACTION_CATALOG");
  if (!Array.isArray(catalog.actions)) {
    fail("INVALID_ACTION_CATALOG", "$actions.actions must be an array.", { path: "$actions.actions" });
  }

  const actions = new Map();
  catalog.actions.forEach((action, index) => {
    const path = `$actions.actions[${index}]`;
    assertRecord(action, path, "INVALID_ACTION_CATALOG");
    const name = assertIdentifier(action.name, `${path}.name`, "INVALID_ACTION_CATALOG");
    if (actions.has(name)) {
      fail("DUPLICATE_ACTION_NAME", `${path}.name duplicates '${name}'.`, {
        path: `${path}.name`,
        details: { duplicate: name }
      });
    }
    assertNonEmptyString(action.selector, `${path}.selector`, "INVALID_ACTION_CATALOG");
    if (!ALLOWED_EFFECTS.has(action.effect)) {
      fail("INVALID_ACTION_CATALOG", `${path}.effect is not supported.`, {
        path: `${path}.effect`,
        details: { value: action.effect }
      });
    }
    if (typeof action.requires_user_confirmation !== "boolean") {
      fail("INVALID_ACTION_CATALOG", `${path}.requires_user_confirmation must be boolean.`, {
        path: `${path}.requires_user_confirmation`
      });
    }
    validateAgentParameters(action.input_schema, `${path}.input_schema`);
    actions.set(name, action);
  });

  return actions;
}

function validateExecutionLimits(metadata) {
  if (metadata.execution_limits === undefined) return;
  assertRecord(metadata.execution_limits, "$network.metadata.execution_limits", "INVALID_NETWORK");
  for (const key of ["max_composition_depth", "max_agent_invocations", "max_remote_calls", "timeout_ms"]) {
    const value = metadata.execution_limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      fail("INVALID_NETWORK", `$network.metadata.execution_limits.${key} must be a positive integer.`, {
        path: `$network.metadata.execution_limits.${key}`
      });
    }
  }
}

function validateSlyDataPolicy(metadata) {
  if (metadata.sly_data_policy === undefined) return;
  assertRecord(metadata.sly_data_policy, "$network.metadata.sly_data_policy", "INVALID_NETWORK");
  if (metadata.sly_data_policy.default !== "deny") {
    fail("INVALID_NETWORK", "$network.metadata.sly_data_policy.default must be 'deny'.", {
      path: "$network.metadata.sly_data_policy.default"
    });
  }
  for (const key of ["allowed_downstream_fields", "allowed_upstream_fields", "redacted_from_peers"]) {
    if (metadata.sly_data_policy[key] !== undefined) {
      assertUniqueStrings(
        metadata.sly_data_policy[key],
        `$network.metadata.sly_data_policy.${key}`,
        "INVALID_NETWORK"
      );
    }
  }
}

export function validateNetwork(
  network,
  {
    manifest,
    manifestEntry,
    actionCatalog = null,
    links = null,
    runtimeCapabilities = DEFAULT_RUNTIME_CAPABILITIES
  } = {}
) {
  assertRecord(network, "$network", "INVALID_NETWORK");
  assertRecord(network.metadata, "$network.metadata", "INVALID_NETWORK");
  assertNonEmptyString(network.metadata.description, "$network.metadata.description", "INVALID_NETWORK");
  if (!manifestEntry || !isRecord(manifestEntry)) {
    fail("INVALID_MANIFEST", "A validated manifest entry is required to validate a network.", {
      path: "$manifest.networks"
    });
  }
  if (!manifest || !isRecord(manifest)) {
    fail("INVALID_MANIFEST", "A validated manifest is required to validate a network.", {
      path: "$manifest"
    });
  }
  const networkName = network.metadata.network_name === undefined
    ? manifestEntry.name
    : assertIdentifier(network.metadata.network_name, "$network.metadata.network_name", "INVALID_NETWORK");
  const frontMan = network.metadata.front_man === undefined
    ? manifestEntry.front_man
    : assertIdentifier(network.metadata.front_man, "$network.metadata.front_man", "INVALID_NETWORK");
  if (network.metadata.network_name !== undefined && networkName !== manifestEntry.name) {
    fail("NETWORK_IDENTITY_MISMATCH", "Network metadata.network_name does not match the manifest entry name.", {
      path: "$network.metadata.network_name",
      details: { networkName, manifestName: manifestEntry.name }
    });
  }
  if (network.metadata.front_man !== undefined && frontMan !== manifestEntry.front_man) {
    fail("FRONT_AGENT_MISMATCH", "Network metadata.front_man does not match the manifest entry.", {
      path: "$network.metadata.front_man",
      details: { networkFrontMan: frontMan, manifestFrontMan: manifestEntry.front_man }
    });
  }
  validateExecutionLimits(network.metadata);
  validateSlyDataPolicy(network.metadata);

  if (!Array.isArray(network.tools) || network.tools.length === 0) {
    fail("INVALID_NETWORK", "$network.tools must be a non-empty array.", { path: "$network.tools" });
  }

  const agents = new Map();
  network.tools.forEach((agent, index) => {
    const path = `$network.tools[${index}]`;
    assertRecord(agent, path, "INVALID_NETWORK");
    const name = assertIdentifier(agent.name, `${path}.name`, "INVALID_NETWORK");
    if (agents.has(name)) {
      fail("DUPLICATE_AGENT_NAME", `${path}.name duplicates '${name}'.`, {
        path: `${path}.name`,
        details: { duplicate: name }
      });
    }
    assertRecord(agent.function, `${path}.function`, "INVALID_NETWORK");
    assertNonEmptyString(agent.function.description, `${path}.function.description`, "INVALID_NETWORK");
    validateAgentParameters(agent.function.parameters, `${path}.function.parameters`);
    if (typeof agent.instructions !== "string" || agent.instructions.trim() === "") {
      fail("INVALID_NETWORK", `${path}.instructions must be a non-empty string for an LLM agent.`, {
        path: `${path}.instructions`
      });
    }
    if (!Array.isArray(agent.tools)) {
      fail("INVALID_NETWORK", `${path}.tools must be an array.`, { path: `${path}.tools` });
    }
    agents.set(name, agent);
  });

  if (!agents.has(frontMan)) {
    fail("FRONT_AGENT_NOT_FOUND", `Front agent '${frontMan}' is not defined in network.tools.`, {
      path: "$network.metadata.front_man",
      details: { frontMan }
    });
  }
  if (network.tools[0].name !== frontMan) {
    fail("FRONT_AGENT_ORDER_INVALID", "The first Neuro SAN tool must be the front agent.", {
      path: "$network.tools[0].name",
      details: { frontMan, firstAgent: network.tools[0].name }
    });
  }

  const actions = actionCatalog ? validateActionCatalog(actionCatalog) : new Map();
  const linkRegistry = links
    ? validateLinks(links, { manifest, networkName })
    : { bindings: Object.freeze({}), names: Object.freeze([]) };
  const runtimeNames = new Set(Object.keys(runtimeCapabilities || {}));
  const runtimeToolSchemas = {};
  for (const [name, capability] of Object.entries(runtimeCapabilities || {})) {
    assertIdentifier(name, `$runtimeCapabilities.${name}`, "INVALID_RUNTIME_CAPABILITY");
    assertRecord(capability, `$runtimeCapabilities.${name}`, "INVALID_RUNTIME_CAPABILITY");
    validateAgentParameters(capability.input_schema, `$runtimeCapabilities.${name}.input_schema`);
    runtimeToolSchemas[name] = capability.input_schema;
  }
  const linkNames = new Set(linkRegistry.names);

  for (const [agentName, agent] of agents) {
    agent.tools.forEach((reference, index) => {
      const path = `$network.tools.${agentName}.tools[${index}]`;
      if (typeof reference !== "string") {
        fail("UNSUPPORTED_TOOL_REFERENCE", `${path} must be a declarative string reference in this local-only loader.`, {
          path
        });
      }
      const name = reference.trim();
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) || name.startsWith("/")) {
        fail("EXTERNAL_REFERENCE_NOT_ALLOWED", `${path} uses a direct external reference; use an authorized links.json binding.`, {
          path,
          details: { reference: name }
        });
      }
      if (!agents.has(name) && !actions.has(name) && !linkNames.has(name) && !runtimeNames.has(name)) {
        fail("UNRESOLVED_REFERENCE", `${path} references unknown agent, action, runtime tool, or link '${name}'.`, {
          path,
          details: { reference: name, agent: agentName }
        });
      }
    });
  }

  return Object.freeze({
    networkName,
    frontMan,
    agentNames: Object.freeze([...agents.keys()]),
    actionNames: Object.freeze([...actions.keys()]),
    linkNames: Object.freeze([...linkNames]),
    runtimeToolNames: Object.freeze([...runtimeNames]),
    runtimeToolSchemas: deepFreezeJson(runtimeToolSchemas)
  });
}

async function fetchJson(url, { fetchImpl, phase, notFoundCode, authorizedDirectory }) {
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" }
    });
  } catch (cause) {
    fail("ARTIFACT_FETCH_FAILED", `Failed to fetch ${phase} artifact.`, {
      phase,
      path: url.href,
      cause
    });
  }

  if (!response || response.ok !== true) {
    fail(response?.status === 404 ? notFoundCode : "ARTIFACT_FETCH_FAILED", `${phase} artifact returned HTTP ${response?.status ?? "unknown"}.`, {
      phase,
      path: url.href,
      details: { status: response?.status ?? null }
    });
  }

  const finalUrl = new URL(response.url || url.href);
  assertHttpProtocol(finalUrl, `${phase} response URL`);
  assertUrlWithinDirectory(finalUrl, authorizedDirectory, `${phase} response URL`);

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    fail("ARTIFACT_READ_FAILED", `Failed to read ${phase} artifact.`, {
      phase,
      path: url.href,
      cause
    });
  }
  if (text.length > MAX_JSON_BYTES) {
    fail("ARTIFACT_TOO_LARGE", `${phase} artifact exceeds ${MAX_JSON_BYTES} bytes.`, {
      phase,
      path: url.href,
      details: { bytes: text.length }
    });
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    fail("INVALID_JSON", `${phase} artifact is not valid JSON.`, {
      phase,
      path: url.href,
      cause
    });
  }
}

export async function loadAndValidateLocalNetwork({
  manifestUrl = "./agent-manifest.json",
  networkName = null,
  baseUrl = globalThis.location?.href,
  fetchImpl = globalThis.fetch,
  runtimeCapabilities = DEFAULT_RUNTIME_CAPABILITIES
} = {}) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    fail("MISSING_BASE_URL", "baseUrl is required outside a browser context.", { path: "baseUrl" });
  }
  if (typeof fetchImpl !== "function") {
    fail("MISSING_FETCH", "A fetch implementation is required.", { path: "fetchImpl" });
  }

  const resolved = resolveManifestUrl(manifestUrl, baseUrl);
  const manifest = await fetchJson(resolved.manifestUrl, {
    fetchImpl,
    phase: "manifest",
    notFoundCode: "MANIFEST_NOT_FOUND",
    authorizedDirectory: resolved.authorizedDirectory
  });
  validateManifest(manifest);

  let selectedEntry;
  if (networkName !== null) {
    selectedEntry = manifest.networks.find((entry) => entry.name === networkName);
    if (!selectedEntry) {
      fail("NETWORK_NOT_LISTED", `Network '${networkName}' is not listed in the manifest.`, {
        phase: "manifest",
        path: "$manifest.networks",
        details: { networkName }
      });
    }
  } else if (manifest.networks.length === 1) {
    selectedEntry = manifest.networks[0];
  } else {
    fail("NETWORK_NAME_REQUIRED", "networkName is required when the manifest publishes multiple networks.", {
      phase: "manifest",
      path: "$manifest.networks"
    });
  }

  const manifestDirectory = directoryUrl(resolved.manifestUrl);
  const networkUrl = resolveLocalJsonReference(
    selectedEntry.hocon,
    resolved.manifestUrl,
    manifestDirectory,
    "$manifest.networks.hocon"
  );
  const network = await fetchJson(networkUrl, {
    fetchImpl,
    phase: "network",
    notFoundCode: "NETWORK_NOT_FOUND",
    authorizedDirectory: manifestDirectory
  });

  let links = null;
  if (selectedEntry.links !== undefined) {
    const linksUrl = resolveLocalJsonReference(
      selectedEntry.links,
      resolved.manifestUrl,
      manifestDirectory,
      "$manifest.networks.links"
    );
    links = await fetchJson(linksUrl, {
      fetchImpl,
      phase: "links",
      notFoundCode: "LINKS_NOT_FOUND",
      authorizedDirectory: manifestDirectory
    });
  }

  let actionCatalog = null;
  if (selectedEntry.discovered_actions !== undefined) {
    const actionsUrl = resolveLocalJsonReference(
      selectedEntry.discovered_actions,
      resolved.manifestUrl,
      manifestDirectory,
      "$manifest.networks.discovered_actions"
    );
    actionCatalog = await fetchJson(actionsUrl, {
      fetchImpl,
      phase: "actions",
      notFoundCode: "ACTION_CATALOG_NOT_FOUND",
      authorizedDirectory: manifestDirectory
    });
  }

  const validation = validateNetwork(network, {
    manifest,
    manifestEntry: selectedEntry,
    actionCatalog,
    links,
    runtimeCapabilities
  });

  const result = Object.freeze({
    status: "validated",
    manifestUrl: resolved.manifestUrl.href,
    networkUrl: networkUrl.href,
    selectedNetwork: selectedEntry.name,
    manifest: deepFreezeJson(manifest),
    manifestEntry: deepFreezeJson(selectedEntry),
    network: deepFreezeJson(network),
    links: deepFreezeJson(links),
    actionCatalog: deepFreezeJson(actionCatalog),
    validation
  });
  VALIDATED_LOAD_RESULTS.add(result);
  return result;
}
