// src/response-multi.js — Multi-slot response bubble manager
// Up to 4 simultaneous bubbles, one per slot around the Clawd icon.
// Colors follow the session's editor target (CLD/PSH/OB/AG).

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "screen-saver";

// Editor target → accent color (matches session-picker TARGET_COLOR)
const EDITOR_COLOR = {
  claude:      "#fb923c",  // CLD → orange
  cmd:         "#2dd4bf",  // PSH → teal
  obsidian:    "#a78bfa",  // OB  → purple
  antigravity: "#34d399",  // AG  → green
};
const DEFAULT_COLOR = "#6b7280";

const AUTO_DISMISS = 30000;   // ms
const WINDOW_H     = 130;     // initial height; resized by renderer

// Slot positions relative to Clawd win center.
// dx/dy → window top-left offset.
// Right-side slots: dx already accounts for 40px tail area left of card.
// top:true  → dy is the tip (bottom edge) offset from pet center — bubble grows upward
// top:false → dy is the tip (top edge) offset from pet center — bubble grows downward
const SLOTS = [
  { id: "tl", dx: -250, dy: -119, top: true,  w: 226 },
  { id: "tr", dx:   30, dy: -119, top: true,  w: 220 },
  { id: "bl", dx: -252, dy:   67, top: false, w: 237 },
  { id: "br", dx:   32, dy:   67, top: false, w: 220 },
];

// Tip Y offset for top slots = dy + WINDOW_H (bottom of initial window)
const TIP_DY = {
  tl: -119 + WINDOW_H + 15,
  tr: -119 + WINDOW_H + 15,
  bl: 73,
  br: 73,
};

module.exports = function initResponseMulti(ctx) {

  const wins          = {};  // slotId → BrowserWindow
  const timers        = {};  // slotId → setTimeout handle
  const slotHeight    = {};  // slotId → last known height
  const heightReady   = {};  // slotId → true once renderer has confirmed real height
  const slotSid       = {};  // slotId → session/terminal id (for click-to-open)
  // Shared tip Y per ROW — tl+tr share one value, bl+br share one value.
  // Set by reposition() at rest. Never per-slot so the two can never diverge.
  let topTipY = null;
  let botTipY = null;
  let ipcRegistered = false;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function slotBounds(slot, h) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const b   = ctx.win.getBounds();
    const cx  = b.x + Math.round(b.width  / 2);
    const cy  = b.y + Math.round(b.height / 2);
    const height = h || WINDOW_H;
    // Top slots: anchor bottom (tip) edge; bottom slots: anchor top (tip) edge
    const y = slot.top
      ? cy + TIP_DY[slot.id] - height   // tip fixed, bubble grows upward
      : cy + TIP_DY[slot.id];           // tip fixed, bubble grows downward
    return { x: cx + slot.dx, y, width: slot.w, height };
  }

  function freeSlot() {
    return SLOTS.find(s => !wins[s.id] || wins[s.id].isDestroyed()) || null;
  }

  function hide(slotId) {
    clearTimeout(timers[slotId]);
    delete timers[slotId];
    const w = wins[slotId];
    delete wins[slotId];
    heightReady[slotId] = false;
    delete slotSid[slotId];
    if (w && !w.isDestroyed()) w.close();
  }

  // ── Public: show ─────────────────────────────────────────────────────────

  function show(text, sid) {
    registerIpc();

    const slot = freeSlot();
    if (!slot) return;  // all 4 occupied — silently drop

    const session = sid && ctx.sessions ? ctx.sessions.get(sid) : null;
    const customName = sid && ctx.sessionNames && ctx.sessionNames[sid];
    let label, color;
    if (session && session.clawdBot) {
      // CLAWD-BOT terminal — use its stored name and color
      label = session.terminalName || customName || "Clawd";
      color = session.color || DEFAULT_COLOR;
    } else {
      label = customName || "Clawd";
      color = EDITOR_COLOR[session && session.editor] || DEFAULT_COLOR;
    }
    const bounds  = slotBounds(slot);
    if (!bounds) return;

    const win = new BrowserWindow({
      ...bounds,
      show:        false,
      frame:       false,
      transparent: true,
      alwaysOnTop: true,
      resizable:   false,
      skipTaskbar: true,
      hasShadow:   false,
      focusable:   false,
      webPreferences: {
        preload:          path.join(__dirname, "preload-response-bubble-multi.js"),
        nodeIntegration:  false,
        contextIsolation: true,
      },
    });

    if (isWin) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

    wins[slot.id]         = win;
    slotHeight[slot.id]   = WINDOW_H;
    heightReady[slot.id]  = false;
    slotSid[slot.id]      = sid || null;  // don't let reposition() touch this slot until renderer confirms height
    // Seed shared row tipY on first spawn so bubble-resize has something to work with
    if (slot.top  && topTipY == null) topTipY = bounds.y + WINDOW_H;
    if (!slot.top && botTipY == null) botTipY = bounds.y;

    win.loadFile(path.join(__dirname, "response-bubble-multi.html"));

    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.webContents.send("bubble-init", {
        text, label, color,
        slot:    slot.id,
        timerMs: AUTO_DISMISS,
      });
      win.showInactive();
    });

    timers[slot.id] = setTimeout(() => hide(slot.id), AUTO_DISMISS);

    win.on("closed", () => {
      delete wins[slot.id];
      clearTimeout(timers[slot.id]);
      delete timers[slot.id];
    });
  }

  // ── IPC ──────────────────────────────────────────────────────────────────

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.on("bubble-dismiss", (_e, { slot }) => {
      if (slot) hide(slot);
    });

    ipcMain.on("bubble-open", (_e, { slot }) => {
      if (!slot) return;
      const sid = slotSid[slot];
      hide(slot);
      if (sid && ctx.openChat) ctx.openChat(sid);
    });

    ipcMain.on("bubble-resize", (_e, { slot, h }) => {
      const w = wins[slot];
      if (!w || w.isDestroyed()) return;
      const s = SLOTS.find(x => x.id === slot);
      if (!s) return;
      const clampedH = Math.min(Math.max(h + 4, WINDOW_H), 260);
      slotHeight[slot]  = clampedH;
      heightReady[slot] = true;  // renderer has confirmed real height — safe to include in reposition
      reposition();
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function reposition() {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    const b  = ctx.win.getBounds();
    const cx = b.x + Math.round(b.width  / 2);
    const cy = b.y + Math.round(b.height / 2);

    // Update shared row tip Ys — both top slots get IDENTICAL value, both bottom slots get IDENTICAL value
    topTipY = cy + TIP_DY["tl"];
    botTipY = cy + TIP_DY["bl"];

    for (const s of SLOTS) {
      const w = wins[s.id];
      if (!w || w.isDestroyed()) continue;
      if (!heightReady[s.id]) continue;  // skip until renderer confirms real height — prevents WINDOW_H stomping a correct sibling
      const rowTipY = s.top ? topTipY : botTipY;
      const h = slotHeight[s.id] || WINDOW_H;
      const x = cx + s.dx;
      const y = s.top ? rowTipY - h : rowTipY;
      // setBounds (not setPosition) so height is always explicitly set — no mismatch possible
      w.setBounds({ x, y, width: s.w, height: h });
    }
  }

  function cleanup() {
    Object.keys(wins).forEach(hide);
  }

  return { show, reposition, cleanup };

};
