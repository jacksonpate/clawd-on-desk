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

const BUBBLE_W = 337;
const BUBBLE_H = 214;
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
const userResized   = new Set(); // terminals the user has manually resized — stops auto-height
const progMove      = new Set(); // terminals currently being moved by code (not user)
const progResize    = new Set(); // terminals currently being resized by code (not user)
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

// Freeze the pet only while at least one OPEN chat is still anchored (attached
// to his body). If every open chat has been dragged away, let him walk again.
function updateFollowerFreeze() {
  if (manuallyFrozen) return;
  let anyAnchored = false;
  for (const [tid, win] of chatWins) {
    if (!win || win.isDestroyed()) continue;
    if (!userDragged.has(tid)) { anyAnchored = true; break; }
  }
  if (anyAnchored) {
    if (ctx.freezeFollower) ctx.freezeFollower();
  } else {
    if (ctx.unfreezeFollower && !suppressUnfreeze) ctx.unfreezeFollower();
  }
}

function checkSnapBack(terminalId) {
  if (!userDragged.has(terminalId)) return;
  const win = chatWins.get(terminalId);
  if (!win || win.isDestroyed()) return;
  if (!ctx.win || ctx.win.isDestroyed()) return;

  const pet = ctx.win.getBounds();
  const bub = win.getBounds();

  // The pet window has transparent padding around the sprite. Shrink its bounds
  // so snap-back only fires when the bubble overlaps the actual body (center ~60%).
  const insetX = Math.round(pet.width  * 0.22);
  const insetY = Math.round(pet.height * 0.22);
  const bodyLeft   = pet.x + insetX;
  const bodyTop    = pet.y + insetY;
  const bodyRight  = pet.x + pet.width  - insetX;
  const bodyBottom = pet.y + pet.height - insetY;

  const overlaps =
    bub.x                < bodyRight   &&
    bub.x + bub.width    > bodyLeft    &&
    bub.y                < bodyBottom  &&
    bub.y + bub.height   > bodyTop;
  if (!overlaps) return;

  // Snap back to anchored state AND reset any manual resize so the bubble
  // returns to the default size whenever it docks onto the pet.
  userDragged.delete(terminalId);
  userResized.delete(terminalId);
  winHeight.delete(terminalId);
  repositionTerminal(terminalId);
  updateFollowerFreeze();
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
  progResize.add(terminalId);
  setImmediate(() => progResize.delete(terminalId));
  progMove.add(terminalId);
  win.setBounds(bounds);
  // Clear flag after Electron processes the move event (next tick)
  setImmediate(() => progMove.delete(terminalId));
}

// Full reposition — used when the chat's own height changes (chat-height IPC).
// Preserves the current window size for anything the user has touched.
function repositionTerminal(terminalId) {
  const win = chatWins.get(terminalId);
  if (!win || win.isDestroyed()) return;
  const h = (winHeight.get(terminalId) || BUBBLE_H) + 4;
  const userSized = userResized.has(terminalId);
  const cur = win.getBounds();

  if (userDragged.has(terminalId)) {
    // User placed this window — preserve position. Preserve size too if user resized.
    if (userSized) return;
    setBoundsTracked(terminalId, win, { ...cur, height: h });
    return;
  }

  if (userSized) {
    const { x, y } = getPositionForTerminal(terminalId, cur.height - 4);
    setBoundsTracked(terminalId, win, { x, y, width: cur.width, height: cur.height });
    return;
  }
  const { x, y } = getPositionForTerminal(terminalId, h - 4);
  setBoundsTracked(terminalId, win, { x, y, width: BUBBLE_W, height: h });
}

