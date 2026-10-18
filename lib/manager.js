/**
 * MCP connection manager for the dsh-mcp-gateway plugin.
 *
 * One MCP Client per configured server, created lazily on first use and reused
 * until the idle timeout (default 10 min) or closeAll(). Nothing is spawned at
 * construction time. Failures throw as `mcp server "<name>": <op> failed: <cause>`;
 * nothing is swallowed, and env values are never logged.
 *
 * Contract (index.js is written against this):
 *   new McpManager({ servers, toolCallTimeoutMs, idleTimeoutMs, connectTimeoutMs, logger })
 *   async discover(name) -> { tools: ToolInfo[], instructions: string }
 *   async call(name, toolName, args, { signal, timeoutMs }) -> raw MCP CallToolResult
 *   async ensureInstructions(name) -> string        async disconnect(name) -> void
 *   status(name?) -> ServerStatus | ServerStatus[]  async closeAll() -> void
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';

const CLIENT_INFO = { name: 'dsh-mcp-gateway', version: '0.2.0' };
const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

/** Map an SDK Tool to the gateway's ToolInfo (schema kept verbatim). */
function toToolInfo(tool) {
  const info = { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema };
  if (tool.annotations !== undefined) info.annotations = tool.annotations;
  if (tool.outputSchema !== undefined) info.outputSchema = tool.outputSchema;
  return info;
}

export class McpManager {
  /** @param {{ servers: Record<string, object>, toolCallTimeoutMs?: number, idleTimeoutMs?: number, connectTimeoutMs?: number, logger?: object }} options */
  constructor({ servers, toolCallTimeoutMs = 60000, idleTimeoutMs = 600000, connectTimeoutMs = 60000, logger } = {}) {
    if (servers === null || typeof servers !== 'object') {
      throw new Error('mcp gateway: "servers" config object is required');
    }
    this.toolCallTimeoutMs = toolCallTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.logger = logger ?? NOOP_LOGGER;
    /** @type {Map<string, object>} */
    this.servers = new Map();
    for (const [name, config] of Object.entries(servers)) {
      this.servers.set(name, {
        name, config: { ...config, name },
        client: null, transport: null, state: 'idle', toolCount: 0,
        lastError: undefined, lastUsedAt: undefined, instructions: '',
        connectPromise: null, idleTimer: null, inflight: 0,
        // Bumped by disconnect(): an operation that started before a teardown
        // must not retry-reconnect a connection the caller just closed.
        generation: 0,
      });
    }
  }

  /** @param {string} [name] */
  status(name) {
    if (name !== undefined) return this._statusOf(this._entry(name));
    return [...this.servers.values()].map((entry) => this._statusOf(entry));
  }

  _statusOf(entry) {
    const status = { name: entry.name, state: entry.state, toolCount: entry.toolCount };
    if (entry.lastError !== undefined) status.lastError = entry.lastError;
    if (entry.lastUsedAt !== undefined) status.lastUsedAt = entry.lastUsedAt;
    return status;
  }

  /** @param {string} name */
  _entry(name) {
    const entry = this.servers.get(name);
    if (entry === undefined) throw new Error(`mcp server "${name}": not configured`);
    return entry;
  }

  /** Connect if needed and list every tool the server exposes. @param {string} name */
  async discover(name) {
    const entry = this._entry(name);
    let instructions = '';
    const tools = await this._withClient(name, 'listTools', async (client) => {
      const result = await client.listTools(undefined, { cacheMode: 'refresh', timeout: this.connectTimeoutMs });
      instructions = client.getInstructions() ?? '';
      return result.tools;
    });
    entry.toolCount = tools.length;
    entry.instructions = instructions;
    return { tools: tools.map(toToolInfo), instructions };
  }

  /** @param {string} name @param {string} toolName @param {object} [args] @param {{ signal?: AbortSignal, timeoutMs?: number }} [options] */
  async call(name, toolName, args, options = {}) {
    const entry = this._entry(name);
    const timeout = this._resolveCallTimeout(entry.config, options.timeoutMs);
    return this._withClient(name, `callTool "${toolName}"`, (client) =>
      client.callTool({ name: toolName, arguments: args ?? {} }, { timeout, signal: options.signal }),
    );
  }

