// src/response.js — Response bubble
// When Claude Code finishes responding (Stop hook), show a read-only popup near
// Clawd with the last assistant message. Auto-dismisses after 15s or on click.
// Never steals focus from the terminal (showInactive).

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isMac  = process.platform === "darwin";
const isWin  = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "screen-saver";

const BUBBLE_W      = 360;
const BUBBLE_H      = 200; // initial; resized after content loads
const AUTO_DISMISS  = 15000; // ms

module.exports = function initResponse(ctx) {

let responseWin  = null;
let measuredH    = BUBBLE_H;
let autoTimer    = null;
let pinned       = false; // right-click to pin: stops auto-dismiss
let ipcRegistered = false;

function getPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 120, y: 120 };
  const bounds = ctx.win.getBounds();
  const wa     = ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const margin = 8;

  // Prefer left of Clawd, fallback right
  let x = bounds.x - BUBBLE_W - margin;
  if (x < wa.x) x = bounds.x + bounds.width + margin;
  if (x + BUBBLE_W > wa.x + wa.width) x = Math.max(wa.x, bounds.x - BUBBLE_W - margin);

  let y = bounds.y;
  if (y + measuredH > wa.y + wa.height) y = wa.y + wa.height - measuredH - margin;
  if (y < wa.y) y = wa.y + margin;

  return { x: Math.round(x), y: Math.round(y) };
}

function reposition() {
  if (!responseWin || responseWin.isDestroyed()) return;
  const { x, y } = getPosition();
  responseWin.setBounds({ x, y, width: BUBBLE_W, height: measuredH + 4 });
}

function startAutoTimer() {
  clearTimeout(autoTimer);
  if (!pinned) {
    autoTimer = setTimeout(() => { autoTimer = null; hide(); }, AUTO_DISMISS);
  }
}

function show(text) {
  pinned = false;
  clearTimeout(autoTimer);

  // If window already open, update content and restart timer
  if (responseWin && !responseWin.isDestroyed()) {
    responseWin.webContents.send("response-show", { text });
    reposition();
    startAutoTimer();
    return;
  }

  const { x, y } = getPosition();
  responseWin = new BrowserWindow({
    width:  BUBBLE_W,
    height: BUBBLE_H,
    x, y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,   // NEVER steal focus
    ...(isMac ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload-response-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isWin) responseWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

  responseWin.loadFile(path.join(__dirname, "response-bubble.html"));

  responseWin.webContents.once("did-finish-load", () => {
    if (!responseWin || responseWin.isDestroyed()) return;
    responseWin.webContents.send("response-show", { text });
    reposition();
    responseWin.showInactive(); // show without stealing focus
    startAutoTimer();
  });

  responseWin.on("closed", () => {
    responseWin = null;
    clearTimeout(autoTimer);
    autoTimer = null;
    pinned = false;
  });
}

function hide() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (!responseWin || responseWin.isDestroyed()) return;
  responseWin.webContents.send("response-hide");
  setTimeout(() => {
    if (responseWin && !responseWin.isDestroyed()) {
      responseWin.close();
      responseWin = null;
    }
  }, 350);
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("response-close", () => hide());

  ipcMain.on("response-pin", () => {
    pinned = true;
    clearTimeout(autoTimer);
    autoTimer = null;
    if (responseWin && !responseWin.isDestroyed()) {
      responseWin.webContents.send("response-pin");
    }
  });

  ipcMain.on("response-height", (_, h) => {
    measuredH = h;
    reposition();
  });
}

function cleanup() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (responseWin && !responseWin.isDestroyed()) responseWin.close();
  responseWin = null;
}

return { show, hide, reposition, registerIpc, cleanup };

};
