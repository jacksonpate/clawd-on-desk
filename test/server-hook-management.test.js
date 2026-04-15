"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");

class FakeWatcher extends EventEmitter {
  constructor(callback) {
    super();
    this._callback = callback;
    this.closed = false;
    this.closeCalls = 0;
  }

  emitChange(filename = "settings.json") {
    if (this.closed) return;
    this._callback("change", filename);
  }

  close() {
    this.closed = true;
    this.closeCalls++;
  }
}

function makeFakeHttpFactory() {
  const servers = [];
  function createHttpServer(handler) {
    const server = new EventEmitter();
    server._handler = handler;
    server.listenCalls = [];
    server.closed = false;
    server.listen = function (port, host) {
      this.listenCalls.push({ port, host });
      this.emit("listening");
    };
    server.close = function () {
      this.closed = true;
    };
    servers.push(server);
    return server;
  }
  return { createHttpServer, servers };
}

function makeFakeTimers() {
  const pending = [];
  return {
    setTimeout(fn) {
      const token = { fn, cleared: false };
      pending.push(token);
      return token;
    },
    clearTimeout(token) {
      if (token) token.cleared = true;
    },
    flush() {
      while (pending.length) {
        const token = pending.shift();
        if (!token.cleared) token.fn();
      }
    },
  };
}

function makeServer(overrides = {}) {
  const httpFactory = makeFakeHttpFactory();
  const timers = makeFakeTimers();
  const syncCalls = [];
  let lastWatcher = null;
  let settingsRaw = '{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"node \\"/tmp/clawd-hook.js\\" Stop"}]}]}}';

  const ctx = {
    manageClaudeHooksAutomatically: true,
    autoStartWithClaude: false,
    createHttpServer: httpFactory.createHttpServer,
    setImmediate: (fn) => fn(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    fs: {
      watch(_dir, callback) {
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() {
        return settingsRaw;
      },
    },
    syncClawdHooksImpl: () => syncCalls.push("claude"),
    syncGeminiHooksImpl: () => syncCalls.push("gemini"),
    syncCursorHooksImpl: () => syncCalls.push("cursor"),
    syncCodeBuddyHooksImpl: () => syncCalls.push("codebuddy"),
    syncKiroHooksImpl: () => syncCalls.push("kiro"),
    syncOpencodePluginImpl: () => syncCalls.push("opencode"),
    ...overrides,
  };

  return {
    api: initServer(ctx),
    syncCalls,
    timers,
    getWatcher: () => lastWatcher,
    setSettingsRaw: (raw) => { settingsRaw = raw; },
    servers: httpFactory.servers,
  };
}

describe("server Claude hook management", () => {
  it("startup syncs Claude hooks and starts watcher when automatic management is enabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: true,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "gemini", "cursor", "codebuddy", "kiro", "opencode"]);
    assert.ok(getWatcher(), "watcher should start when management is enabled");
  });

  it("startup skips Claude sync/watcher but still syncs other agents when automatic management is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: false,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "opencode"]);
    assert.strictEqual(getWatcher(), null);
  });

  it("stopClaudeSettingsWatcher is safe to call repeatedly", () => {
    const { api, getWatcher } = makeServer();

    const started = api.startClaudeSettingsWatcher();
    const watcher = getWatcher();
    const firstStop = api.stopClaudeSettingsWatcher();
    const secondStop = api.stopClaudeSettingsWatcher();

    assert.strictEqual(started, true);
    assert.ok(watcher);
    assert.strictEqual(firstStop, true);
    assert.strictEqual(secondStop, false);
    assert.strictEqual(watcher.closeCalls, 1);
  });

  it("watcher no longer re-syncs after it has been stopped", () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    api.stopClaudeSettingsWatcher();
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
  });

  it("disconnect-style restart does not reinstall Claude hooks when management stays disabled", () => {
    const first = makeServer({ manageClaudeHooksAutomatically: false });
    first.api.startHttpServer();
    first.api.cleanup();

    const second = makeServer({ manageClaudeHooksAutomatically: false });
    second.api.startHttpServer();

    assert.deepStrictEqual(first.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "opencode"]);
    assert.deepStrictEqual(second.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "opencode"]);
  });
});
