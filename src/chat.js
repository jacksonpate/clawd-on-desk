// src/chat.js — Right-click chat bubble
// Floating chat input that sends messages to the active Claude Code session.

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

module.exports = function initChat(ctx) {

let chatWin      = null;
let measuredH    = BUBBLE_H;
let ipcRegistered = false;

function getPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 100, y: 100 };
  const bounds  = ctx.win.getBounds();
  const wa      = ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const margin  = 8;

  // Try to place bubble to the left of Clawd, else right, else above
  let x = bounds.x - BUBBLE_W - margin;
  if (x < wa.x) x = bounds.x + bounds.width + margin;
  if (x + BUBBLE_W > wa.x + wa.width) x = Math.max(wa.x, bounds.x - BUBBLE_W - margin);

  let y = bounds.y;
  // Clamp vertically
  if (y + measuredH > wa.y + wa.height) y = wa.y + wa.height - measuredH - margin;
  if (y < wa.y) y = wa.y + margin;

  return { x: Math.round(x), y: Math.round(y) };
}

function reposition() {
  if (!chatWin || chatWin.isDestroyed()) return;
  const { x, y } = getPosition();
  chatWin.setBounds({ x, y, width: BUBBLE_W, height: measuredH + 4 });
}

// Commands that control Clawd directly — intercepted before sending to Claude Code
const FREEZE_CMDS   = /^(be still|stay|stay still|freeze|stop moving|don'?t move)\.?$/i;
const UNFREEZE_CMDS = /^(you'?re? (good|free)|move|go|unfreeze|you can move( now)?|start moving)\.?$/i;

function sendMessage(msg) {
  if (!msg) return;

  // Intercept movement commands — handle locally, don't send to Claude Code
  const trimmed = msg.trim();
  if (FREEZE_CMDS.test(trimmed)) {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send("chat-hide");
      setTimeout(() => { if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; } }, 350);
    }
    if (ctx.freezeFollower) ctx.freezeFollower();
    return;
  }
  if (UNFREEZE_CMDS.test(trimmed)) {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send("chat-hide");
      setTimeout(() => { if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; } }, 350);
    }
    if (ctx.unfreezeFollower) ctx.unfreezeFollower();
    return;
  }

  // 1. Write to clipboard
  clipboard.writeText(msg);

  // 2. Start fade animation, then close after it plays
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send("chat-hide");
    setTimeout(() => {
      if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
    }, 350);
  }

  if (isWin) {
    // Encode message as base64 UTF-16LE so it survives embedding in the PS script
    const msgB64 = Buffer.from(msg, "utf16le").toString("base64");

    // Strategy:
    //   1. Claude Desktop (Electron) — PostMessage WM_CHAR to render widget, no focus needed
    //   2. mintty (Git Bash) — PostMessage WM_CHAR to window
    //   3. Fallback — clipboard + focus (restores window)
    const ps = `
$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${msgB64}"))

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinSend {
  const uint WM_CHAR    = 0x0102;
  const uint WM_KEYDOWN = 0x0100;
  const uint WM_KEYUP   = 0x0101;
  const int  VK_RETURN  = 0x0D;

  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsDelegate cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ei);
  public delegate bool EnumWindowsDelegate(IntPtr h, IntPtr lp);

  // Inject text via PostMessage WM_CHAR — works on minimized/background windows
  public static bool PostChars(IntPtr hwnd, string text) {
    if (hwnd == IntPtr.Zero) return false;
    foreach (char c in text)
      PostMessage(hwnd, WM_CHAR, new IntPtr(c), new IntPtr(1));
    PostMessage(hwnd, WM_KEYDOWN, new IntPtr(VK_RETURN), new IntPtr(1));
    PostMessage(hwnd, WM_KEYUP,   new IntPtr(VK_RETURN), new IntPtr(0xC0000001));
    return true;
  }

  // Find Claude Desktop top-level window (Electron / Chrome_WidgetWin_1, title "Claude")
  public static IntPtr FindClaudeDesktop() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var ttl = new StringBuilder(256); GetWindowText(h, ttl, 256);
      string c = cls.ToString(), t = ttl.ToString();
      // Chrome_WidgetWin_1 with title "Claude" (not Clawd or other Electron apps)
      if (c == "Chrome_WidgetWin_1" && t == "Claude") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Find the Chromium render widget child — target for WM_CHAR injection
  public static IntPtr FindRenderWidget(IntPtr parent) {
    IntPtr rw = FindWindowEx(parent, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
    if (rw != IntPtr.Zero) return rw;
    // Recurse one level for nested chrome windows
    IntPtr child = FindWindowEx(parent, IntPtr.Zero, "Chrome_WidgetWin_1", null);
    if (child != IntPtr.Zero) {
      rw = FindWindowEx(child, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
      if (rw != IntPtr.Zero) return rw;
    }
    return parent; // fall back to top-level
  }

  // Find mintty window
  public static IntPtr FindMintty() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() == "mintty") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void FocusWindow(IntPtr h) {
    if (h == IntPtr.Zero) return;
    if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(200); }
    keybd_event(0x12,0,0,UIntPtr.Zero);
    keybd_event(0x12,0,2,UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
"@

Add-Type -AssemblyName System.Windows.Forms

$cdHwnd = [WinSend]::FindClaudeDesktop()
$target  = if ($cdHwnd -ne [IntPtr]::Zero) { $cdHwnd } else { [WinSend]::FindMintty() }
[System.Windows.Forms.Clipboard]::SetText($text)
if ($target -ne [IntPtr]::Zero) {
  [WinSend]::FocusWindow($target)
  Start-Sleep -Milliseconds 350
}
[System.Windows.Forms.SendKeys]::SendWait("^v{ENTER}")
`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) console.error("Clawd chat send error:", stderr || err.message);
      }
    );
  } else if (isMac && ctx.focusTerminalWindow) {
    let bestPid = null, bestCwd = null, bestEditor = null, bestChain = null;
    if (ctx.sessions) {
      let latest = 0;
      for (const [, s] of ctx.sessions) {
        if (s.sourcePid && (s.updatedAt || 0) >= latest) {
          latest = s.updatedAt || 0;
          bestPid = s.sourcePid; bestCwd = s.cwd;
          bestEditor = s.editor; bestChain = s.pidChain;
        }
      }
    }
    if (bestPid) ctx.focusTerminalWindow(bestPid, bestCwd, bestEditor, bestChain);
  }
}

