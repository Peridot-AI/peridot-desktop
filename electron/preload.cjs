const { contextBridge, ipcRenderer } = require("electron");

// Lets the web app know it runs inside the desktop shell.
contextBridge.exposeInMainWorld("peridotDesktop", {
  platform: process.platform,
  // Google sign-in through the system browser; resolves with an OAuth access token.
  googleAuth: (clientId) => ipcRenderer.invoke("google-auth", clientId),
  // Opens a web page in the user's own browser
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // Project folder for Peridot Code. All file access happens in the main process, inside that folder.
  workspace: {
    get: () => ipcRenderer.invoke("workspace:get"),
    pick: () => ipcRenderer.invoke("workspace:pick"),
    open: (dir) => ipcRenderer.invoke("workspace:open", dir),
    close: () => ipcRenderer.invoke("workspace:close"),
    tool: (name, input) => ipcRenderer.invoke("workspace:tool", name, input),
    stop: () => ipcRenderer.invoke("workspace:stop"),
  },
});
