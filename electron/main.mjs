import { app, BrowserWindow, protocol, net, shell, Menu, ipcMain } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import { registerWorkspaceIpc } from "./workspace.mjs";
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

// Google refuses OAuth inside embedded windows, so sign-in happens in the user's own browser.
// A one-shot loopback server on 127.0.0.1 receives the token (implicit flow returns it in the
// URL fragment, so a tiny page forwards it to the server). Add this redirect URI to the OAuth
// client in Google Cloud Console: http://127.0.0.1:53682/callback
const AUTH_PORT = 53682;
let authServer = null;

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle("win:minimize", (e) => winOf(e)?.minimize());
ipcMain.handle("win:toggle-maximize", (e) => {
  const w = winOf(e);
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.handle("win:close", (e) => winOf(e)?.close());
ipcMain.handle("win:is-maximized", (e) => !!winOf(e)?.isMaximized());

ipcMain.handle("open-external", (_e, url) => {
  const u = new URL(String(url));
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Blocked URL.");
  return shell.openExternal(u.toString());
});

ipcMain.handle("google-auth", (event, clientId) => {
  if (typeof clientId !== "string" || !clientId) throw new Error("Google sign-in is not configured.");
  authServer?.close();
  const state = crypto.randomBytes(16).toString("hex");
  const redirect = `http://127.0.0.1:${AUTH_PORT}/callback`;

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, token) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      authServer = null;
      err ? reject(err) : resolve(token);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname === "/callback") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Peridot</title>
<body style="font-family:sans-serif;background:#141413;color:#eee;text-align:center;padding-top:20vh">
<h2 id="m">Signing you in…</h2><script>
fetch("/token?" + location.hash.slice(1)).then(function(){document.getElementById("m").textContent="Signed in. You can close this tab and return to Peridot."});
</script>`);
      } else if (url.pathname === "/token") {
        res.writeHead(204).end();
        if (url.searchParams.get("state") !== state) return finish(new Error("Google sign-in failed"));
        const token = url.searchParams.get("access_token");
        token ? finish(null, token) : finish(new Error(url.searchParams.get("error") || "Google sign-in failed"));
        BrowserWindow.fromWebContents(event.sender)?.focus();
      } else {
        res.writeHead(404).end();
      }
    });
    const timer = setTimeout(() => finish(new Error("Google sign-in timed out")), 5 * 60 * 1000);
    server.on("error", (e) => finish(e));
    server.listen(AUTH_PORT, "127.0.0.1", () => {
      authServer = server;
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "token", scope: "openid email profile", state, prompt: "select_account" });
      shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
    });
  });
});

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
    frame: false, // the app draws its own top bar with the window buttons
    show: false,
    icon: path.join(here, "..", "public", "logo.png"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  const tell = () => !win.isDestroyed() && win.webContents.send("win:maximized", win.isMaximized());
  win.on("maximize", tell);
  win.on("unmaximize", tell);

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
    registerWorkspaceIpc();
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
