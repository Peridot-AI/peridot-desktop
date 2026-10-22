const { contextBridge, ipcRenderer } = require("electron");

// Lets the web app know it runs inside the desktop shell.
contextBridge.exposeInMainWorld("peridotDesktop", {
  platform: process.platform,
  // Google sign-in through the system browser; resolves with an OAuth access token.
  googleAuth: (clientId) => ipcRenderer.invoke("google-auth", clientId),
  // Opens a web page in the user's own browser
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // Project folder for Peridot Code. All file access happens in the main process, inside that folder.
  // Window buttons for the custom top bar (the window has no system frame)
  win: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("win:toggle-maximize"),
    close: () => ipcRenderer.invoke("win:close"),
    isMaximized: () => ipcRenderer.invoke("win:is-maximized"),
    onMaximized: (cb) => {
      const h = (_e, v) => cb(v);
      ipcRenderer.on("win:maximized", h);
      return () => ipcRenderer.removeListener("win:maximized", h);
    },
  },
  // Integrated terminal (shell in the project folder)
  term: {
    start: (cols, rows) => ipcRenderer.invoke("term:start", cols, rows),
    write: (id, data) => ipcRenderer.invoke("term:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke("term:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("term:kill", id),
    on: (event, cb) => {
      const ch = "term:" + event;
      const h = (_e, ...args) => cb(...args);
      ipcRenderer.on(ch, h);
      return () => ipcRenderer.removeListener(ch, h);
    },
  },
  // Plugins installed on this computer (same folder as the CLI's)
  plugins: {
    installed: () => ipcRenderer.invoke("plugins:installed"),
    install: (name, repoUrl) => ipcRenderer.invoke("plugins:install", name, repoUrl),
    uninstall: (name) => ipcRenderer.invoke("plugins:uninstall", name),
  },
  workspace: {
    reveal: () => ipcRenderer.invoke("workspace:reveal"),
    get: () => ipcRenderer.invoke("workspace:get"),
    pick: () => ipcRenderer.invoke("workspace:pick"),
    open: (dir) => ipcRenderer.invoke("workspace:open", dir),
    close: () => ipcRenderer.invoke("workspace:close"),
    tool: (name, input) => ipcRenderer.invoke("workspace:tool", name, input),
    stop: () => ipcRenderer.invoke("workspace:stop"),
  },
});
