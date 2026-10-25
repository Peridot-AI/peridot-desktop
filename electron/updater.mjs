// Update check for the desktop app. The website publishes the latest builds in /downloads/versions.json
// (written by scripts/release.ts on every deploy). Installing replaces the app in place:
//   Windows        downloads the installer and runs it silently; it reopens the app when done
//   Linux AppImage downloads the new AppImage over the running one and restarts
//   Linux .deb     downloads the package and installs it with pkexec (asks for the password), then restarts
// Anything else opens the download in the browser.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WEB = "https://tryperidot.io";
const MANIFEST = `${WEB}/downloads/versions.json`;

/** True when version a is newer than b ("1.2.10" > "1.2.9"). */
export function isNewer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function latest() {
  const res = await fetch(`${MANIFEST}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).desktop;
}

/** Which download this install updates from. */
function kind() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return process.env.APPIMAGE ? "appimage" : "deb";
  return null;
}

async function check() {
  // Development runs (electron:dev, electron:start) are never "out of date"
  if (!app.isPackaged) return { current: app.getVersion(), latest: null, available: false };
  const d = await latest();
  return { current: app.getVersion(), latest: d.version, available: isNewer(d.version, app.getVersion()) };
}

async function download(url, file, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  let last = -1;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== last) onProgress(pct), (last = pct);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && got !== total) throw new Error("Download was interrupted.");
}

async function install(onProgress) {
  const d = await latest();
  const k = kind();
  const url = { windows: d.windows, appimage: d.linuxAppImage, deb: d.linuxDeb }[k];
  if (!url) {
    await shell.openExternal(WEB);
    return { opened: true };
  }

  if (k === "windows") {
    const file = path.join(os.tmpdir(), `peridot-desktop-setup-${d.version}.exe`);
    await download(url, file, onProgress);
    // The installer closes this app, installs over it and opens the new version (see installer/windows/desktop.nsi)
    spawn(file, ["/S"], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 300);
    return { restarting: true };
  }

  if (k === "appimage") {
    const target = process.env.APPIMAGE;
    const tmp = `${target}.download`;
    try {
      await download(url, tmp, onProgress);
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      // No write access to the AppImage's folder: let the user download it themselves
      if (e && (e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS")) {
        await shell.openExternal(url);
        return { opened: true };
      }
      throw e;
    }
    app.relaunch({ execPath: target, args: [] });
    app.exit(0);
    return { restarting: true };
  }

  // .deb: dpkg needs root, pkexec shows the system's password prompt
  const file = path.join(os.tmpdir(), `peridot-desktop-${d.version}.deb`);
  await download(url, file, onProgress);
  const res = spawnSync("pkexec", ["dpkg", "-i", file], { stdio: "ignore" });
  if (res.status !== 0) {
    await shell.openExternal(url);
    return { opened: true };
  }
  app.relaunch();
  app.exit(0);
  return { restarting: true };
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:install", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return install((pct) => win && !win.isDestroyed() && win.webContents.send("update:progress", pct));
  });
}
