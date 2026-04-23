// src/terminal-manager.js — CLAWD-BOT's 4 hidden Claude terminals
// Each terminal is a named context with its own conversation history.
// Messages are sent via `claude -p` (no TTY needed, reliable on Windows).
// Terminals are always-on, always 4, spawned and managed by CLAWD-BOT.

"use strict";

const { app }  = require("electron");
const { spawn } = require("child_process");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

const CLAUDE_BIN  = "C:\\Users\\jacks\\.local\\bin\\claude.exe";
const NAMES_FILE  = path.join(app.getPath("userData"), "clawd-terminal-names.json");
const DEFAULT_NAMES    = ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"];
const TERMINAL_IDS     = ["t1", "t2", "t3", "t4"];
// Per-terminal Claude model. Passed to `claude --model <alias>`.
// "opus" → latest Opus, "sonnet" → latest Sonnet, "haiku" → latest Haiku.
const TERMINAL_MODELS  = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-4-6", "claude-opus-4-7"];
const TERMINAL_COLORS  = ["#3c6f61", "#b1c9db", "#a98dc5", "#e86373"]; // dusty peach · purple lavender · mint green · muted sky blue

// Empty MCP config — prevents CLAWD-BOT's spawned terminals from loading
// any MCP servers on startup (they don't need them for plain chat).
const EMPTY_MCP_CONFIG = path.join(app.getPath("userData"), "clawd-empty-mcp.json");
try {
  fs.writeFileSync(EMPTY_MCP_CONFIG, JSON.stringify({ mcpServers: {} }), "utf8");
} catch (_) {}

function loadNames() {
  try {
    const raw = fs.readFileSync(NAMES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return TERMINAL_IDS.map((id, i) => (parsed[id] || DEFAULT_NAMES[i]));
  } catch (_) {
    return [...DEFAULT_NAMES];
  }
}

function saveNames(terminals) {
  try {
    const obj = {};
    terminals.forEach(t => { obj[t.id] = t.name; });
    fs.writeFileSync(NAMES_FILE, JSON.stringify(obj, null, 2));
  } catch (_) {}
}

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[mGKHFJA-Z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\r/g, "")
    .trim();
}

const HOME_DIR = "C:\\";