  /** Server instructions from the initialize handshake, connecting if needed. @param {string} name */
  async ensureInstructions(name) {
    const entry = this._entry(name);
    if (entry.client !== null) {
      this._touch(name, entry);
      return entry.instructions;
    }
    const instructions = await this._withClient(name, 'connect', async (client) => client.getInstructions() ?? '');
    entry.instructions = instructions;
    return instructions;
  }

  /** Close one server's connection (no-op when never connected); waits for an in-flight connect. @param {string} name */
  async disconnect(name) {
    const entry = this._entry(name);
    entry.generation += 1;
    this._clearIdle(entry);
    const pending = entry.connectPromise;
    if (pending !== null) await pending.catch(() => {});
    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    entry.state = 'idle';
    if (client === null) return;
    try {
      await client.close();
      entry.lastError = undefined;
      this.logger.info(`mcp server "${name}": disconnected`);
    } catch (err) {
      entry.state = 'failed';
      entry.lastError = `close failed: ${errorMessage(err)}`;
      throw new Error(`mcp server "${name}": close failed: ${errorMessage(err)}`, { cause: err });
    }
  }

  async closeAll() {
    const errors = [];
    for (const name of this.servers.keys()) {
      try {
        await this.disconnect(name);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `mcp gateway: failed to close ${errors.length} servers`);
  }

  /** Call timeout precedence: config.requestTimeoutMs, explicit timeoutMs, toolCallTimeoutMs. */
  _resolveCallTimeout(config, explicitTimeoutMs) {
    if (typeof config.requestTimeoutMs === 'number' && config.requestTimeoutMs > 0) return config.requestTimeoutMs;
    if (typeof explicitTimeoutMs === 'number' && explicitTimeoutMs > 0) return explicitTimeoutMs;
    return this.toolCallTimeoutMs;
  }

  /** Run fn(client) on the live connection; retry exactly once if the connection dropped mid-operation. */
  async _withClient(name, operation, fn) {
    const entry = this._entry(name);
    entry.inflight += 1;
    const generation = entry.generation;
    try {
      const client = await this._ensureClient(name, entry);
      try {
        const result = await fn(client);
        this._touch(name, entry);
        return result;
      } catch (err) {
        if (entry.client !== client && entry.generation === generation) {
          this.logger.warn(`mcp server "${name}": ${operation} failed after the connection dropped, reconnecting once`);
          await this._discard(name, entry);
          try {
            const result = await fn(await this._ensureClient(name, entry));
            this._touch(name, entry);
            return result;
          } catch (retryErr) {
            throw this._wrap(name, operation, retryErr);
          }
        }
        throw this._wrap(name, operation, err);
      }
    } finally {
      entry.inflight -= 1;
      if (entry.inflight === 0 && entry.client !== null) this._touch(name, entry);
    }
  }

  async _ensureClient(name, entry) {
    if (entry.client !== null) return entry.client;
    if (entry.connectPromise !== null) return entry.connectPromise;
    entry.state = 'connecting';
    entry.connectPromise = this._connect(name, entry).finally(() => {
      entry.connectPromise = null;
    });
    return entry.connectPromise;
  }

  async _connect(name, entry) {
    const { config } = entry;
    let transport;
    try {
      transport = this._createTransport(name, config);
    } catch (err) {
      entry.state = 'failed';
      entry.lastError = errorMessage(err);
      throw err;
    }
    /** Bounded server stderr, included in connect failures to explain silent exits. */
    let stderrTail = '';
    transport.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000);
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    entry.transport = transport;
    transport.onerror = (err) => {
      if (entry.transport !== transport) return;
      entry.lastError = `transport error: ${errorMessage(err)}`;
      this.logger.error(`mcp server "${name}": transport error: ${errorMessage(err)}`);
      this._drop(name, entry);
    };
    transport.onclose = () => {
      if (entry.transport !== transport) return;
      entry.lastError = 'transport closed by server';
      this.logger.warn(`mcp server "${name}": transport closed by server`);
      this._drop(name, entry);
    };
    this.logger.info(`mcp server "${name}": connecting over ${config.url ? 'streamable http' : 'stdio'}`);
    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs });
    } catch (err) {
      const detail = stderrTail.trim();
      const message = `connect failed: ${errorMessage(err)}${detail.length > 0 ? `\n[server stderr]\n${detail}` : ''}`;
      entry.state = 'failed';
      entry.lastError = message;
      entry.transport = null;
      await client.close().catch((closeErr) => {
        this.logger.warn(`mcp server "${name}": cleanup after failed connect: ${errorMessage(closeErr)}`);
      });
      throw new Error(`mcp server "${name}": ${message}`, { cause: err });
    }
    entry.client = client;
    entry.state = 'connected';
    entry.lastError = undefined;
    entry.instructions = client.getInstructions() ?? '';
    this.logger.info(`mcp server "${name}": connected${entry.instructions ? ' (server exposes instructions)' : ''}`);
    return client;
  }

  /** stdio (command/args/env/cwd) or streamable HTTP (url/headers), per config. */
  _createTransport(name, config) {
    if (typeof config.url === 'string' && config.url.length > 0) {
      let url;
      try {
        url = new URL(config.url);
      } catch (err) {
        throw new Error(`mcp server "${name}": invalid url: ${errorMessage(err)}`, { cause: err });
      }
      const options = {};
      if (config.headers !== undefined) {
        if (config.headers === null || typeof config.headers !== 'object') {
          throw new Error(`mcp server "${name}": invalid config: "headers" must be an object`);
        }
        options.requestInit = { headers: config.headers };
      }
      return new StreamableHTTPClientTransport(url, options);
    }
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error(`mcp server "${name}": invalid config: needs "command" (stdio) or "url" (streamable http)`);
    }
    if (config.args !== undefined && !Array.isArray(config.args)) {
      throw new Error(`mcp server "${name}": invalid config: "args" must be an array`);
    }
    const env = { ...scrubbedParentEnv(), ...(config.env ?? {}) };
    for (const [key, value] of Object.entries(env)) {
      // Never echo the value: it may be a credential.
      if (typeof value !== 'string') throw new Error(`mcp server "${name}": invalid config: env ${key} must be a string`);
    }
    const params = { command: config.command, args: config.args ?? [], env, stderr: 'pipe' };
    if (typeof config.cwd === 'string' && config.cwd.length > 0) params.cwd = config.cwd;
    return new StdioClientTransport(params);
  }

  /** Mark the connection failed and drop the client so the next use reconnects; safe inside transport handlers. */
  _drop(name, entry) {
    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    entry.state = 'failed';
    this._clearIdle(entry);
    if (client === null) return;
    void client.close().catch((err) => {
      this.logger.warn(`mcp server "${name}": closing dropped connection: ${errorMessage(err)}`);
    });
  }

  /** Shut the current connection down before a single reconnect attempt. */
  async _discard(name, entry) {
    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    this._clearIdle(entry);
    if (client === null) {
      entry.state = 'idle';
      return;
    }
    try {
      await client.close();
    } catch (err) {
      this.logger.warn(`mcp server "${name}": closing dropped connection: ${errorMessage(err)}`);
    }
    entry.state = 'idle';
  }

  _touch(name, entry) {
    entry.lastUsedAt = Date.now();
    this._clearIdle(entry);
    if (!(this.idleTimeoutMs > 0)) return;
    const timer = setTimeout(() => this._onIdle(name, entry), this.idleTimeoutMs);
    timer.unref();
    entry.idleTimer = timer;
  }

  _clearIdle(entry) {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  _onIdle(name, entry) {
    entry.idleTimer = null;
    if (entry.inflight > 0) {
      this._touch(name, entry);
      return;
    }
    if (entry.client === null) return;
    this.logger.info(`mcp server "${name}": idle, closing connection`);
    void this.disconnect(name).catch((err) => {
      this.logger.warn(`mcp server "${name}": idle close failed: ${errorMessage(err)}`);
    });
  }

  /** Prefix an error unless it already carries this server's prefix. */
  _wrap(name, operation, err) {
    const prefix = `mcp server "${name}":`;
    const message = errorMessage(err);
    if (message.startsWith(prefix)) return err instanceof Error ? err : new Error(message);
    return new Error(`${prefix} ${operation} failed: ${message}`, { cause: err });
  }
}

export default McpManager;
