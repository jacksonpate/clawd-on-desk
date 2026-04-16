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

const EDITOR_COLOR = {
  claude:      "#fb923c",
  cmd:         "#2dd4bf",
  obsidian:    "#a78bfa",
  antigravity: "#34d399",
};
const DEFAULT_COLOR = "#6b7280";

module.exports = function initChat(ctx) {

let chatWin      = null;
let measuredH    = BUBBLE_H;
let ipcRegistered = false;
let suppressUnfreeze = false; // true when closing due to a freeze command
let manuallyFrozen = false;   // true while Clawd is frozen by "be still" command — persists across bubble opens

function getPosition() {
  if (!ctx.win || ctx.win.isDestroyed()) return { x: 100, y: 100 };
  const bounds  = ctx.win.getBounds();
  const wa      = ctx.getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const margin  = 8;

  // Try left of Clawd, then right, then clamp inside work area
  let x = bounds.x - BUBBLE_W - margin;
  if (x < wa.x) x = bounds.x + bounds.width + margin;
  // Hard clamp to work area so it never escapes the monitor
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - BUBBLE_W));

  let y = bounds.y;
  // Hard clamp vertically
  y = Math.max(wa.y + margin, Math.min(y, wa.y + wa.height - measuredH - margin));

  return { x: Math.round(x), y: Math.round(y) };
}

function reposition() {
  if (!chatWin || chatWin.isDestroyed()) return;
  if (chatWin.isFocused()) return; // don't yank position while user is typing
  const { x, y } = getPosition();
  chatWin.setBounds({ x, y, width: BUBBLE_W, height: measuredH + 4 });
}