function initTerminalManager(ctx) {
  const names = [...DEFAULT_NAMES]; // always boot fresh — no persisted names

  // 4 terminals — always present
  const terminals = TERMINAL_IDS.map((id, i) => ({
    id,
    name:    names[i],
    color:   TERMINAL_COLORS[i],
    model:   TERMINAL_MODELS[i],
    history: [],            // UI-only log: [{ role: "user"|"claude", text }]
    proc:    null,          // active child process, if any
    busy:    false,
    state:   "idle",        // idle | thinking
    cwd:     HOME_DIR,
    queue:   [],
    sessionId: crypto.randomUUID(), // persistent Claude Code session id
    sessionStarted: false,          // true after first message for this session
  }));

  let activeId = "t1"; // which terminal chat routes to

  // ── Register terminals as sessions so the pet animates ─────────────────
  function syncSessionsFromTerminals() {
    for (const t of terminals) {
      ctx.sessions.set(t.id, {
        state:        t.state === "thinking" ? "working" : "idle",
        updatedAt:    Date.now(),
        sourcePid:    0,
        cwd:          "",
        editor:       "clawd-bot",
        pidChain:     null,
        agentPid:     null,
        agentId:      "clawd-bot",
        host:         null,
        headless:     false,
        pidReachable: true,
        clawdBot:     true,
        terminalId:   t.id,
        terminalName: t.name,
        color:        t.color,
        displayHint:  null,
        resumeState:  null,
      });
    }
  }
  syncSessionsFromTerminals();

  // ── Slash-command handler ──
  // Runs locally on the terminal state without invoking Claude. Returns true
  // if the message was handled (so we skip the spawn), false otherwise.
  function tryHandleSlashCommand(t, userText, onResponse) {
    const txt = userText.trim();
    if (!txt.startsWith("/")) return false;
    const parts = txt.slice(1).split(/\s+/);
    const cmd   = (parts[0] || "").toLowerCase();
    const arg   = parts.slice(1).join(" ").trim();

    // CLAWD-BOT-specific commands only. Everything else (including /clear,
    // /help, /model, /compact, /memory, /cost, /mcp, /agents, /hooks, /fast,
    // /keybindings, etc.) passes through to Claude Code — real responses,
    // just like PowerShell.
    if (cmd === "restart") {
      if (t.proc) { try { t.proc.kill("SIGKILL"); } catch (_) {} t.proc = null; }
      t.history = [];
      t.queue = [];
      t.busy = false;
      t.state = "idle";
      t.sessionId = crypto.randomUUID();
      t.sessionStarted = false;
      syncSessionsFromTerminals();
      onResponse("♻️ Restarted — new session, process killed, history cleared.", null);
      return true;
    }
    if (cmd === "cwd") {
      if (!arg) { onResponse(`Current cwd: ${t.cwd}`, null); return true; }
      t.cwd = arg;
      onResponse(`✓ cwd set to ${arg}`, null);
      return true;
    }
    if (cmd === "name" || cmd === "rename") {
      if (!arg) { onResponse(`Current name: ${t.name}`, null); return true; }
      t.name = arg;
      syncSessionsFromTerminals();
      if (ctx.pushSessionUpdate) ctx.pushSessionUpdate();
      onResponse(`✓ Renamed to ${arg}`, null);
      return true;
    }
    // Unknown — fall through to Claude Code so its native slash handler answers.
    return false;
  }

  // ── Send message to a terminal ──────────────────────────────────────────
  // onResponse(text, err)                — final result
  // onEvent({type, ...})                  — streaming events (optional)
  //   type: "text"        {delta: string}                  (assistant text chunk)
  //   type: "tool_use"    {name, input, id}                (tool about to run)
  //   type: "tool_result" {tool_use_id, content, is_error} (tool finished)
  //   type: "thinking"    {delta: string}                  (extended thinking)
  //   type: "system"      {subtype, ...}                   (init / config)
  function sendToTerminal(terminalId, userText, onResponse, onEvent) {
    const t = terminals.find(x => x.id === terminalId);
    if (!t) { onResponse(null, "Terminal not found: " + terminalId); return; }
    // Handle slash commands locally before touching Claude.
    if (tryHandleSlashCommand(t, userText, onResponse)) return;
    if (t.busy) {
      t.queue.push({ userText, onResponse, onEvent });
      return;
    }
    _runTerminal(t, userText, onResponse, onEvent);
  }

  function _runTerminal(t, userText, onResponse, onEvent) {
    t.busy  = true;
    t.state = "thinking";
    t.history.push({ role: "user", text: userText });
    syncSessionsFromTerminals();
    if (ctx.resolveDisplayState) ctx.resolveDisplayState();

    // Claude Code handles its own session context — we just pass the raw message.
    const prompt = userText;

    let stderr = "";
    let rawStdout = ""; // full un-parsed stdout (for slash-command / TUI fallbacks)
    let finalText = "";
    let lineBuf   = "";
    let proc;
    try {
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (t.model) args.push("--model", t.model);
      // Use persistent session: --session-id creates it on first run,
      // --resume continues it on subsequent runs.
      if (t.sessionStarted) {
        args.push("--resume", t.sessionId);
      } else {
        args.push("--session-id", t.sessionId);
      }
      proc = t.proc = spawn(CLAUDE_BIN, args, {
        shell: false,
        env: process.env,
        cwd: t.cwd || HOME_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      t.busy = false; t.state = "idle";
      syncSessionsFromTerminals();
      onResponse(null, "Failed to start claude: " + err.message);
      if (t.queue.length > 0) {
        const next = t.queue.shift();
        setImmediate(() => _runTerminal(t, next.userText, next.onResponse, next.onEvent));
      }
      return;
    }

    // ── Stream-JSON line parser ──
    function safeEmit(evt) {
      if (!onEvent) return;
      try { onEvent(evt); } catch (_) {}
    }

    function handleJsonLine(line) {
      line = line.trim();
      if (!line) return;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; }

      if (obj.type === "system") {
        safeEmit({ type: "system", subtype: obj.subtype, raw: obj });
        return;
      }

      if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === "text" && block.text) {
            finalText += block.text;
            safeEmit({ type: "text", delta: block.text });
          } else if (block.type === "thinking" && block.thinking) {
            safeEmit({ type: "thinking", delta: block.thinking });
          } else if (block.type === "tool_use") {
            safeEmit({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return;
      }

      if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === "tool_result") {
            safeEmit({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: !!block.is_error,
            });
          }
        }
        return;
      }

      if (obj.type === "result") {
        if (typeof obj.result === "string" && obj.result) finalText = obj.result;
        safeEmit({ type: "result", subtype: obj.subtype, raw: obj });
        return;
      }
    }

    // Once the child process is running, this terminal's session exists.
    t.sessionStarted = true;

    proc.stdout.on("data", chunk => {
      const s = chunk.toString();
      rawStdout += s;
      lineBuf += s;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        handleJsonLine(line);
      }
    });
    proc.stderr.on("data", c => { stderr += c.toString(); });

    // No timeout — Claude can take as long as he needs, exactly like Claude Code.

    function finishAndDrain() {
      t.busy = false; t.state = "idle"; t.proc = null;
      syncSessionsFromTerminals();
      if (ctx.resolveDisplayState) ctx.resolveDisplayState();
      if (t.queue.length > 0) {
        const next = t.queue.shift();
        setImmediate(() => _runTerminal(t, next.userText, next.onResponse, next.onEvent));
      }
    }

    proc.on("error", err => {
      onResponse(null, "Error: " + err.message);
      finishAndDrain();
    });

    proc.on("close", () => {
      // Flush any leftover buffered line
      if (lineBuf.trim()) handleJsonLine(lineBuf);
      lineBuf = "";

      let text = stripAnsi(finalText);
      if (!text) {
        // Fall back to raw stdout for things that didn't emit stream-json —
        // e.g. Claude Code's interactive slash commands printing plain text.
        const raw = stripAnsi(rawStdout);
        if (raw) text = raw;
      }
      if (text) {
        t.history.push({ role: "claude", text });
        onResponse(text, null);
      } else {
        const errText = stripAnsi(stderr) || "No response from Claude.";
        onResponse(null, errText);
      }
      finishAndDrain();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function getTerminals()       { return terminals.map(t => ({ ...t })); }
  function getActiveId()        { return activeId; }
  function getActiveTerminal()  { return terminals.find(t => t.id === activeId); }

  function setActiveTerminal(id) {
    if (!TERMINAL_IDS.includes(id)) return;
    activeId = id;
    // Pin this terminal's session so the pet focuses on it
    if (ctx.pinnedSessionIds) {
      ctx.pinnedSessionIds.clear();
      ctx.pinnedSessionIds.add(id);
    }
    if (ctx.rebuildAllMenus) ctx.rebuildAllMenus();
  }

  function renameTerminal(id, newName) {
    const t = terminals.find(x => x.id === id);
    if (!t) return;
    t.name = (newName || "").trim() || t.name;
    saveNames(terminals);
    syncSessionsFromTerminals();
    if (ctx.rebuildAllMenus) ctx.rebuildAllMenus();
    // Always push — the bubble checks which terminal is pinned and updates header
    if (ctx.pushSessionUpdate) ctx.pushSessionUpdate();
  }

  function clearHistory(id) {
    const t = terminals.find(x => x.id === id);
    if (t) t.history = [];
  }

  // Cancel a single terminal's in-flight process — drains the queue.
  function cancelTerminal(terminalId) {
    const t = terminals.find(x => x.id === terminalId);
    if (!t) return false;
    let killed = false;
    if (t.proc) {
      try { t.proc.kill("SIGKILL"); killed = true; } catch (_) {}
      t.proc = null;
    }
    // Clear any queued messages for this terminal too
    t.queue = [];
    t.busy = false;
    t.state = "idle";
    syncSessionsFromTerminals();
    if (ctx.resolveDisplayState) ctx.resolveDisplayState();
    return killed;
  }

  // Kill any in-flight claude processes — called on app quit
  function killAll() {
    for (const t of terminals) {
      if (t.proc) {
        try { t.proc.kill("SIGKILL"); } catch (_) {}
        t.proc = null;
      }
      t.busy = false; t.state = "idle";
      t.queue = []; // discard any queued messages
    }
  }

  // Expose on ctx for chat.js and settings
  ctx.terminalManager = {
    getTerminals,
    getActiveId,
    getActiveTerminal,
    setActiveTerminal,
    renameTerminal,
    clearHistory,
    killAll,
    cancelTerminal,
    sendToTerminal,
    TERMINAL_IDS,
  };

  // Set t1 as the default pinned session
  setActiveTerminal("t1");

  return ctx.terminalManager;
}

module.exports = { initTerminalManager };
