const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  onShow:          (cb) => ipcRenderer.on("chat-show",           (_, data) => cb(data)),
  onHide:          (cb) => ipcRenderer.on("chat-hide",           () => cb()),
  onThinking:      (cb) => ipcRenderer.on("chat-thinking",       (_, val)  => cb(val)),
  onMessage:       (cb) => ipcRenderer.on("chat-message",        (_, data) => cb(data)),
  onUserMessage:   (cb) => ipcRenderer.on("chat-user-message",   (_, data) => cb(data)),
  onSessionUpdate: (cb) => ipcRenderer.on("chat-session-update", (_, data) => cb(data)),
  send:            (msg) => ipcRenderer.send("chat-send", msg),
  close:           () => ipcRenderer.send("chat-close"),
  reportHeight:    (h) => ipcRenderer.send("chat-height", h),
  getFilePath:     (file) => webUtils.getPathForFile(file),
});
