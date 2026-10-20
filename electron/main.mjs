import { app, BrowserWindow, shell, Menu, ipcMain, session } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import { registerWorkspaceIpc, getRoot } from "./workspace.mjs";
import { registerTerminalIpc } from "./terminal.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The app is the hosted website (its /chat page). Override with PERIDOT_URL, e.g. a local dev server.
const APP_URL = (process.env.PERIDOT_URL || "https://peridot.ai").replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(APP_URL).hostname);
if (new URL(APP_URL).protocol !== "https:" && !isLocal) {
  console.error(`Refusing to load ${APP_URL}: remote pages must use https.`);
  app.exit(1);
}
const START_URL = `${APP_URL}/chat`;

const sameOrigin = (url) => {
  try { return new URL(url).origin === APP_ORIGIN; } catch { return false; }
};

// The page can read/write files and run commands through these IPC handlers, so they only answer
// the top-level frame of our own origin. Anything else (other sites, iframes) is refused.
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  realHandle(channel, (event, ...args) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !sameOrigin(frame.url)) throw new Error("Blocked: untrusted caller.");
    return listener(event, ...args);
  });

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

const isInternal = sameOrigin;

// Shown when the site cannot be reached (offline, DNS, server down)
const offlinePage = (reason) => "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Peridot</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#141413;color:#e8e6e0;font-family:sans-serif;-webkit-app-region:drag">
<div style="text-align:center;max-width:420px;padding:24px">
<h2 style="font-weight:500;margin:0 0 10px">Can't reach Peridot</h2>
<p style="color:#8c8a83;margin:0 0 24px;line-height:1.5">Check your internet connection and try again.<br><small>${String(reason).replace(/[<&>]/g, "")}</small></p>
<a href="${START_URL}" style="-webkit-app-region:no-drag;display:inline-block;padding:10px 20px;border-radius:10px;background:#6fd3b7;color:#0f1d19;text-decoration:none;font-weight:600">Try again</a>
<a href="peridot-quit://" style="-webkit-app-region:no-drag;display:inline-block;padding:10px 20px;margin-left:8px;border-radius:10px;border:1px solid #3a3835;color:#e8e6e0;text-decoration:none">Quit</a>
</div>`);

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
      additionalArguments: [`--peridot-origin=${APP_ORIGIN}`],
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
    if (url.startsWith("peridot-quit:")) {
      event.preventDefault();
      app.quit();
    } else if (!isInternal(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(offlinePage(desc)); // -3 = aborted (a redirect), not a failure
  });

  win.loadURL(START_URL);
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
    registerTerminalIpc(getRoot);
    // Only the microphone (dictation) and clipboard writes are granted, and only to our own site
    const allowed = new Set(["media", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(allowed.has(permission) && sameOrigin(wc.getURL())));
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && sameOrigin(origin));
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
