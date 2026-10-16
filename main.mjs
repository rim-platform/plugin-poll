// node_modules/@rim-platform/plugin-sdk/dist/generated/protocol.js
var PROTOCOL_VERSION = 1;
var MAX_FRAME_BYTES = 4194304;
var ErrorCode = {
  /** the frame is not valid JSON. */
  PARSE_ERROR: -32700,
  /** the JSON is not a valid JSON-RPC 2.0 message. */
  INVALID_REQUEST: -32600,
  /** the receiver does not implement the method. */
  METHOD_NOT_FOUND: -32601,
  /** params are missing or have the wrong shape, including an unknown commandId. */
  INVALID_PARAMS: -32602,
  /** the receiver failed while handling a valid request. */
  INTERNAL_ERROR: -32603,
  /** the user has not approved the capability the method needs. */
  CAPABILITY_DENIED: -32e3,
  /** the plugin called a capability more often than its per-minute limit. */
  RATE_LIMITED: -32001,
  /** the plugin ran the command and it failed; message says why. */
  PLUGIN_ERROR: -32002
};
var Method = {
  handshake: "rim.handshake",
  heartbeat: "rim.heartbeat",
  shutdown: "rim.shutdown",
  principalChanged: "rim.principal.changed",
  principalsRemapped: "rim.principals.remapped",
  commandExecute: "rim.command.execute",
  log: "rim.log"
};

// node_modules/@rim-platform/plugin-sdk/dist/errors.js
var PluginError = class extends Error {
  /** JSON-RPC error code, one of {@link ErrorCode} or a code the plugin documents. */
  code;
  /** Optional machine-readable details, sent as `error.data`. Must be JSON. */
  data;
  constructor(message, options = {}) {
    super(message);
    this.name = "PluginError";
    this.code = options.code ?? ErrorCode.PLUGIN_ERROR;
    this.data = options.data;
  }
};
var HostRequestError = class extends Error {
  /** The method the plugin called. */
  method;
  /** JSON-RPC error code the host sent, such as `CAPABILITY_DENIED`. */
  code;
  /** `error.data` from the host, if any. */
  data;
  constructor(method, error) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = "HostRequestError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
};
function toWireError(error, fallbackCode) {
  if (error instanceof PluginError) {
    const wireError = { code: error.code, message: error.message };
    if (error.data !== void 0)
      wireError.data = error.data;
    return wireError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message: message || "unknown error" };
}

// node_modules/@rim-platform/plugin-sdk/dist/framing.js
var HEADER_BYTES = 4;
var FrameTooLargeError = class extends Error {
  /** Length the frame claimed or would have had, in bytes. */
  length;
  constructor(length) {
    super(`frame of ${length} bytes is over the ${MAX_FRAME_BYTES}-byte limit`);
    this.name = "FrameTooLargeError";
    this.length = length;
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function encodeText(text) {
  const body = encoder.encode(text);
  if (body.length > MAX_FRAME_BYTES)
    throw new FrameTooLargeError(body.length);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}
var FrameDecoder = class {
  chunks = [];
  buffered = 0;
  /**
   * Add bytes from the stream and return every frame they complete, in order.
   * A frame whose body is not UTF-8 JSON comes back with `ok: false`; the
   * protocol says to log and drop it, and the stream stays usable.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  push(chunk) {
    return this.pushBodies(chunk).map(parse);
  }
  /**
   * Add bytes from the stream and return the text of every frame they complete,
   * in order, or `null` for a frame whose body is not UTF-8.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  pushText(chunk) {
    return this.pushBodies(chunk).map((body) => {
      try {
        return decoder.decode(body);
      } catch {
        return null;
      }
    });
  }
  pushBodies(chunk) {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames = [];
    while (this.buffered >= HEADER_BYTES) {
      const header = this.peek(HEADER_BYTES);
      const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(0, true);
      if (length > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(length);
      if (this.buffered < HEADER_BYTES + length)
        break;
      frames.push(this.take(HEADER_BYTES + length).subarray(HEADER_BYTES));
    }
    return frames;
  }
  /** Bytes received that do not make up a whole frame yet. */
  get pendingBytes() {
    return this.buffered;
  }
  peek(count) {
    if (this.chunks[0].length < count)
      this.chunks = [concat(this.chunks, this.buffered)];
    return this.chunks[0].subarray(0, count);
  }
  take(count) {
    const all = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks, this.buffered);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.buffered -= count;
    return all.subarray(0, count);
  }
};
function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function parse(body) {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(body)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// node_modules/@rim-platform/plugin-sdk/dist/manifest.js
function parseManifestInfo(text, source) {
  const raw = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || typeof raw.plugin_id !== "string") {
    throw new Error(`${source} is not a plugin manifest: plugin_id is missing`);
  }
  const manifest = raw;
  const commands = /* @__PURE__ */ new Map();
  for (const entry of arrayOf(manifest.commands)) {
    if (typeof entry.id === "string")
      commands.set(entry.id, entry.dangerous === true);
  }
  const panelIds = /* @__PURE__ */ new Set();
  for (const entry of arrayOf(manifest.panels)) {
    if (typeof entry.id === "string")
      panelIds.add(entry.id);
  }
  return { pluginId: manifest.plugin_id, commands, panelIds };
}
function arrayOf(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((entry) => typeof entry === "object" && entry !== null);
}

// node_modules/@rim-platform/plugin-sdk/dist/principal.js
var MalformedPrincipalError = class extends Error {
  constructor(value) {
    super(`malformed principal: ${JSON.stringify(value)}`);
    this.name = "MalformedPrincipalError";
  }
};
function readPrincipal(value) {
  if (value === null)
    return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new MalformedPrincipalError(value);
  const { principalId, displayName } = value;
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new MalformedPrincipalError(value);
  }
  if (typeof displayName !== "string")
    throw new MalformedPrincipalError(value);
  return Object.freeze({ principalId, displayName });
}
var MalformedMappingError = class extends Error {
  constructor(value) {
    super(`malformed principal mapping: ${JSON.stringify(value)}`);
    this.name = "MalformedMappingError";
  }
};
function readPrincipalMappings(value) {
  if (!Array.isArray(value))
    throw new MalformedMappingError(value);
  return Object.freeze(value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new MalformedMappingError(item);
    }
    const { from, to } = item;
    if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
      throw new MalformedMappingError(item);
    }
    return Object.freeze({ from, to });
  }));
}
function samePrincipal(a, b) {
  if (a === null || b === null)
    return a === b;
  return a.principalId === b.principalId && a.displayName === b.displayName;
}

