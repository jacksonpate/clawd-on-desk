// src/chat.js — Per-terminal chat bubbles (one window per terminal)
// T1=left, T2=right, T3=top, T4=bottom of pet. Draggable. Never close on blur.

const { BrowserWindow, clipboard, ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");

const isMac   = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin   = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";
const WIN_TOPMOST_LEVEL = "screen-saver";

const BUBBLE_W = 340;
const BUBBLE_H = 160;
const MARGIN   = 10;

const EDITOR_COLOR = {
  claude:      "#fb923c",
  cmd:         "#2dd4bf",
  obsidian:    "#a78bfa",
  antigravity: "#34d399",
};
const DEFAULT_COLOR = "#6b7280";

// Default anchor side per terminal
const TERMINAL_SIDE = { t1: "left", t2: "right", t3: "top", t4: "bottom" };
// Cardinal fallback order (no diagonals — stack near existing windows instead)
const SIDE_FALLBACK = ["left", "right", "top", "bottom"];

module.exports = function initChat(ctx) {

const chatWins      = new Map(); // terminalId → BrowserWindow
const winHeight     = new Map(); // terminalId → measured height (px)
const userDragged   = new Set(); // terminals the user has manually moved
const progMove      = new Set(); // terminals currently being moved by code (not user)
const messageLogs   = new Map(); // terminalId → Array<{role,text}> — persists across bubble open/close
const snapTimers    = new Map(); // terminalId → debounce handle for snap-back check
const MAX_LOG       = 100;       // max messages to keep per terminal
let ipcRegistered  = false;
let suppressUnfreeze = false;
let manuallyFrozen   = false;

// ── Position helpers ────────────────────────────────────────────────────────

function checkFits(x, y, h, wa) {
  return x >= wa.x && x + BUBBLE_W <= wa.x + wa.width &&
         y >= wa.y && y + h        <= wa.y + wa.height;
}

function clamp(x, y, h, wa) {
  return {
    x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width  - BUBBLE_W))),
    y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - h))),
  };
}

// Visual center offset — shifts all 4 bubbles relative to the robot's actual center
const BUBBLE_OFFSET_X = 10;  // px right
const BUBBLE_OFFSET_Y = 45;  // px down

function computeSide(side, pet, wa, h) {
  let x, y;
  switch (side) {
    case "left":   x = pet.x - BUBBLE_W - MARGIN;           y = pet.y + (pet.height - h) / 2; break;
    case "right":  x = pet.x + pet.width + MARGIN;          y = pet.y + (pet.height - h) / 2; break;
    case "top":    x = pet.x + (pet.width - BUBBLE_W) / 2;  y = pet.y - h - MARGIN;           break;
    case "bottom": x = pet.x + (pet.width - BUBBLE_W) / 2;  y = pet.y + pet.height + MARGIN;  break;
    default:       x = pet.x - BUBBLE_W - MARGIN;           y = pet.y;
  }
  x += BUBBLE_OFFSET_X;
  y += BUBBLE_OFFSET_Y;
  const fits = checkFits(x, y, h, wa);
  return { ...clamp(x, y, h, wa), fits };
}

// Positions relative to an existing open chat window (above / below / left / right of it)
function chatRelativePositions(ref, wa, h) {
  const candidates = [
    { x: ref.x,                      y: ref.y - h - MARGIN },      // above the chat
    { x: ref.x,                      y: ref.y + ref.height + MARGIN }, // below the chat
    { x: ref.x - BUBBLE_W - MARGIN,  y: ref.y },                   // left of the chat
    { x: ref.x + ref.width + MARGIN, y: ref.y },                   // right of the chat
  ];
  return candidates
    .filter(p => checkFits(p.x, p.y, h, wa))
    .map(p => ({ ...clamp(p.x, p.y, h, wa), fits: true }));
}

