const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("responseAPI", {
  onShow:       (cb) => ipcRenderer.on("response-show", (_, data) => cb(data)),
  onHide:       (cb) => ipcRenderer.on("response-hide", () => cb()),
  close:        () => ipcRenderer.send("response-close"),
  reportHeight: (h) => ipcRenderer.send("response-height", h),
});
