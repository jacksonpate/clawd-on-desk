// src/terminal-manager.js — CLAWD-BOT's 4 hidden Claude terminals
// Each terminal is a named context with its own conversation history.
// Messages are sent via `claude -p` (no TTY needed, reliable on Windows).
// Terminals are always-on, always 4, spawned and managed by CLAWD-BOT.

"use strict";

const { app }  = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs   = require("fs");

const CLAUDE_BIN  = "C:\\Users\\jacks\\.local\\bin\\claude.exe";
const NAMES_FILE  = path.join(app.getPath("userData"), "clawd-terminal-names.json");
const DEFAULT_NAMES    = ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"];
const TERMINAL_IDS     = ["t1", "t2", "t3", "t4"];
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
    history: [],   // [{ role: "user"|"claude", text }]
    proc:    null, // active child process, if any
    busy:    false,
    state:   "idle", // idle | thinking
    cwd:     HOME_DIR, // working directory — defaults to user home
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

  // ── Send message to a terminal ──────────────────────────────────────────
  function sendToTerminal(terminalId, userText, onResponse) {
    const t = terminals.find(x => x.id === terminalId);
    if (!t) { onResponse(null, "Terminal not found: " + terminalId); return; }
    if (t.busy)  { onResponse(null, "Terminal is busy — please wait."); return; }

    t.busy  = true;
    t.state = "thinking";
    t.history.push({ role: "user", text: userText });
    require("fs").appendFileSync("C:/tmp/clawd-debug.log", `sendToTerminal: id=${terminalId} name=${t.name}\n`);
    syncSessionsFromTerminals();
    if (ctx.resolveDisplayState) ctx.resolveDisplayState();

    // Build prompt with history prefix
    let prompt = userText;
    if (t.history.length > 1) {
      const ctxLines = t.history.slice(0, -1)
        .map(m => (m.role === "user" ? "User: " : "Claude: ") + m.text)
        .join("\n");
      prompt = `Previous conversation:\n${ctxLines}\n\nUser: ${userText}`;
    }

    let stdout = "", stderr = "";
    let proc;
    try {
      proc = t.proc = spawn(CLAUDE_BIN, [
        "-p", prompt,
        "--output-format", "text",
        "--mcp-config", EMPTY_MCP_CONFIG,
        "--dangerously-skip-permissions",
      ], {
        shell: false,
        env: process.env,
        cwd: t.cwd || HOME_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      t.busy = false; t.state = "idle";
      syncSessionsFromTerminals();
      onResponse(null, "Failed to start claude: " + err.message);
      return;
    }

    proc.stdout.on("data", c => { stdout += c.toString(); });
    proc.stderr.on("data", c => { stderr += c.toString(); });

    // Kill after 60 seconds if claude hasn't responded
    const killTimer = setTimeout(() => {
      if (t.proc === proc) {
        try { proc.kill("SIGKILL"); } catch (_) {}
        t.proc = null;
        t.busy = false; t.state = "idle";
        syncSessionsFromTerminals();
        onResponse(null, "Claude took too long to respond (60s timeout). Try again.");
      }
    }, 60000);

    proc.on("error", err => {
      clearTimeout(killTimer);
      t.busy = false; t.state = "idle"; t.proc = null;
      syncSessionsFromTerminals();
      if (ctx.resolveDisplayState) ctx.resolveDisplayState();
      onResponse(null, "Error: " + err.message);
    });

    proc.on("close", () => {
      clearTimeout(killTimer);
      t.busy = false; t.state = "idle"; t.proc = null;
      syncSessionsFromTerminals();
      if (ctx.resolveDisplayState) ctx.resolveDisplayState(); // wake pet so it returns to idle
      const text = stripAnsi(stdout);
      if (text) {
        t.history.push({ role: "claude", text });
        onResponse(text, null);
      } else {
        const errText = stripAnsi(stderr) || "No response from Claude.";
        onResponse(null, errText);
      }
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

  // Kill any in-flight claude processes — called on app quit
  function killAll() {
    for (const t of terminals) {
      if (t.proc) {
        try { t.proc.kill("SIGKILL"); } catch (_) {}
        t.proc = null;
      }
      t.busy = false; t.state = "idle";
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
    sendToTerminal,
    TERMINAL_IDS,
  };

  // Set t1 as the default pinned session
  setActiveTerminal("t1");

  return ctx.terminalManager;
}

module.exports = { initTerminalManager };
