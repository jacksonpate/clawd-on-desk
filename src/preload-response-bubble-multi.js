// src/preload-response-bubble-multi.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubbleAPI", {
  onInit:  (cb) => ipcRenderer.on("bubble-init", (_e, data) => cb(data)),
  dismiss: (slot) => ipcRenderer.send("bubble-dismiss", { slot }),
  resize:  (slot, h) => ipcRenderer.send("bubble-resize", { slot, h }),
  open:    (slot) => ipcRenderer.send("bubble-open",    { slot }),
});