function getPositionForTerminal(terminalId, h) {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 100, y: 100 };
  const pet = ctx.win.getBounds();
  const wa  = ctx.getNearestWorkArea(pet.x + pet.width / 2, pet.y + pet.height / 2);
  h = h || BUBBLE_H;

  // 1. Try pet-relative cardinal sides (primary first)
  const primary = TERMINAL_SIDE[terminalId] || "left";
  const order   = [primary, ...SIDE_FALLBACK.filter(s => s !== primary)];
  for (const side of order) {
    const pos = computeSide(side, pet, wa, h);
    if (pos.fits) return pos;
  }

  // 2. Try stacking around any already-open chat windows
  for (const [tid, win] of chatWins) {
    if (tid === terminalId || !win || win.isDestroyed()) continue;
    const ref = win.getBounds();
    const candidates = chatRelativePositions(ref, wa, h);
    if (candidates.length) return candidates[0];
  }

  // 3. Last resort: clamp the primary side (pet is in a very tight corner)
  return computeSide(primary, pet, wa, h);
}

// ── Message log helpers ─────────────────────────────────────────────────────

function logMessage(terminalId, role, text) {
  if (!messageLogs.has(terminalId)) messageLogs.set(terminalId, []);
  const log = messageLogs.get(terminalId);
  log.push({ role, text });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

function getLog(terminalId) {
  return messageLogs.get(terminalId) || [];
}

// ── Snap-back proximity check ───────────────────────────────────────────────

const SNAP_RADIUS_H = 175;  // px — left/right terminals
const SNAP_RADIUS_V = 120;  // px — top/bottom terminals (rectangle proportions)

function checkSnapBack(terminalId) {
  if (!userDragged.has(terminalId)) return;
  const win = chatWins.get(terminalId);
  if (!win || win.isDestroyed()) return;
  if (!ctx.win || ctx.win.isDestroyed()) return;

  const pet   = ctx.win.getBounds();
  const bub   = win.getBounds();
  const petCx = pet.x + pet.width  / 2;
  const petCy = pet.y + pet.height / 2;
  const bubCx = bub.x + bub.width  / 2;
  const bubCy = bub.y + bub.height / 2;
  const side   = TERMINAL_SIDE[terminalId];
  const snapR  = (side === "top" || side === "bottom") ? SNAP_RADIUS_V : SNAP_RADIUS_H;
  const dist   = Math.hypot(bubCx - petCx, bubCy - petCy);
  if (dist >= snapR) return;

  // Each terminal only snaps from its designated side
  const onSide =
    side === "left"   ? bubCx <= petCx :
    side === "right"  ? bubCx >= petCx :
    side === "top"    ? bubCy <= petCy :
    side === "bottom" ? bubCy >= petCy : true;

  if (onSide) {
    userDragged.delete(terminalId);
    repositionTerminal(terminalId);
  }
}

// ── Session info ────────────────────────────────────────────────────────────

function getSessionInfoForTerminal(terminalId) {
  const tm = ctx.terminalManager;
  if (tm && terminalId) {
    const t = tm.getTerminals().find(x => x.id === terminalId);
    if (t) return { name: t.name, color: t.color };
  }
  return { name: "C-L-A-W-D-B-O-T", color: "#7A9E7E" };
}

function getActiveTerminalId() {
  const tm     = ctx.terminalManager;
  const pinned = ctx.pinnedSessionIds;
  if (!tm) return null;
  return tm.TERMINAL_IDS.find(id => pinned && pinned.has(id)) || tm.getActiveId() || null;
}

// ── Find terminal ID from a WebContents sender ──────────────────────────────

function findTerminalBySender(sender) {
  for (const [tid, win] of chatWins) {
    if (win && !win.isDestroyed() && win.webContents === sender) return tid;
  }
  return null;
}

// ── Window management ───────────────────────────────────────────────────────

function setBoundsTracked(terminalId, win, bounds) {
  progMove.add(terminalId);
  win.setBounds(bounds);
  // Clear flag after Electron processes the move event (next tick)
  setImmediate(() => progMove.delete(terminalId));
}

function repositionTerminal(terminalId) {
  const win = chatWins.get(terminalId);
  if (!win || win.isDestroyed()) return;
  const h = (winHeight.get(terminalId) || BUBBLE_H) + 4;

  if (userDragged.has(terminalId)) {
    // User placed this window — only update height, never move x/y
    const cur = win.getBounds();
    setBoundsTracked(terminalId, win, { ...cur, height: h });
    return;
  }

  // Still anchored — update position + height
  const { x, y } = getPositionForTerminal(terminalId, h - 4);
  setBoundsTracked(terminalId, win, { x, y, width: BUBBLE_W, height: h });
}

function reposition() {
  for (const [tid] of chatWins) repositionTerminal(tid);
}

function showTerminal(terminalId) {
  if (!terminalId) return;

  const existing = chatWins.get(terminalId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    existing.webContents.send("chat-session-update", getSessionInfoForTerminal(terminalId));
    return;
  }

  const h = winHeight.get(terminalId) || BUBBLE_H;
  const { x, y } = getPositionForTerminal(terminalId, h);

  const win = new BrowserWindow({
    width: BUBBLE_W,
    height: h + 4,
    x, y,
    show:        false,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    resizable:   false,
    movable:     true,
    skipTaskbar: true,
    hasShadow:   false,
    focusable:   true,
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac   ? { type: "panel" }           : {}),
    webPreferences: {
      preload:          path.join(__dirname, "preload-chat-bubble.js"),
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  if (isWin) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL, 1);

  chatWins.set(terminalId, win);
  win.loadFile(path.join(__dirname, "chat-bubble.html"));

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("chat-show", getSessionInfoForTerminal(terminalId));
    win.show();
    win.focus();
    if (chatWins.size === 1 && ctx.freezeFollower) ctx.freezeFollower();
  });

  // Detect user drag — moved event without our programmatic flag = user dragged it
  win.on("moved", () => {
    if (!progMove.has(terminalId)) {
      userDragged.add(terminalId); // now free-floating, stop anchoring to pet
      // Debounced snap-back check — if bubble released near bot, re-anchor
      clearTimeout(snapTimers.get(terminalId));
      snapTimers.set(terminalId, setTimeout(() => checkSnapBack(terminalId), 400));
    }
  });

  win.on("closed", () => {
    chatWins.delete(terminalId);
    userDragged.delete(terminalId); // next open starts anchored again
    progMove.delete(terminalId);
    if (chatWins.size === 0 && !suppressUnfreeze && !manuallyFrozen && ctx.unfreezeFollower) {
      ctx.unfreezeFollower();
    }
    suppressUnfreeze = false;
  });
}

