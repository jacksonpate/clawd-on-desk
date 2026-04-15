// src/response.js — Response bubble
// Pops up near Clawd showing Claude's last response after Stop fires.
// Read-only, focusable: false (never steals terminal focus).
// Auto-dismisses after 12s or on click.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const isMac   = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin   = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";
const WIN_TOPMOST_LEVEL = "screen-saver";

const BUBBLE_W   = 360;
const BUBBLE_H   = 200;
const AUTO_CLOSE = 15000; // ms

module.exports = function initResponse(ctx) {

let responseWin  = null;
let measuredH    = BUBBLE_H;
let autoTimer    = null;
let ipcRegistered = false;

function getPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 100, y: 100 };
  const bounds = ctx.win.getBounds();
  const wa     = ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const margin = 8;

  // Try left of Clawd, then right
  let x = bounds.x - BUBBLE_W - margin;
  if (x < wa.x) x = bounds.x + bounds.width + margin;
  if (x + BUBBLE_W > wa.x + wa.width) x = Math.max(wa.x, bounds.x - BUBBLE_W - margin);

  // Align top with Clawd, clamp vertically
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

function startAutoClose() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => hide(), AUTO_CLOSE);
}

function show(text) {
  clearTimeout(autoTimer);

  if (responseWin && !responseWin.isDestroyed()) {
    // Reuse existing window
    reposition();
    responseWin.webContents.send("response-show", { text });
    startAutoClose();
    return;
  }

  const { x, y } = getPosition();
  responseWin = new BrowserWindow({
    width: BUBBLE_W,
    height: BUBBLE_H,
    x, y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,   // Never steal focus — user is reading in terminal
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
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
    responseWin.webContents.send("response-show", { text });
    reposition();
    responseWin.showInactive(); // show without stealing focus
  });

  responseWin.on("closed", () => {
    responseWin = null;
    clearTimeout(autoTimer);
  });

  startAutoClose();
}

function hide() {
  clearTimeout(autoTimer);
  if (!responseWin || responseWin.isDestroyed()) return;
  responseWin.webContents.send("response-hide");
  setTimeout(() => {
    if (responseWin && !responseWin.isDestroyed()) {
      responseWin.close();
      responseWin = null;
    }
  }, 350); // let spring-out animation play
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("response-close", () => hide());

  ipcMain.on("response-height", (_, h) => {
    measuredH = h;
    reposition();
  });
}

function cleanup() {
  clearTimeout(autoTimer);
  if (responseWin && !responseWin.isDestroyed()) responseWin.close();
  responseWin = null;
}

return { show, hide, registerIpc, cleanup };

};
