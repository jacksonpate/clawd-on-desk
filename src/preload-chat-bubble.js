const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  onShow:        (cb) => ipcRenderer.on("chat-show", (_, data) => cb(data)),
  onHide:        (cb) => ipcRenderer.on("chat-hide", () => cb()),
  send:          (msg) => ipcRenderer.send("chat-send", msg),
  close:         () => ipcRenderer.send("chat-close"),
  reportHeight:  (h) => ipcRenderer.send("chat-height", h),
});