// Commands that control Clawd directly — intercepted before sending to Claude Code
const FREEZE_CMDS   = /^(be still|stay|stay still|freeze|stop moving|don'?t move)[.,!?]*$/i;
const UNFREEZE_CMDS = /^(you'?re? (good|free)|move|go|unfreeze|you can move( now)?|start moving)[.,!?]*$/i;

function sendMessage(msg) {
  if (!msg) return;

  // Intercept movement commands — handle locally, don't send to Claude Code
  const trimmed = msg.trim();
  if (FREEZE_CMDS.test(trimmed)) {
    manuallyFrozen = true;
    suppressUnfreeze = true; // don't let this specific close undo the freeze
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send("chat-hide");
      setTimeout(() => { if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; } }, 350);
    }
    if (ctx.freezeFollower) ctx.freezeFollower();
    return;
  }
  if (UNFREEZE_CMDS.test(trimmed)) {
    manuallyFrozen = false;
    suppressUnfreeze = false;
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
    // Pick best session (pinned first, else most recent)
    let targetCwd = "", targetEditor = "", targetSourcePid = 0, targetHwnd = 0;
    const pinned = ctx.pinnedSessionIds;
    const hasPins = pinned && pinned.size > 0;
    if (ctx.sessions) {
      let latest = 0;
      for (const [id, s] of ctx.sessions) {
        if (hasPins && !pinned.has(id)) continue;
        if ((s.updatedAt || 0) >= latest) {
          latest = s.updatedAt || 0;
          targetCwd = s.cwd || "";
          targetEditor = s.editor || "";
          targetSourcePid = s.sourcePid || 0;
          targetHwnd = s.terminalHwnd || 0;
        }
      }
    }
    // If pins are set but session not yet in Map (e.g. after Clawd restart),
    // fall back to saved data from pinnedSessionCwds
    // Fallback: if no sessions registered yet (hooks haven't fired since restart),
    // read routing metadata from pinnedSessionCwds (persisted from last run)
    if (hasPins && (!targetCwd || !targetEditor) && ctx.pinnedSessionCwds) {
      for (const id of pinned) {
        const saved = ctx.pinnedSessionCwds[id];
        if (saved) {
          if (!targetCwd)        targetCwd        = saved.cwd        || "";
          if (!targetEditor)     targetEditor     = saved.editor     || "";
          if (!targetSourcePid)  targetSourcePid  = saved.sourcePid  || 0;
          break;
        }
      }
    }
    // Folder name from cwd for window title matching (e.g. "Project_P", "jpate")
    const folderName = targetCwd ? targetCwd.split(/[\\/]/).pop() : "";
    try { require("fs").appendFileSync(require("path").join(require("os").homedir(), "AppData", "Roaming", "clawd-on-desk", "clawd-chat-debug.log"), `[${new Date().toISOString()}] editor=${targetEditor} sourcePid=${targetSourcePid} targetCwd=${targetCwd} folderName=${folderName} pinnedSize=${ctx.pinnedSessionIds ? ctx.pinnedSessionIds.size : "N/A"}\n`); } catch {}

    // Encode message as base64 UTF-16LE so it survives embedding in the PS script
    const msgB64 = Buffer.from(msg, "utf16le").toString("base64");

    // Route by editor (if known) then fall back to window-title search (original approach).
    const ps = `
$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${msgB64}"))
$editor = "${targetEditor}"
$folderName = "${folderName}"
$terminalPid = ${targetSourcePid}
$dbg = "$env:APPDATA\\clawd-on-desk\\clawd-ps-debug.log"

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
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsDelegate cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ei);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, ref int lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public delegate bool EnumWindowsDelegate(IntPtr h, IntPtr lp);

  // Find the Chromium render widget child — direct target for WM_CHAR injection
  public static IntPtr FindRenderWidget(IntPtr parent) {
    IntPtr rw = FindWindowEx(parent, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
    if (rw != IntPtr.Zero) return rw;
    IntPtr child = FindWindowEx(parent, IntPtr.Zero, "Chrome_WidgetWin_1", null);
    if (child != IntPtr.Zero) {
      rw = FindWindowEx(child, IntPtr.Zero, "Chrome_RenderWidgetHostHWND", null);
      if (rw != IntPtr.Zero) return rw;
    }
    return parent;
  }

  // Find Claude Desktop: Chrome_WidgetWin_1 with title "Claude"
  public static IntPtr FindClaudeDesktop() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var ttl = new StringBuilder(256); GetWindowText(h, ttl, 256);
      string t = ttl.ToString();
      if (cls.ToString() == "Chrome_WidgetWin_1" && (t == "Claude" || t.EndsWith("— Claude") || t.EndsWith("- Claude"))) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Find first visible terminal/editor window whose title contains folderName.
  // Excludes file explorers (CabinetWClass, ExploreWClass) and system windows.
  public static IntPtr FindWindowByTitle(string folderName) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h) && !IsIconic(h)) return true;
      var cls = new StringBuilder(128); GetClassName(h, cls, 128);
      string c = cls.ToString();
      // Skip file explorer, task manager, tray, etc.
      if (c == "CabinetWClass" || c == "ExploreWClass" || c == "WorkerW" ||
          c == "Shell_TrayWnd" || c == "Progman") return true;
      var ttl = new StringBuilder(512); GetWindowText(h, ttl, 512);
      string t = ttl.ToString();
      if (t.Length == 0 || t == "Claude" || t == "Clawd") return true;
      if (t.IndexOf(folderName, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Robustly focus a window using AttachThreadInput so keyboard input
  // actually transfers even from a background/hidden process.
  public static void FocusWindow(IntPtr h) {
    if (h == IntPtr.Zero) return;
    if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(200); }
    int dummy = 0;
    uint targetTid = GetWindowThreadProcessId(h, ref dummy);
    uint myTid = GetCurrentThreadId();
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (targetTid != 0 && targetTid != myTid) {
      AttachThreadInput(myTid, targetTid, true);
      SetFocus(h);
      AttachThreadInput(myTid, targetTid, false);
    }
  }

  // For Electron/Chrome apps: focus the render widget child so keystrokes
  // land in the web content (terminal pane) rather than the chrome frame.
  public static void FocusRenderWidget(IntPtr parent) {
    IntPtr rw = FindRenderWidget(parent);
    if (rw == IntPtr.Zero || rw == parent) return;
    int dummy = 0;
    uint rwTid = GetWindowThreadProcessId(rw, ref dummy);
    uint myTid = GetCurrentThreadId();
    if (rwTid != 0 && rwTid != myTid) {
      AttachThreadInput(myTid, rwTid, true);
      SetFocus(rw);
      AttachThreadInput(myTid, rwTid, false);
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, ref RECT r);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  public struct POINT { public int X; public int Y; }

  // Ghost-click at absolute screen coordinates — converts to client coords, uses PostMessage, no cursor movement.
  public static void GhostClickAbsolute(IntPtr h, int screenX, int screenY) {
    if (h == IntPtr.Zero) return;
    IntPtr rw = FindRenderWidget(h);
    IntPtr target = (rw != IntPtr.Zero) ? rw : h;
    POINT pt = new POINT { X = screenX, Y = screenY };
    ScreenToClient(target, ref pt);
    IntPtr lp = (IntPtr)(((pt.Y & 0xFFFF) << 16) | (pt.X & 0xFFFF));
    PostMessage(target, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(20);
    PostMessage(target, 0x0202, (IntPtr)0, lp); // WM_LBUTTONUP
  }

  // Click near the bottom-center using PostMessage — no cursor movement.
  public static void ClickWindow(IntPtr h) {
    if (h == IntPtr.Zero) return;
    IntPtr rw = FindRenderWidget(h);
    IntPtr target = (rw != IntPtr.Zero) ? rw : h;
    RECT r = new RECT();
    if (!GetClientRect(target, ref r)) return;
    int cx = (r.Left + r.Right) / 2;
    int cy = r.Top + (int)((r.Bottom - r.Top) * 0.92);
    IntPtr lp = (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF));
    PostMessage(target, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(20);
    PostMessage(target, 0x0202, (IntPtr)0, lp); // WM_LBUTTONUP
  }

  // Ghost-click at relative percentages within the window — no cursor movement.
  public static void GhostClickRelative(IntPtr h, double pctX, double pctY) {
    if (h == IntPtr.Zero) return;
    IntPtr rw = FindRenderWidget(h);
    IntPtr target = (rw != IntPtr.Zero) ? rw : h;
    RECT r = new RECT();
    if (!GetClientRect(target, ref r)) return;
    int cx = r.Left + (int)((r.Right  - r.Left) * pctX);
    int cy = r.Top  + (int)((r.Bottom - r.Top)  * pctY);
    IntPtr lp = (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF));
    PostMessage(target, 0x0201, (IntPtr)1, lp);
    System.Threading.Thread.Sleep(20);
    PostMessage(target, 0x0202, (IntPtr)0, lp);
  }

  // Click ~10px from the right edge of the MAIN window, vertically centered — no cursor movement.
  // Uses the main window rect for coordinates so the position is always near the true right border.
  public static void ClickWindowNearRight(IntPtr h) {
    if (h == IntPtr.Zero) return;
    RECT r = new RECT();
    if (!GetClientRect(h, ref r)) return;
    int cx = r.Left + (int)((r.Right - r.Left) * 0.93);
    int cy = (r.Top + r.Bottom) / 2;
    IntPtr lp = (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF));
    PostMessage(h, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(20);
    PostMessage(h, 0x0202, (IntPtr)0, lp); // WM_LBUTTONUP
  }

  // Click at 92% (maximized) or 88% (windowed) down the main window, horizontally centered — no cursor movement.
  // Used for Claude Desktop to land in the chat input area.
  public static void ClickWindowBottom(IntPtr h) {
    if (h == IntPtr.Zero) return;
    RECT r = new RECT();
    if (!GetClientRect(h, ref r)) return;
    double pct = IsZoomed(h) ? 0.92 : 0.88;
    int cx = r.Left + (int)((r.Right - r.Left) * 0.25);
    int cy = r.Top + (int)((r.Bottom - r.Top) * pct);
    IntPtr lp = (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF));
    PostMessage(h, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(20);
    PostMessage(h, 0x0202, (IntPtr)0, lp); // WM_LBUTTONUP
  }

  // Click at 89% down the main window, horizontally centered — no cursor movement.
  // Used for Antigravity to land in the terminal pane.
  public static void ClickWindowBottom85(IntPtr h) {
    if (h == IntPtr.Zero) return;
    RECT r = new RECT();
    if (!GetClientRect(h, ref r)) return;
    int cx = (r.Left + r.Right) / 2;
    int cy = r.Top + (int)((r.Bottom - r.Top) * 0.89);
    IntPtr lp = (IntPtr)(((cy & 0xFFFF) << 16) | (cx & 0xFFFF));
    PostMessage(h, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN
    System.Threading.Thread.Sleep(20);
    PostMessage(h, 0x0202, (IntPtr)0, lp); // WM_LBUTTONUP
  }
}
"@
Add-Type -AssemblyName System.Windows.Forms

$target = [IntPtr]::Zero
$log = @()
Add-Content $dbg "[$(Get-Date -f o)] PS-START editor=$editor folder=$folderName"

# ── Pass 1: Editor-based routing (exact, no ambiguity) ──────────────────────
if ($editor -ne "") {
  switch ($editor) {
    "antigravity" {
      $procs = Get-Process -Name antigravity -EA 0 | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
      $match = if ($folderName -ne "") { $procs | Where-Object { $_.MainWindowTitle -like "*$folderName*" } | Select-Object -First 1 } else { $null }
      if (-not $match) { $match = $procs | Select-Object -First 1 }
      if ($match) { $target = $match.MainWindowHandle }
      $log += "ag=$target"
    }
    "obsidian" {
      $match = Get-Process -Name obsidian -EA 0 | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
      if ($match) { $target = $match.MainWindowHandle }
      $log += "ob=$target"
    }
    "claude" {
      $target = [WinSend]::FindClaudeDesktop()
      $log += "claude=$target"
    }
    "cmd" {
      if ($terminalPid -gt 0) {
        $p = Get-Process -Id $terminalPid -EA 0
        if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $target = $p.MainWindowHandle }
      }
      if ($target -eq [IntPtr]::Zero) {
        $p = Get-Process -Name powershell -EA 0 | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($p) { $target = $p.MainWindowHandle }
      }
      if ($target -eq [IntPtr]::Zero) {
        $p = Get-Process -Name cmd -EA 0 | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($p) { $target = $p.MainWindowHandle }
      }
      $log += "psh=$target"
    }
  }
}

# ── Pass 2: Title-search fallback (original behaviour) ──────────────────────
if ($target -eq [IntPtr]::Zero) {
  if ($folderName -ne "") {
    $target = [WinSend]::FindWindowByTitle($folderName)
    $log += "title($folderName)=$target"
  }
  if ($target -eq [IntPtr]::Zero) {
    $target = [WinSend]::FindClaudeDesktop()
    $log += "cd-fallback=$target"
  }
}

Add-Content $dbg "[$(Get-Date -f o)] $($log -join ' | ') => $target"

[System.Windows.Forms.Clipboard]::SetText($text)
$wasMinimized = $false
if ($target -ne [IntPtr]::Zero) {
  # Flash mode: if window was minimized, restore → paste → re-minimize for all editors
  if ([WinSend]::IsIconic($target)) {
    $wasMinimized = $true
  }
  [WinSend]::FocusWindow($target)
  # For Electron/Chrome apps, also move focus into the render widget (terminal pane)
  if ($editor -eq "antigravity" -or $editor -eq "obsidian") {
    Start-Sleep -Milliseconds 150
    [WinSend]::FocusRenderWidget($target)
  }
  # Antigravity: ghost-click at 85% down to land focus in terminal pane
  if ($editor -eq "antigravity") {
    Start-Sleep -Milliseconds 100
    [WinSend]::ClickWindowBottom85($target)
  }
  # Obsidian: ghost-click at 92.7% from left, 87.1% down (terminal pane)
  if ($editor -eq "obsidian") {
    Start-Sleep -Milliseconds 100
    [WinSend]::GhostClickRelative($target, 0.927, 0.871)
  }
  # Claude Desktop: ghost-click at 21.8% from left, 92.3% down (chat input area)
  if ($editor -eq "claude") {
    Start-Sleep -Milliseconds 100
    [WinSend]::GhostClickRelative($target, 0.340, 0.930)
  }
  Start-Sleep -Milliseconds 275
}
# Paste using the correct shortcut for each app type
if ($editor -eq "cmd") {
  [System.Windows.Forms.SendKeys]::SendWait("^+v{ENTER}")
} else {
  [System.Windows.Forms.SendKeys]::SendWait("^v{ENTER}")
}
# Flash: re-minimize if it was minimized before we restored it
if ($wasMinimized) {
  Start-Sleep -Milliseconds 275
  [WinSend]::ShowWindow($target, 6)
}
`;
    // Grant PS process permission to steal foreground focus
    if (ctx.allowAnyForeground) ctx.allowAnyForeground();
    const _psLogPath = require("path").join(require("os").homedir(), "AppData", "Roaming", "clawd-on-desk", "clawd-chat-debug.log");
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true },
      (err, stdout, stderr) => {
        const result = `exitCode=${err ? (err.code || 1) : 0} stderr=${(stderr||"").trim().slice(0,200)} stdout=${(stdout||"").trim().slice(0,100)}`;
        try { require("fs").appendFileSync(_psLogPath, `[${new Date().toISOString()}] PS-RESULT: ${result}\n`); } catch {}
        if (err) console.error("Clawd chat send error:", stderr || err.message);
      }
    );
  } else if (isMac && ctx.focusTerminalWindow) {
    let bestPid = null, bestCwd = null, bestEditor = null, bestChain = null;
    if (ctx.sessions) {
      const pinned = ctx.pinnedSessionIds;
      const hasPins = pinned && pinned.size > 0;
      let latest = 0;
      for (const [id, s] of ctx.sessions) {
        // If sessions are pinned, only consider pinned ones
        if (hasPins && !pinned.has(id)) continue;
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

function getSessionInfo() {
  const pinned  = ctx.pinnedSessionIds;
  const hasPins = pinned && pinned.size > 0;
  let sid = null, editor = "";
  let latest = 0;
  if (ctx.sessions) {
    for (const [id, s] of ctx.sessions) {
      if (hasPins && !pinned.has(id)) continue;
      if ((s.updatedAt || 0) >= latest) {
        latest = s.updatedAt || 0;
        sid    = id;
        editor = s.editor || "";
      }
    }
  }
  const name  = (sid && ctx.sessionNames && ctx.sessionNames[sid]) || "Clawd";
  const color = EDITOR_COLOR[editor] || DEFAULT_COLOR;
  return { name, color };
}

function show() {
  if (chatWin && !chatWin.isDestroyed()) {
    reposition();
    chatWin.webContents.send("chat-show", getSessionInfo());
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
    chatWin.webContents.send("chat-show", getSessionInfo());
    reposition();
    chatWin.show();
    chatWin.focus();
    // Freeze Clawd while chat bubble is open
    if (ctx.freezeFollower) ctx.freezeFollower();
  });

  chatWin.on("blur", () => {
    // Close when user clicks away
    setTimeout(() => {
      if (chatWin && !chatWin.isDestroyed() && !chatWin.isFocused()) {
        hide();
      }
    }, 150);
  });

  chatWin.on("closed", () => {
    chatWin = null;
    // Only unfreeze if: not suppressed by this close, AND not in a manual freeze
    if (!suppressUnfreeze && !manuallyFrozen && ctx.unfreezeFollower) ctx.unfreezeFollower();
    suppressUnfreeze = false;
  });
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