function show() {
  showTerminal(getActiveTerminalId());
}

function hide(terminalId) {
  if (terminalId) {
    const win = chatWins.get(terminalId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send("chat-hide");
    setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 350);
  } else {
    for (const [tid, win] of chatWins) {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send("chat-hide");
      setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 350);
    }
  }
}

// ── Message routing ─────────────────────────────────────────────────────────

const FREEZE_CMDS   = /^(be still|stay|stay still|freeze|stop moving|don'?t move)[.,!?]*$/i;
const UNFREEZE_CMDS = /^(you'?re? (good|free)|move|go|unfreeze|you can move( now)?|start moving)[.,!?]*$/i;

function sendMessage(msg, terminalId) {
  if (!msg) return;
  const trimmed = msg.trim();

  // ── Chat history recall — "chat memory", "chat past", "past chat" ────────
  if (/^(chat memory|chat past|past chat)[.,!?]*$/i.test(trimmed)) {
    const win = terminalId && chatWins.get(terminalId);
    if (win && !win.isDestroyed()) {
      const log = getLog(terminalId);
      if (!log.length) {
        win.webContents.send("chat-message", { text: "(no history yet)" });
      } else {
        log.forEach(entry => {
          const channel = entry.role === "user" ? "chat-user-message" : "chat-message";
          win.webContents.send(channel, { text: entry.text });
        });
      }
    }
    return;
  }

  // Freeze/unfreeze — handled locally
  if (FREEZE_CMDS.test(trimmed)) {
    manuallyFrozen   = true;
    suppressUnfreeze = true;
    if (ctx.freezeFollower) ctx.freezeFollower();
    return;
  }
  if (UNFREEZE_CMDS.test(trimmed)) {
    manuallyFrozen   = false;
    suppressUnfreeze = false;
    if (ctx.unfreezeFollower) ctx.unfreezeFollower();
    return;
  }

  // ── CLAWD-BOT terminal routing ──────────────────────────────────────────
  const tm = ctx.terminalManager;
  if (tm && terminalId && tm.TERMINAL_IDS.includes(terminalId)) {
    logMessage(terminalId, "user", msg);
    const win = chatWins.get(terminalId);
    if (win && !win.isDestroyed()) {
      win.webContents.send("chat-user-message", { text: msg });
      win.webContents.send("chat-thinking", true);
    }
    tm.sendToTerminal(terminalId, msg, (response, err) => {
      const responseText = response || ("⚠ " + err);
      logMessage(terminalId, "claude", responseText);
      const w = chatWins.get(terminalId);
      if (w && !w.isDestroyed()) {
        w.webContents.send("chat-thinking", false);
        w.webContents.send("chat-message", { text: responseText });
      }
      if (ctx.showResponse) ctx.showResponse(responseText, terminalId);
    });
    return;
  }

  // ── Fallback: clipboard paste to editor (non-terminal sessions) ──────────
  clipboard.writeText(msg);

  const pinned  = ctx.pinnedSessionIds;
  const hasPins = pinned && pinned.size > 0;

  if (isWin) {
    let targetCwd = "", targetEditor = "", targetSourcePid = 0;
    if (ctx.sessions) {
      let latest = 0;
      for (const [id, s] of ctx.sessions) {
        if (hasPins && !pinned.has(id)) continue;
        if (s.clawdBot) continue;
        if ((s.updatedAt || 0) >= latest) {
          latest = s.updatedAt || 0;
          targetCwd = s.cwd || ""; targetEditor = s.editor || ""; targetSourcePid = s.sourcePid || 0;
        }
      }
    }
    const folderName = targetCwd ? targetCwd.split(/[\\/]/).pop() : "";
    const msgB64 = Buffer.from(msg, "utf16le").toString("base64");
    const ps = `
$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${msgB64}"))
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($text)
[System.Windows.Forms.SendKeys]::SendWait("^v{ENTER}")
`;
    if (ctx.allowAnyForeground) ctx.allowAnyForeground();
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, () => {});
  } else if (isMac && ctx.focusTerminalWindow) {
    let bestPid = null, bestCwd = null, bestEditor = null, bestChain = null;
    if (ctx.sessions) {
      let latest = 0;
      for (const [id, s] of ctx.sessions) {
        if (hasPins && !pinned.has(id)) continue;
        if (s.sourcePid && (s.updatedAt || 0) >= latest) {
          latest = s.updatedAt || 0;
          bestPid = s.sourcePid; bestCwd = s.cwd; bestEditor = s.editor; bestChain = s.pidChain;
        }
      }
    }
    if (bestPid) ctx.focusTerminalWindow(bestPid, bestCwd, bestEditor, bestChain);
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("chat-send", (event, msg) => {
    const terminalId = findTerminalBySender(event.sender);
    sendMessage(msg, terminalId);
  });

  ipcMain.on("chat-close", (event) => {
    const terminalId = findTerminalBySender(event.sender);
    if (terminalId) hide(terminalId);
  });

  ipcMain.on("chat-height", (event, h) => {
    const terminalId = findTerminalBySender(event.sender);
    if (!terminalId) return;
    winHeight.set(terminalId, h);
    repositionTerminal(terminalId);
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

function cleanup() {
  for (const [, win] of chatWins) {
    if (win && !win.isDestroyed()) win.close();
  }
  chatWins.clear();
  winHeight.clear();
}

function pushSessionUpdate(terminalId) {
  if (terminalId) {
    // Update specific terminal's window
    const win = chatWins.get(terminalId);
    if (win && !win.isDestroyed()) {
      win.webContents.send("chat-session-update", getSessionInfoForTerminal(terminalId));
    }
  } else {
    // Update all open windows
    for (const [tid, win] of chatWins) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("chat-session-update", getSessionInfoForTerminal(tid));
      }
    }
  }
}

return { show, hide, registerIpc, cleanup, pushSessionUpdate, reposition };

};