// Lightweight follow — called when the PET moves. Re-anchors still-attached
// bubbles to the pet. Also *clamps* size back to the default — attached
// bubbles can never exceed the original starting size.
function reposition() {
  for (const [tid, win] of chatWins) {
    if (!win || win.isDestroyed()) continue;
    if (userDragged.has(tid)) continue; // user-placed bubbles don't follow
    const cur = win.getBounds();
    const targetW = BUBBLE_W;
    const targetH = BUBBLE_H + 4;
    const { x, y } = getPositionForTerminal(tid, targetH - 4);
    const needsResize = cur.width !== targetW || cur.height !== targetH;
    const needsMove   = cur.x !== x || cur.y !== y;
    if (!needsResize && !needsMove) continue;
    if (needsResize) {
      progResize.add(tid);
      progMove.add(tid);
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: targetW, height: targetH });
      setImmediate(() => { progResize.delete(tid); progMove.delete(tid); });
    } else {
      progMove.add(tid);
      win.setPosition(Math.round(x), Math.round(y));
      setImmediate(() => progMove.delete(tid));
    }
  }
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
    resizable:   true,
    minWidth:    260,
    minHeight:   160,
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
    const info = getSessionInfoForTerminal(terminalId);
    const history = getLog(terminalId);
    win.webContents.send("chat-show", { ...info, history });
    win.show();
    win.focus();
    updateFollowerFreeze();
  });

  // Detect user drag — moved event without our programmatic flag = user dragged it
  win.on("moved", () => {
    if (!progMove.has(terminalId)) {
      const wasAnchored = !userDragged.has(terminalId);
      userDragged.add(terminalId); // now free-floating, stop anchoring to pet
      if (wasAnchored) updateFollowerFreeze(); // detached → maybe let pet walk
      // Debounced snap-back check — if bubble released near bot, re-anchor
      clearTimeout(snapTimers.get(terminalId));
      snapTimers.set(terminalId, setTimeout(() => checkSnapBack(terminalId), 400));
    }
  });

  // User resize — flip the userResized flag and stop auto-growing.
  win.on("resized", () => {
    if (progResize.has(terminalId)) return;
    userResized.add(terminalId);
  });

  win.on("closed", () => {
    chatWins.delete(terminalId);
    winHeight.delete(terminalId);   // reset cached auto-size so next open uses default
    userDragged.delete(terminalId); // next open starts anchored again
    userResized.delete(terminalId); // next open starts auto-sized again
    progMove.delete(terminalId);
    progResize.delete(terminalId);
    // Re-evaluate freeze state after this bubble closes.
    updateFollowerFreeze();
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
    tm.sendToTerminal(
      terminalId,
      msg,
      (response, err) => {
        const responseText = response || ("⚠ " + err);
        logMessage(terminalId, "claude", responseText);
        const w = chatWins.get(terminalId);
        if (w && !w.isDestroyed()) {
          w.webContents.send("chat-thinking", false);
          w.webContents.send("chat-message", { text: responseText });
        }
        if (ctx.showResponse) ctx.showResponse(responseText, terminalId);
      },
      (evt) => {
        // Live stream events: forward to the chat bubble
        const w = chatWins.get(terminalId);
        if (w && !w.isDestroyed()) {
          w.webContents.send("chat-stream", evt);
        }
      }
    );
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

  ipcMain.on("chat-cancel", (event) => {
    const terminalId = findTerminalBySender(event.sender);
    if (!terminalId) return;
    const tm = ctx.terminalManager;
    if (tm && tm.cancelTerminal) tm.cancelTerminal(terminalId);
    // Tell the bubble to clear its thinking state
    const win = chatWins.get(terminalId);
    if (win && !win.isDestroyed()) {
      win.webContents.send("chat-thinking", false);
      win.webContents.send("chat-message", { text: "⏹ Stopped." });
    }
  });

  ipcMain.on("chat-close", (event) => {
    const terminalId = findTerminalBySender(event.sender);
    if (terminalId) hide(terminalId);
  });

  ipcMain.on("chat-height", (event, h) => {
    const terminalId = findTerminalBySender(event.sender);
    if (!terminalId) return;
    // Pinned to the pet → size is LOCKED. No auto-resize of any kind.
    if (!userDragged.has(terminalId)) return;
    // Detached but user has manually resized → respect their size.
    if (userResized.has(terminalId)) return;
    // Detached + not yet manually resized → allow auto-height to fit content.
    winHeight.set(terminalId, h);
    repositionTerminal(terminalId);
  });

  // ── Manual corner-grip resize ──
  const resizeStart = new Map(); // terminalId → { x, y, w, h }
  ipcMain.on("chat-resize-start", (event) => {
    const terminalId = findTerminalBySender(event.sender);
    const win = terminalId && chatWins.get(terminalId);
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    resizeStart.set(terminalId, { x: b.x, y: b.y, w: b.width, h: b.height });
  });
  ipcMain.on("chat-resize-delta", (event, { dx, dy, corner }) => {
    const terminalId = findTerminalBySender(event.sender);
    const win = terminalId && chatWins.get(terminalId);
    const s   = terminalId && resizeStart.get(terminalId);
    if (!win || win.isDestroyed() || !s) return;
    const minW = 260, minH = 160;
    let newW, newH, newX = s.x, newY = s.y;
    if (corner === "br") {
      newW = Math.max(minW, s.w + dx);
      newH = Math.max(minH, s.h + dy);
    } else if (corner === "bl") {
      newW = Math.max(minW, s.w - dx);
      newH = Math.max(minH, s.h + dy);
      newX = s.x + (s.w - newW);
    } else return;
    progResize.add(terminalId);
    win.setBounds({ x: Math.round(newX), y: Math.round(newY), width: Math.round(newW), height: Math.round(newH) });
    setImmediate(() => progResize.delete(terminalId));
  });
  ipcMain.on("chat-resize-end", (event) => {
    const terminalId = findTerminalBySender(event.sender);
    if (!terminalId) return;
    resizeStart.delete(terminalId);
    userResized.add(terminalId); // lock auto-size off after manual resize
  });

  // ── Aero-Snap (Win+Arrow) ──
  const preSnapBounds = new Map(); // terminalId → bounds before snap (for restore)
  ipcMain.on("chat-snap", (event, where) => {
    const terminalId = findTerminalBySender(event.sender);
    const win = terminalId && chatWins.get(terminalId);
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const wa = ctx.getNearestWorkArea(b.x + b.width / 2, b.y + b.height / 2);
    let target;
    if (where === "left") {
      target = { x: wa.x, y: wa.y, width: Math.floor(wa.width / 2), height: wa.height };
    } else if (where === "right") {
      target = { x: wa.x + Math.ceil(wa.width / 2), y: wa.y, width: Math.floor(wa.width / 2), height: wa.height };
    } else if (where === "max") {
      target = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
    } else if (where === "restore") {
      target = preSnapBounds.get(terminalId) || null;
    } else return;
    if (!target) return;
    if (where !== "restore" && !preSnapBounds.has(terminalId)) {
      preSnapBounds.set(terminalId, { ...b });
    }
    if (where === "restore") preSnapBounds.delete(terminalId);
    progResize.add(terminalId);
    progMove.add(terminalId);
    win.setBounds(target);
    setImmediate(() => { progResize.delete(terminalId); progMove.delete(terminalId); });
    userResized.add(terminalId);
    userDragged.add(terminalId);
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

// Is the chat bubble open for this terminal (or any terminal if no id given)?
function isOpen(terminalId) {
  if (terminalId) {
    const w = chatWins.get(terminalId);
    return !!(w && !w.isDestroyed() && w.isVisible());
  }
  for (const w of chatWins.values()) {
    if (w && !w.isDestroyed() && w.isVisible()) return true;
  }
  return false;
}

return { show, hide, registerIpc, cleanup, pushSessionUpdate, reposition, isOpen };

};