function show() {
  if (chatWin && !chatWin.isDestroyed()) {
    reposition();
    chatWin.webContents.send("chat-show", {});
    return;
  }

  const { x, y } = getPosition();
  chatWin = new BrowserWindow({
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
    focusable: true,   // Chat bubble needs focus for typing
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload-chat-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isWin) chatWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

  chatWin.loadFile(path.join(__dirname, "chat-bubble.html"));

  chatWin.webContents.once("did-finish-load", () => {
    chatWin.webContents.send("chat-show", {});
    reposition();
    chatWin.show();
    chatWin.focus();
  });

  chatWin.on("blur", () => {
    // Close when user clicks away
    setTimeout(() => {
      if (chatWin && !chatWin.isDestroyed() && !chatWin.isFocused()) {
        hide();
      }
    }, 150);
  });

  chatWin.on("closed", () => { chatWin = null; });
}

function hide() {
  if (!chatWin || chatWin.isDestroyed()) return;
  chatWin.webContents.send("chat-hide");
  setTimeout(() => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.close();
  }, 350); // let fade-out animation play
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("chat-send", (_, msg) => {
    sendMessage(msg); // hide() is called inside sendMessage
  });

  ipcMain.on("chat-close", () => hide());

  ipcMain.on("chat-height", (_, h) => {
    measuredH = h;
    reposition();
  });
}

function cleanup() {
  if (chatWin && !chatWin.isDestroyed()) chatWin.close();
  chatWin = null;
}

return { show, hide, registerIpc, cleanup };

};
