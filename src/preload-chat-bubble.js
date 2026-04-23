const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  onShow:          (cb) => ipcRenderer.on("chat-show",           (_, data) => cb(data)),
  onHide:          (cb) => ipcRenderer.on("chat-hide",           () => cb()),
  onThinking:      (cb) => ipcRenderer.on("chat-thinking",       (_, val)  => cb(val)),
  onMessage:       (cb) => ipcRenderer.on("chat-message",        (_, data) => cb(data)),
  onUserMessage:   (cb) => ipcRenderer.on("chat-user-message",   (_, data) => cb(data)),
  onSessionUpdate: (cb) => ipcRenderer.on("chat-session-update", (_, data) => cb(data)),
  onStream:        (cb) => ipcRenderer.on("chat-stream",         (_, evt)  => cb(evt)),
  send:            (msg) => ipcRenderer.send("chat-send", msg),
  cancel:          ()    => ipcRenderer.send("chat-cancel"),
  close:           () => ipcRenderer.send("chat-close"),
  reportHeight:    (h) => ipcRenderer.send("chat-height", h),
  resizeStart:     ()            => ipcRenderer.send("chat-resize-start"),
  resizeDelta:     (dx, dy, corner) => ipcRenderer.send("chat-resize-delta", { dx, dy, corner }),
  resizeEnd:       ()            => ipcRenderer.send("chat-resize-end"),
  snap:            (where) => ipcRenderer.send("chat-snap", where),
  getFilePath:     (file) => webUtils.getPathForFile(file),
});
