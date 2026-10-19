import { app, BrowserWindow, protocol, net, shell, Menu } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "..", "dist");
const devUrl = process.env.ELECTRON_START_URL; // set by `bun run electron:dev`

// Serve the built site from a real origin (peridot://app) so the path-based router,
// absolute asset URLs and CORS all behave like on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: "peridot", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol() {
  protocol.handle("peridot", (request) => {
    const { pathname } = new URL(request.url);
    const requested = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
    const safe = requested.startsWith(distDir) && fs.existsSync(requested) && fs.statSync(requested).isFile();
    // Unknown paths are client-side routes: fall back to index.html
    return net.fetch(pathToFileURL(safe ? requested : path.join(distDir, "index.html")).toString());
  });
}

function isInternal(url) {
  return url.startsWith("peridot://") || (devUrl && url.startsWith(devUrl));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    show: false,
    icon: path.join(here, "..", "public", "logo.png"),
    webPreferences: {
      preload: path.join(here, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // External links open in the user's browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(devUrl || "peridot://app/");
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (!devUrl) registerAppProtocol();
    if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