// node_modules/@rim-platform/plugin-sdk/dist/transport.js
var encoder2 = new TextEncoder();
function streamTransport(input2, output) {
  return {
    messages: (async function* () {
      const decoder2 = new FrameDecoder();
      for await (const chunk of input2) {
        for (const frame of decoder2.pushText(typeof chunk === "string" ? encoder2.encode(chunk) : chunk)) {
          yield frame ?? "";
        }
      }
    })(),
    send(text) {
      output.write(encodeText(text));
    },
    /** Resolves once everything written before it has been handed to the stream. */
    flush() {
      return new Promise((done) => output.write(new Uint8Array(0), () => done()));
    },
    close() {
    }
  };
}
function portTransport(port) {
  const queue = [];
  let wake = null;
  let closed = false;
  let failure = null;
  port.onmessage = (event) => {
    if (closed)
      return;
    const data = typeof event.data === "string" ? event.data : "";
    const bytes = data.length > MAX_FRAME_BYTES ? data.length : encoder2.encode(data).length;
    if (bytes > MAX_FRAME_BYTES) {
      failure = new FrameTooLargeError(bytes);
      closed = true;
    } else {
      queue.push(data);
    }
    wake?.();
  };
  const events = port;
  events.addEventListener?.("close", () => {
    closed = true;
    wake?.();
  });
  return {
    messages: (async function* () {
      for (; ; ) {
        while (queue.length > 0)
          yield queue.shift();
        if (failure)
          throw failure;
        if (closed)
          return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    })(),
    send(text) {
      const bytes = encoder2.encode(text).length;
      if (bytes > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(bytes);
      port.postMessage(text);
    },
    close() {
      closed = true;
      port.onmessage = null;
      port.close();
      wake?.();
    }
  };
}

// node_modules/@rim-platform/plugin-sdk/dist/plugin.js
var SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var UPDATE_PANEL_METHOD = "rim.ui.update_panel";
var STORAGE_GET_METHOD = "rim.storage.get";
var STORAGE_SET_METHOD = "rim.storage.set";
var CHAT_LIST_MESSAGES_METHOD = "rim.chat.list_messages";
var CHAT_GET_MESSAGE_METHOD = "rim.chat.get_message";
var CHAT_SEARCH_MESSAGES_METHOD = "rim.chat.search_messages";
var CHAT_POST_MESSAGE_METHOD = "rim.chat.post_message";
function createDefinePlugin(platform) {
  return (definition) => definePluginOn(platform, definition);
}
function definePluginOn(platform, definition) {
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new TypeError("definePlugin: id must be the plugin_id from rim-plugin.json");
  }
  const commands = /* @__PURE__ */ new Map();
  for (const [id, command] of Object.entries(definition.commands ?? {})) {
    if (typeof command?.run !== "function") {
      throw new TypeError(`definePlugin: command ${id} needs a run function`);
    }
    commands.set(id, command);
  }
  return Object.freeze({
    id: definition.id,
    run: (options = {}) => runPlugin(platform, definition, commands, options)
  });
}
async function runPlugin(platform, definition, commands, options) {
  const port = globalThis.rimPluginPort;
  const onStreams = options.input === void 0 && options.output === void 0;
  let transport;
  let exit = options.exit;
  if (options.transport) {
    transport = options.transport;
  } else if (port && onStreams) {
    transport = portTransport(port);
  } else {
    const streams = options.input === void 0 || options.output === void 0 ? platform.streams() : void 0;
    transport = streamTransport(options.input ?? streams.input, options.output ?? streams.output);
    if (onStreams)
      exit ??= platform.claimStdio();
  }
  const session = new Session(definition, commands, (text) => transport.send(text), loadManifest(platform, options.manifestPath), options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, platform);
  let code = 0;
  try {
    for await (const text of transport.messages) {
      session.receiveText(text);
      if (session.stopping)
        break;
    }
  } catch (error) {
    session.log("error", `connection failed: ${error instanceof Error ? error.message : error}`);
    code = error instanceof FrameTooLargeError ? 1 : 2;
  }
  await session.close();
  await transport.flush?.();
  transport.close();
  exit?.(code);
}
function loadManifest(platform, path) {
  if (path === false)
    return {};
  const text = globalThis.rimPluginManifest;
  const source = path ?? (typeof text === "string" ? "rimPluginManifest" : "rim-plugin.json");
  try {
    if (path === void 0 && typeof text === "string") {
      return { manifest: parseManifestInfo(text, source) };
    }
    return { manifest: platform.readManifest(source) };
  } catch (error) {
    return {
      problem: `cannot read ${source}: ${error instanceof Error ? error.message : error}`
    };
  }
}
var Session = class {
  stopping = false;
  host;
  definition;
  commands;
  send;
  platform;
  manifest;
  manifestProblem;
  requestTimeoutMs;
  pending = /* @__PURE__ */ new Map();
  nextRequestId = 1;
  ready = false;
  closed = false;
  hostVersion = "";
  protocolVersion = PROTOCOL_VERSION;
  grantedCapabilities = Object.freeze([]);
  principal = null;
  constructor(definition, commands, send, loaded, requestTimeoutMs, platform) {
    this.definition = definition;
    this.commands = commands;
    this.send = send;
    this.platform = platform;
    this.manifest = loaded.manifest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.manifestProblem = loaded.problem ?? (loaded.manifest && loaded.manifest.pluginId !== definition.id ? `rim-plugin.json declares ${loaded.manifest.pluginId}, but the code defines ${definition.id}` : void 0);
    this.host = this.createHost();
    if (this.manifestProblem)
      this.log("error", this.manifestProblem);
    for (const id of this.manifest?.commands.keys() ?? []) {
      if (!commands.has(id))
        this.log("warn", `rim-plugin.json declares command ${id}, which has no handler`);
    }
    for (const id of commands.keys()) {
      if (this.manifest && !this.manifest.commands.has(id)) {
        this.log("warn", `command ${id} is not in rim-plugin.json, so the host never runs it`);
      }
    }
  }
  /** Handle the JSON text of one message from the host. */
  receiveText(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.log("warn", "dropped a message that is not JSON");
      return;
    }
    this.receive(frame);
  }
  /** Handle one parsed message from the host. */
  receive(frame) {
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.log("warn", "dropped a frame that is not JSON-RPC 2.0");
      return;
    }
    const { method, id } = frame;
    if (typeof method === "string") {
      if (id === void 0 || id === null)
        this.onNotification(method, frame.params);
      else if (isId(id))
        void this.onRequest(method, frame.params, id);
      else
        this.log("warn", `dropped ${method}: its id is neither a number nor a string`);
      return;
    }
    if (isId(id) && ("result" in frame || "error" in frame)) {
      this.onResponse(id, frame);
      return;
    }
    this.log("warn", "dropped a frame that is neither a request, a notification nor a response");
  }
  /** Write a line to the host log, or to stderr once the connection is closed. */
  log(level, message) {
    const frame = {
      jsonrpc: "2.0",
      method: Method.log,
      params: { level, message }
    };
    if (!this.closed) {
      try {
        this.write(frame);
        return;
      } catch {
      }
    }
    this.platform.stderr(`[${level}] ${message}`);
  }
  /** Run `onShutdown` and fail every request still waiting for the host. */
  async close() {
    if (this.closed)
      return;
    this.stopping = true;
    await this.callHook("onShutdown", () => this.definition.onShutdown?.());
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HostRequestError(entry.method, {
        code: ErrorCode.INTERNAL_ERROR,
        message: "the connection to the host closed"
      }));
      this.pending.delete(id);
    }
  }
  async onRequest(method, params, id) {
    try {
      switch (method) {
        case Method.handshake: {
          const result = this.handshake(params);
          const response = { jsonrpc: "2.0", id, result };
          this.write(response);
          if (result.accepted) {
            await this.callHook("onReady", () => this.definition.onReady?.(this.host));
          }
          return;
        }
        case Method.heartbeat: {
          const response = { jsonrpc: "2.0", id, result: { pong: true } };
          this.write(response);
          return;
        }
        case Method.commandExecute: {
          let response;
          try {
            response = { jsonrpc: "2.0", id, result: await this.execute(params) };
          } catch (error) {
            response = { jsonrpc: "2.0", id, error: toWireError(error, ErrorCode.PLUGIN_ERROR) };
          }
          this.writeAnswer(response);
          return;
        }
        default:
          this.writeError(id, ErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (error) {
      this.writeError(id, ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }
  onNotification(method, params) {
    if (method === Method.shutdown) {
      this.stopping = true;
    } else if (method === Method.principalChanged) {
      this.onPrincipalChanged(params);
    } else if (method === Method.principalsRemapped) {
      this.onPrincipalsRemapped(params);
    }
  }
  onResponse(id, frame) {
    const entry = typeof id === "number" ? this.pending.get(id) : void 0;
    if (!entry)
      return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.error !== void 0)
      entry.reject(new HostRequestError(entry.method, readWireError(frame.error)));
    else
      entry.resolve(frame.result);
  }
  handshake(params) {
    const p = isRecord(params) ? params : {};
    const refuse = (error) => {
      this.log("error", `refused the handshake: ${error}`);
      return {
        accepted: false,
        protocolVersion: SUPPORTED_VERSIONS[0],
        pluginId: this.definition.id,
        error
      };
    };
    if (this.manifestProblem)
      return refuse(this.manifestProblem);
    if (p.pluginId !== this.definition.id) {
      return refuse(`this plugin is ${this.definition.id}, but the host started it as ${String(p.pluginId)}`);
    }
    const hostVersions = Array.isArray(p.supportedVersions) ? p.supportedVersions.filter(isVersion) : isVersion(p.protocolVersion) ? [p.protocolVersion] : [];
    const version = SUPPORTED_VERSIONS.find((v) => hostVersions.includes(v));
    if (version === void 0) {
      return refuse(`the host speaks protocol ${hostVersions.join(", ") || "(none)"}, this plugin speaks ${SUPPORTED_VERSIONS.join(", ")}`);
    }
    let principal = null;
    try {
      principal = readPrincipal(p.principal ?? null);
    } catch (error) {
      this.log("warn", `ignored the handshake principal: ${error.message}`);
    }
    this.principal = principal;
    this.protocolVersion = version;
    this.hostVersion = typeof p.hostVersion === "string" ? p.hostVersion : "";
    this.grantedCapabilities = Object.freeze(Array.isArray(p.grantedCapabilities) ? p.grantedCapabilities.filter((c) => typeof c === "string") : []);
    this.ready = true;
    return { accepted: true, protocolVersion: version, pluginId: this.definition.id };
  }
  async execute(params) {
    if (!this.ready) {
      throw new PluginError("rim.command.execute arrived before the handshake", {
        code: ErrorCode.INVALID_REQUEST
      });
    }
    const p = readExecuteParams(params);
    const command = this.commands.get(p.commandId);
    if (!command) {
      throw new PluginError(`unknown command: ${p.commandId}`, { code: ErrorCode.INVALID_PARAMS });
    }
    const dangerous = command.dangerous === true || this.manifest?.commands.get(p.commandId) === true;
    if (dangerous && !(p.confirmed === true && p.initiator === "user")) {
      throw new PluginError(`${p.commandId} is dangerous and runs only after the user confirms it`, {
        code: ErrorCode.PLUGIN_ERROR,
        data: { reason: "confirmation_required" }
      });
    }
    const context = Object.freeze({ ...p, host: this.host });
    return toCommandResult(p.commandId, await command.run(context));
  }
  onPrincipalChanged(params) {
    let principal;
    try {
      principal = readPrincipal(isRecord(params) ? params.principal : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principal.changed: ${error.message}`);
      return;
    }
    if (samePrincipal(principal, this.principal))
      return;
    this.principal = principal;
    void this.callHook("onPrincipalChanged", () => this.definition.onPrincipalChanged?.(principal, this.host));
  }
  onPrincipalsRemapped(params) {
    let mappings;
    try {
      mappings = readPrincipalMappings(isRecord(params) ? params.mappings : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principals.remapped: ${error.message}`);
      return;
    }
    if (mappings.length === 0)
      return;
    void this.callHook("onPrincipalsRemapped", () => this.definition.onPrincipalsRemapped?.(mappings, this.host));
  }
  request(method, params) {
    if (this.closed || this.stopping || !this.ready) {
      const message = this.ready ? "the connection to the host is closing" : "the handshake has not finished";
      return Promise.reject(new HostRequestError(method, { code: ErrorCode.INTERNAL_ERROR, message }));
    }
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError(method, {
          code: ErrorCode.INTERNAL_ERROR,
          message: `the host did not answer within ${this.requestTimeoutMs} ms`
        }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async updatePanel(panelId, state, patch) {
    if (this.manifest && !this.manifest.panelIds.has(panelId)) {
      throw new PluginError(`panel ${panelId} is not declared in rim-plugin.json`, {
        code: ErrorCode.INVALID_PARAMS
      });
    }
    await this.request(UPDATE_PANEL_METHOD, { panel_id: panelId, state, patch });
  }
  createHost() {
    const session = this;
    return Object.freeze({
      pluginId: this.definition.id,
      get hostVersion() {
        return session.hostVersion;
      },
      get protocolVersion() {
        return session.protocolVersion;
      },
      get grantedCapabilities() {
        return session.grantedCapabilities;
      },
      get principal() {
        return session.principal;
      },
      log: Object.freeze({
        debug: (message) => session.log("debug", message),
        info: (message) => session.log("info", message),
        warn: (message) => session.log("warn", message),
        error: (message) => session.log("error", message)
      }),
      storage: Object.freeze({
        get: async (key2) => {
          const result = await session.request(STORAGE_GET_METHOD, { key: key2 });
          return isRecord(result) && "value" in result ? result.value : null;
        },
        set: async (key2, value) => {
          await session.request(STORAGE_SET_METHOD, { key: key2, value });
        }
      }),
      chat: Object.freeze({
        listMessages: async (conversationId, options = {}) => await session.request(CHAT_LIST_MESSAGES_METHOD, {
          conversationId,
          ...options
        }),
        getMessage: async (messageId) => {
          const result = await session.request(CHAT_GET_MESSAGE_METHOD, { messageId });
          return isRecord(result) && isRecord(result.message) ? result.message : null;
        },
        searchMessages: async (query, options = {}) => {
          const result = await session.request(CHAT_SEARCH_MESSAGES_METHOD, {
            query,
            ...options
          });
          return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
        },
        postMessage: async (conversationId, body, options = {}) => await session.request(CHAT_POST_MESSAGE_METHOD, {
          conversationId,
          body,
          ...options
        })
      }),
      panels: Object.freeze({
        set: (panelId, state) => session.updatePanel(panelId, state, false),
        patch: (panelId, patch) => {
          if (!isRecord(patch)) {
            return Promise.reject(new TypeError("panels.patch: patch must be an object"));
          }
          return session.updatePanel(panelId, patch, true);
        }
      })
    });
  }
  async callHook(name, hook) {
    try {
      await hook();
    } catch (error) {
      this.log("error", `${name} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  write(frame) {
    const text = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_FRAME_BYTES)
      throw new FrameTooLargeError(bytes);
    this.send(text);
  }
  /** Write a response, or an error saying why it could not be sent. */
  writeAnswer(response) {
    try {
      this.write(response);
    } catch (error) {
      this.writeError(response.id, ErrorCode.INTERNAL_ERROR, `could not send the result: ${error.message}`);
    }
  }
  writeError(id, code, message) {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    this.write(response);
  }
};
function readExecuteParams(params) {
  const invalid = (why) => new PluginError(`invalid rim.command.execute params: ${why}`, {
    code: ErrorCode.INVALID_PARAMS
  });
  if (!isRecord(params))
    throw invalid("params must be an object");
  const { commandId, args, invoker, initiator, confirmed } = params;
  if (typeof commandId !== "string" || commandId.length === 0)
    throw invalid("commandId must be a string");
  if (args !== void 0 && !isRecord(args))
    throw invalid("args must be an object");
  if (initiator !== "user" && initiator !== "agent")
    throw invalid("initiator must be user or agent");
  if (typeof confirmed !== "boolean")
    throw invalid("confirmed must be a boolean");
  let principal;
  try {
    principal = readPrincipal(invoker ?? null);
  } catch (error) {
    throw invalid(error.message);
  }
  return {
    commandId,
    args: Object.freeze({ ...args ?? {} }),
    invoker: principal,
    initiator,
    confirmed
  };
}
function toCommandResult(commandId, output) {
  if (output === void 0 || output === null)
    return {};
  if (typeof output !== "object" || Array.isArray(output)) {
    throw new PluginError(`command ${commandId} returned a ${typeof output}; return { payload, message }`, {
      code: ErrorCode.INTERNAL_ERROR
    });
  }
  const result = {};
  if (output.payload !== void 0)
    result.payload = output.payload;
  if (output.message !== void 0) {
    if (typeof output.message !== "string") {
      throw new PluginError(`command ${commandId} returned a message that is not a string`, {
        code: ErrorCode.INTERNAL_ERROR
      });
    }
    result.message = output.message;
  }
  return result;
}
function readWireError(value) {
  if (isRecord(value) && typeof value.code === "number" && typeof value.message === "string") {
    return { code: value.code, message: value.message, data: value.data };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: "the host sent a malformed error" };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isInteger(value);
}
function isVersion(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// node_modules/@rim-platform/plugin-sdk/dist/index.browser.js
var browserPlatform = {
  streams() {
    throw new Error("this plugin runs in a RIM plugin frame, which has no stdio");
  },
  claimStdio() {
    return () => {
    };
  },
  readManifest: () => void 0,
  stderr: (line) => console.error(line)
};
var definePlugin = createDefinePlugin(browserPlatform);

// src/tally.ts
var MIN_OPTIONS = 2;
var MAX_OPTIONS = 8;
var MAX_OPTION_LENGTH = 80;
var MAX_QUESTION_LENGTH = 200;
var POLL_PREFIX = "\u{1F4CA} Poll: ";
var CLOSED_PREFIX = "\u{1F4CA} Poll closed: ";
var VOTE_PREFIX = "\u{1F5F3}\uFE0F vote: ";
var VOTE_FOOTER = "Vote with /vote <number>";
var VOTE_PATTERN = /^🗳️?\s*vote:/iu;
var OPTION_LINE = /^(\d+)\. (.+)$/;
var PollInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PollInputError";
  }
};
function oneLine(value) {
  return value.replace(/\s+/gu, " ").trim();
}
function key(value) {
  return oneLine(value).toLowerCase();
}
function parseQuestion(value) {
  const question = typeof value === "string" ? oneLine(value) : "";
  if (!question) throw new PollInputError("question must say what the poll asks.");
  if ([...question].length > MAX_QUESTION_LENGTH) {
    throw new PollInputError(`question must be at most ${MAX_QUESTION_LENGTH} characters.`);
  }
  return question;
}
function parseOptions(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PollInputError("options must list 2 to 8 options separated by | or ;.");
  }
  const options = value.split(/[|;]/u).map(oneLine);
  options.forEach((option, i) => {
    if (!option) throw new PollInputError(`Option ${i + 1} is empty.`);
    if ([...option].length > MAX_OPTION_LENGTH) {
      throw new PollInputError(`Option ${i + 1} is longer than ${MAX_OPTION_LENGTH} characters.`);
    }
  });
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new PollInputError(
      `A poll has ${MIN_OPTIONS} to ${MAX_OPTIONS} options; this one has ${options.length}.`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  for (const option of options) {
    if (seen.has(key(option))) throw new PollInputError(`"${option}" is listed twice.`);
    seen.add(key(option));
  }
  return options;
}
function matchChoice(choice, options) {
  if (typeof choice !== "string") return null;
  const wanted = key(choice);
  if (/^\d+$/u.test(wanted)) {
    const n = Number(wanted);
    if (n >= 1 && n <= options.length) return n - 1;
  }
  const index = options.findIndex((option) => key(option) === wanted);
  return index === -1 ? null : index;
}
function formatPoll(poll) {
  return [
    `${POLL_PREFIX}${poll.question}`,
    ...poll.options.map((option, i) => `${i + 1}. ${option}`),
    VOTE_FOOTER
  ].join("\n");
}
function formatVote(option) {
  return `${VOTE_PREFIX}${option}`;
}
function formatClosed(question, options) {
  return [
    `${CLOSED_PREFIX}${question}`,
    ...options.map((o) => `${o.number}. ${o.text} \u2014 ${o.votes}`)
  ].join("\n");
}
function parsePollMessage(text) {
  const lines = text.split("\n").map((line) => line.trim());
  if (!lines[0]?.startsWith(POLL_PREFIX) || lines.at(-1) !== VOTE_FOOTER) return null;
  const question = oneLine(lines[0].slice(POLL_PREFIX.length));
  const optionLines = lines.slice(1, -1);
  if (!question || optionLines.length < MIN_OPTIONS || optionLines.length > MAX_OPTIONS) {
    return null;
  }
  const options = [];
  for (const [i, line] of optionLines.entries()) {
    const match = OPTION_LINE.exec(line);
    if (!match || Number(match[1]) !== i + 1) return null;
    options.push(oneLine(match[2]));
  }
  return { question, options };
}
function isClosedMessage(text, question) {
  const first = text.split("\n", 1)[0] ?? "";
  return first.startsWith(CLOSED_PREFIX) && key(first.slice(CLOSED_PREFIX.length)) === key(question);
}
function parseVote(text, options) {
  const match = VOTE_PATTERN.exec(text);
  if (!match) return null;
  const named = key(text.slice(match[0].length));
  const index = options.findIndex((option) => key(option) === named);
  return index === -1 ? null : index;
}
function countVotes(messages, pollMessageId, poll) {
  const start = messages.findIndex((m) => m.id === pollMessageId);
  const author = start === -1 ? null : messages[start].author;
  const latest = /* @__PURE__ */ new Map();
  let closed = false;
  for (const message of start === -1 ? [] : messages.slice(start + 1)) {
    if (message.author.principalId === author?.principalId) {
      if (isClosedMessage(message.text, poll.question)) {
        closed = true;
        break;
      }
    }
    const vote = parseVote(message.text, poll.options);
    if (vote !== null) latest.set(message.author.principalId, vote);
  }
  const counts = poll.options.map(() => 0);
  for (const vote of latest.values()) counts[vote] += 1;
  return {
    found: start !== -1,
    author,
    closed,
    options: poll.options.map((text, i) => ({ number: i + 1, text, votes: counts[i] })),
    voters: latest.size
  };
}
function noVotes(poll) {
  return {
    found: true,
    author: null,
    closed: false,
    options: poll.options.map((text, i) => ({ number: i + 1, text, votes: 0 })),
    voters: 0
  };
}
function summarize(question, tally) {
  const counts = tally.options.map((o) => `${o.text} ${o.votes}`).join(", ");
  const voters = `${tally.voters} voter${tally.voters === 1 ? "" : "s"}`;
  return `${question}: ${counts} (${voters}${tally.closed ? ", closed" : ""})`;
}

// src/plugin.ts
var PLUGIN_ID = "chat.rim.poll";
var PANEL_ID = "results";
var REFRESH_MS = 60 * 1e3;
var PAGE_SIZE = 100;
var MAX_SCAN_PAGES = 20;
var DISCOVERY_PAGES = 3;
var SCAN_MARGIN_MS = 60 * 60 * 1e3;
var STORAGE_PREFIX = "poll.";
var SAFE_KEY = /^[A-Za-z0-9._-]{1,120}$/;
var ENCRYPTED_TEXT = "This conversation is end-to-end encrypted. Poll works in plaintext conversations only: it does not ask to read or post in encrypted DMs and groups.";
var NOT_FOUND_TEXT = "The poll message is not on this device: it may not be stored here yet, or it was deleted. Try again shortly, or forget the poll with Poll: Clear.";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function explainChatError(error) {
  if (!(error instanceof HostRequestError)) return error;
  const reason = isRecord2(error.data) ? error.data.reason : void 0;
  switch (error.code) {
    case ErrorCode.CAPABILITY_DENIED:
      return new PluginError(
        /\.encrypted\b/u.test(error.message) ? ENCRYPTED_TEXT : "Poll needs the permissions to read and post in your conversations. Allow them in Settings \u2192 Plugins.",
        { code: ErrorCode.CAPABILITY_DENIED }
      );
    case ErrorCode.RATE_LIMITED:
      return new PluginError("Poll made too many chat calls this minute. Try again in a minute.", {
        code: ErrorCode.RATE_LIMITED
      });
    case ErrorCode.INTERNAL_ERROR:
      if (reason === "noCache") {
        return new PluginError(
          "This browser keeps no messages, so Poll cannot read or post here. Set it up as a linked device, or use the desktop app."
        );
      }
      if (reason === "notCached") {
        return new PluginError(
          "This conversation is not fully stored on this device yet. Try again shortly."
        );
      }
      if (reason === "noEncryption") return new PluginError(ENCRYPTED_TEXT);
      break;
  }
  const detail = error.message.replace(/^\S+ failed \(-?\d+\): /u, "");
  return new PluginError(`The app refused: ${detail}`, { code: error.code });
}
async function chat(call) {
  try {
    return await call();
  } catch (error) {
    throw explainChatError(error);
  }
}
function fnv1a(value, seed) {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function storageKey(conversationId) {
  if (SAFE_KEY.test(conversationId)) return `${STORAGE_PREFIX}${conversationId}`;
  return `${STORAGE_PREFIX}h${fnv1a(conversationId, 2166136261)}${fnv1a(conversationId, 84696351)}`;
}
function readStoredPoll(value, conversationId) {
  if (!isRecord2(value) || value.conversationId !== conversationId) return null;
  const { messageId, threadId, question, options, status, createdAt } = value;
  if (typeof messageId !== "string" || threadId !== null && typeof threadId !== "string" || typeof question !== "string" || !Array.isArray(options) || !options.every((o) => typeof o === "string") || status !== "open" && status !== "closed" || typeof createdAt !== "string") {
    return null;
  }
  return { conversationId, messageId, threadId, question, options, status, createdAt };
}
function commandContext(args) {
  const conversationId = args.conversation_id;
  if (typeof conversationId !== "string" || conversationId === "") {
    throw new PluginError(
      "Open a conversation first: Poll runs in the conversation you have open.",
      {
        code: ErrorCode.INVALID_PARAMS
      }
    );
  }
  const threadId = args.thread_id;
  if (threadId !== void 0 && threadId !== null && typeof threadId !== "string") {
    throw new PluginError("thread_id must be a string.", { code: ErrorCode.INVALID_PARAMS });
  }
  return { conversationId, threadId: threadId || null };
}
function input(parse2) {
  try {
    return parse2();
  } catch (error) {
    if (error instanceof PollInputError) {
      throw new PluginError(error.message, { code: ErrorCode.INVALID_PARAMS });
    }
    throw error;
  }
}
function payloadOf(poll, tally) {
  return {
    question: poll.question,
    status: poll.status,
    voters: tally.voters,
    options: [...tally.options]
  };
}
function createPlugin(options = {}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  let panel = { signedIn: false, inConversation: false, poll: null, notice: null };
  let current = null;
  let panelDenied = false;
  let refreshing = false;
  let timer = null;
  let queue = Promise.resolve();
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => void 0);
    return run;
  }
  async function publish(host, next) {
    panel = { ...panel, ...next, signedIn: host.principal !== null };
    if (panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, panel);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the panel needs the ui.panel permission");
        return;
      }
      host.log.warn(`could not update the panel: ${error.message}`);
    }
  }
  async function showPoll(host, poll, tally, notice = null) {
    await publish(host, {
      inConversation: true,
      notice,
      poll: {
        question: poll.question,
        status: poll.status,
        options: [...tally.options],
        voters: tally.voters,
        counted: tally.found
      }
    });
  }
  async function load(host, conversationId) {
    return readStoredPoll(await host.storage.get(storageKey(conversationId)), conversationId);
  }
  async function save(host, poll) {
    await host.storage.set(storageKey(poll.conversationId), poll);
  }
  async function readBack(host, conversationId, maxPages, find, floor = -Infinity) {
    const pages = [];
    let before;
    for (let i = 0; i < maxPages; i++) {
      const page = await chat(
        () => host.chat.listMessages(conversationId, {
          limit: PAGE_SIZE,
          ...before === void 0 ? {} : { before }
        })
      );
      const at = find(page.messages);
      if (at !== -1) {
        pages.unshift(page.messages.slice(at));
        return { found: page.messages[at], messages: pages.flat() };
      }
      pages.unshift(page.messages);
      const oldest = page.messages[0];
      if (!page.hasOlder || !oldest || Date.parse(oldest.sentAt) < floor) break;
      before = oldest.id;
    }
    return { found: null, messages: pages.flat() };
  }
  async function scan(host, poll) {
    const read = await readBack(
      host,
      poll.conversationId,
      MAX_SCAN_PAGES,
      (messages) => messages.findIndex((m) => m.id === poll.messageId),
      Date.parse(poll.createdAt) - SCAN_MARGIN_MS
    );
    return read.messages;
  }
  async function discover(host, conversationId) {
    const read = await readBack(host, conversationId, DISCOVERY_PAGES, (messages) => {
      for (let at = messages.length - 1; at >= 0; at--) {
        if (parsePollMessage(messages[at].text)) return at;
      }
      return -1;
    });
    const text = read.found && parsePollMessage(read.found.text);
    if (!read.found || !text) return null;
    const message = read.found;
    const poll = {
      conversationId,
      messageId: message.id,
      threadId: message.threadId,
      question: text.question,
      options: [...text.options],
      status: countVotes(read.messages, message.id, text).closed ? "closed" : "open",
      createdAt: message.sentAt
    };
    return { poll, messages: read.messages };
  }
  async function resolve(host, conversationId) {
    const stored = await load(host, conversationId);
    if (stored?.status === "open") return { poll: stored, messages: null };
    const found = await discover(host, conversationId);
    if (found && found.poll.messageId !== stored?.messageId) {
      await save(host, found.poll);
      return found;
    }
    return { poll: stored, messages: found?.messages ?? null };
  }
  async function count(host, poll, read) {
    const messages = read ?? await scan(host, poll);
    const tally = countVotes(messages, poll.messageId, poll);
    if (tally.closed && poll.status === "open") {
      poll = { ...poll, status: "closed" };
      await save(host, poll);
    }
    return { poll, tally, messages };
  }
  function signedIn(context) {
    const person = context.invoker ?? context.host.principal;
    if (!person) throw new PluginError("Sign in to use polls.");
    return person;
  }
  async function start(context) {
    const { host, args } = context;
    const { conversationId, threadId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const question = input(() => parseQuestion(args.question));
    const options2 = input(() => parseOptions(args.options));
    const stored = await load(host, conversationId);
    if (stored?.status === "open") {
      throw new PluginError(
        `A poll is already open in this conversation: "${stored.question}". Close it with Poll: Close first.`
      );
    }
    const { id } = await chat(
      () => host.chat.postMessage(
        conversationId,
        formatPoll({ question, options: options2 }),
        threadId ? { threadId } : {}
      )
    );
    const poll = {
      conversationId,
      messageId: id,
      threadId,
      question,
      options: options2,
      status: "open",
      createdAt: new Date(now()).toISOString()
    };
    await save(host, poll);
    const tally = noVotes(poll);
    await showPoll(host, poll, tally);
    return { payload: payloadOf(poll, tally), message: `Poll posted: ${question}` };
  }
  async function vote(context) {
    const { host, args } = context;
    const { conversationId, threadId } = commandContext(args);
    const person = signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll) {
      await publish(host, { inConversation: true, poll: null, notice: null });
      throw new PluginError("There is no open poll in this conversation. Start one with /poll.");
    }
    const counted = await count(host, resolved.poll, resolved.messages);
    const { poll, tally } = counted;
    if (poll.status === "closed") {
      await showPoll(host, poll, tally);
      throw new PluginError(`The poll "${poll.question}" is closed.`);
    }
    const choice = matchChoice(args.choice, poll.options);
    if (choice === null) {
      throw new PluginError(
        `choice must be a number from 1 to ${poll.options.length} or one of the options: ${poll.options.join(", ")}.`,
        { code: ErrorCode.INVALID_PARAMS }
      );
    }
    const option = poll.options[choice];
    const text = formatVote(option);
    const target = poll.threadId ?? threadId;
    const { id } = await chat(
      () => host.chat.postMessage(conversationId, text, target ? { threadId: target } : {})
    );
    const after = tally.found ? countVotes([...counted.messages, { id, author: person, text }], poll.messageId, poll) : tally;
    await showPoll(
      host,
      poll,
      after,
      tally.found ? null : "Your vote is posted. The votes show once the poll message is on this device."
    );
    return { payload: payloadOf(poll, after), message: `Voted for "${option}"` };
  }
  async function results(context) {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll) {
      await publish(host, { inConversation: true, poll: null, notice: null });
      return { payload: null, message: "There is no poll in this conversation." };
    }
    const { poll, tally } = await count(host, resolved.poll, resolved.messages);
    if (!tally.found) {
      await showPoll(host, poll, tally, NOT_FOUND_TEXT);
      throw new PluginError(NOT_FOUND_TEXT);
    }
    await showPoll(host, poll, tally);
    return { payload: payloadOf(poll, tally), message: summarize(poll.question, tally) };
  }
  async function close(context) {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    const person = signedIn(context);
    current = conversationId;
    const resolved = await resolve(host, conversationId);
    if (!resolved.poll || resolved.poll.status === "closed") {
      throw new PluginError("There is no open poll in this conversation.");
    }
    const { poll, tally } = await count(host, resolved.poll, resolved.messages);
    if (!tally.found) throw new PluginError(NOT_FOUND_TEXT);
    if (poll.status === "closed") {
      await showPoll(host, poll, tally);
      throw new PluginError(`The poll "${poll.question}" is already closed.`);
    }
    if (tally.author?.principalId !== person.principalId) {
      throw new PluginError(
        `Only ${tally.author?.displayName ?? "the person who started the poll"}, who started the poll, can close it. Poll: Clear forgets it on this device.`
      );
    }
    await chat(
      () => host.chat.postMessage(
        conversationId,
        formatClosed(poll.question, tally.options),
        poll.threadId ? { threadId: poll.threadId } : {}
      )
    );
    const closed = { ...poll, status: "closed" };
    await save(host, closed);
    const final = { ...tally, closed: true };
    await publish(host, {
      inConversation: true,
      poll: null,
      notice: `Closed "${poll.question}". The final tally is in the conversation.`
    });
    return { payload: payloadOf(closed, final), message: summarize(poll.question, final) };
  }
  async function clear(context) {
    const { host, args } = context;
    const { conversationId } = commandContext(args);
    signedIn(context);
    current = conversationId;
    const stored = await load(host, conversationId);
    await host.storage.set(storageKey(conversationId), null);
    const message = stored ? `Forgot the poll "${stored.question}" on this device.` : "This device remembered no poll in this conversation.";
    await publish(host, { inConversation: true, poll: null, notice: message });
    return { message };
  }
  async function refresh(host) {
    const conversationId = current;
    if (conversationId === null || host.principal === null) return;
    const stored = await load(host, conversationId);
    if (stored?.status !== "open") return;
    const { poll, tally } = await count(host, stored, null);
    if (current !== conversationId) return;
    await showPoll(host, poll, tally, tally.found ? null : NOT_FOUND_TEXT);
  }
  function tick(host) {
    if (refreshing) return;
    refreshing = true;
    void serial(() => refresh(host)).catch(async (error) => {
      const explained = explainChatError(error);
      await publish(host, {
        notice: explained instanceof Error ? explained.message : String(explained)
      });
    }).finally(() => {
      refreshing = false;
    });
  }
  const command = (run) => ({
    run: (context) => serial(() => run(context))
  });
  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      poll: command(start),
      vote: command(vote),
      "poll.results": command(results),
      "poll.close": { dangerous: true, ...command(close) },
      "poll.clear": { dangerous: true, ...command(clear) }
    },
    async onReady(host) {
      await publish(host, {});
      timer = setInterval(() => tick(host), refreshMs);
    },
    async onPrincipalChanged(_principal, host) {
      current = null;
      await publish(host, { inConversation: false, poll: null, notice: null });
    },
    onShutdown() {
      if (timer !== null) clearInterval(timer);
    }
  });
}

// src/main.ts
await createPlugin().run();
