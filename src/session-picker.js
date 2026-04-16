// src/session-picker.js — Floating session picker bubble
// Shift+Right-click on Clawd → shows all active sessions.
// Click to toggle into/out of cycling pool. Blur to close.
// Ctrl+Right-click then cycles only through the selected pool.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const WIN_TOPMOST_LEVEL = "screen-saver";

const PICKER_W = 300;
const PICKER_H = 300;

module.exports = function initSessionPicker(ctx) {

let pickerWin    = null;
let measuredH    = PICKER_H;
let ipcRegistered = false;
let autoTimer    = null;

const AUTO_DISMISS = 15000;

function getPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 120, y: 120 };
  const bounds = ctx.win.getBounds();
  const wa     = ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const margin = 8;

  let x = bounds.x - PICKER_W - margin;
  if (x < wa.x) x = bounds.x + bounds.width + margin;
  if (x + PICKER_W > wa.x + wa.width) x = Math.max(wa.x, bounds.x - PICKER_W - margin);

  let y = bounds.y;
  if (y + measuredH > wa.y + wa.height) y = wa.y + wa.height - measuredH - margin;
  if (y < wa.y) y = wa.y + margin;

  return { x: Math.round(x), y: Math.round(y) };
}

function buildData() {
  const sessions = [];
  for (const [id, s] of ctx.sessions) {
    // Resolve target: in-memory session editor > persisted pinnedSessionCwds > null
    const persistedMeta = ctx.pinnedSessionCwds && ctx.pinnedSessionCwds[id];
    const target = s.editor || (persistedMeta && persistedMeta.editor) || null;
    sessions.push({
      id,
      state: s.state || "idle",
      cwd: s.cwd || "",
      host: s.host || null,
      updatedAt: s.updatedAt || 0,
      customName: ctx.sessionNames[id] || null,
      target,
    });
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    sessions,
    selectedIds: [...ctx.selectedSessionIds],
    pinnedIds:   [...ctx.pinnedSessionIds],
  };
}

function startAutoTimer() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { autoTimer = null; hide(); }, AUTO_DISMISS);
}

function show() {
  const data = buildData();

  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.webContents.send("picker-show", data);
    const { x, y } = getPosition();
    pickerWin.setBounds({ x, y, width: PICKER_W, height: measuredH });
    pickerWin.focus();
    startAutoTimer();
    return;
  }

  const { x, y } = getPosition();
  pickerWin = new BrowserWindow({
    width:  PICKER_W,
    height: PICKER_H,
    x, y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    ...(isMac ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload-session-picker.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isWin) pickerWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

  pickerWin.loadFile(path.join(__dirname, "session-picker.html"));

  pickerWin.webContents.once("did-finish-load", () => {
    if (!pickerWin || pickerWin.isDestroyed()) return;
    pickerWin.webContents.send("picker-show", buildData());
    const { x: px, y: py } = getPosition();
    pickerWin.setBounds({ x: px, y: py, width: PICKER_W, height: measuredH });
    pickerWin.show();
    pickerWin.focus();
    startAutoTimer();
  });

  pickerWin.on("closed", () => { pickerWin = null; measuredH = PICKER_H; clearTimeout(autoTimer); autoTimer = null; });
}

function hide() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (!pickerWin || pickerWin.isDestroyed()) return;
  const w = pickerWin;
  pickerWin = null;
  setTimeout(() => {
    if (w && !w.isDestroyed()) w.close();
  }, 200);
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("show-session-picker", () => show());
  ipcMain.on("picker-close", () => hide());

  ipcMain.on("picker-height", (_, h) => {
    measuredH = Math.min(h + 4, 520);
    if (pickerWin && !pickerWin.isDestroyed()) {
      const { x, y } = getPosition();
      pickerWin.setBounds({ x, y, width: PICKER_W, height: measuredH });
    }
  });

  ipcMain.handle("picker-toggle-selected", (_event, id) => {
    if (!id) return;
    if (ctx.selectedSessionIds.has(id)) {
      ctx.selectedSessionIds.delete(id);
      if (ctx.selectedSessionMeta) {
        delete ctx.selectedSessionMeta[id];
        if (typeof ctx.saveSelectedMeta === "function") ctx.saveSelectedMeta();
      }
    } else {
      ctx.selectedSessionIds.add(id);
      // Save metadata so session stays visible even if .jsonl moves/disappears
      const s = ctx.sessions.get(id);
      if (s && ctx.selectedSessionMeta) {
        ctx.selectedSessionMeta[id] = { cwd: s.cwd || "", editor: s.editor || null };
        if (typeof ctx.saveSelectedMeta === "function") ctx.saveSelectedMeta();
      }
    }
    ctx.saveSelectedSessions();
  });

  ipcMain.handle("picker-rename-session", (_event, id, name) => {
    if (typeof ctx.renameSession === "function") ctx.renameSession(id, name);
  });

  ipcMain.handle("picker-set-target", (_event, id, target) => {
    if (!id) return;
    // Update in-memory session immediately
    const s = ctx.sessions.get(id);
    if (s) s.editor = target || null;
    // Persist to pinnedSessionCwds (covers pinned sessions after restart)
    if (ctx.pinnedSessionCwds) {
      const existing = ctx.pinnedSessionCwds[id] || {};
      ctx.pinnedSessionCwds[id] = { ...existing, editor: target || null };
    }
    if (typeof ctx.savePinnedSessions === "function") ctx.savePinnedSessions();
    // ALSO persist to selectedSessionMeta (covers selected-only sessions after restart)
    if (ctx.selectedSessionMeta) {
      const existing = ctx.selectedSessionMeta[id] || {};
      ctx.selectedSessionMeta[id] = { ...existing, editor: target || null };
      if (typeof ctx.saveSelectedMeta === "function") ctx.saveSelectedMeta();
    }
  });
}

function cleanup() {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
}

return { show, hide, registerIpc, cleanup };

};
