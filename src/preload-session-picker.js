const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("pickerAPI", {
  onShow:       (cb) => ipcRenderer.on("picker-show", (_, data) => cb(data)),
  toggle:       (id) => ipcRenderer.invoke("picker-toggle-selected", id),
  rename:       (id, name) => ipcRenderer.invoke("picker-rename-session", id, name),
  setTarget:    (id, target) => ipcRenderer.invoke("picker-set-target", id, target),
  close:        () => ipcRenderer.send("picker-close"),
  reportHeight: (h) => ipcRenderer.send("picker-height", h),
});
