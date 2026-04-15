const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("responseAPI", {
  onShow:       (cb) => ipcRenderer.on("response-show", (_, data) => cb(data)),
  onHide:       (cb) => ipcRenderer.on("response-hide", () => cb()),
  onPin:        (cb) => ipcRenderer.on("response-pin", () => cb()),
  close:        () => ipcRenderer.send("response-close"),
  pin:          () => ipcRenderer.send("response-pin"),
  reportHeight: (h) => ipcRenderer.send("response-height", h),
});
