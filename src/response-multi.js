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

const AUTO_DISMISS = 20000;   // ms
const WINDOW_H     = 130;     // initial height; resized by renderer

// Slot positions relative to Clawd win center.
// dx/dy → window top-left offset.
// Right-side slots: dx already accounts for 40px tail area left of card.
const SLOTS = [
  { id: "tl", dx: -242, dy: -129, w: 226 },
  { id: "tr", dx:   22, dy: -129, w: 220 },
  { id: "bl", dx: -242, dy:   17, w: 237 },
  { id: "br", dx:   22, dy:   17, w: 220 },
];

module.exports = function initResponseMulti(ctx) {

  const wins   = {};  // slotId → BrowserWindow
  const timers = {};  // slotId → setTimeout handle
  let ipcRegistered = false;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function slotBounds(slot) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const b  = ctx.win.getBounds();
    const cx = b.x + Math.round(b.width  / 2);
    const cy = b.y + Math.round(b.height / 2);
    return { x: cx + slot.dx, y: cy + slot.dy, width: slot.w, height: WINDOW_H };
  }

  function freeSlot() {
    return SLOTS.find(s => !wins[s.id] || wins[s.id].isDestroyed()) || null;
  }

  function hide(slotId) {
    clearTimeout(timers[slotId]);
    delete timers[slotId];
    const w = wins[slotId];
    delete wins[slotId];
    if (w && !w.isDestroyed()) w.close();
  }

  // ── Public: show ─────────────────────────────────────────────────────────

  function show(text, sid) {
    registerIpc();

    const slot = freeSlot();
    if (!slot) return;  // all 4 occupied — silently drop

    const session = sid && ctx.sessions ? ctx.sessions.get(sid) : null;
    const customName = sid && ctx.sessionNames && ctx.sessionNames[sid];
    const label   = customName || "Clawd";
    const color   = EDITOR_COLOR[session && session.editor] || DEFAULT_COLOR;
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

    wins[slot.id] = win;

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

    ipcMain.on("bubble-resize", (_e, { slot, h }) => {
      const w = wins[slot];
      if (!w || w.isDestroyed()) return;
      const s = SLOTS.find(x => x.id === slot);
      if (!s) return;
      const b = slotBounds(s);
      if (b) w.setBounds({ ...b, height: Math.max(h + 4, WINDOW_H) });
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function reposition() {
    for (const s of SLOTS) {
      const w = wins[s.id];
      if (!w || w.isDestroyed()) continue;
      const b = slotBounds(s);
      if (b) w.setPosition(b.x, b.y);
    }
  }

  function cleanup() {
    Object.keys(wins).forEach(hide);
  }

  return { show, reposition, cleanup };

};
