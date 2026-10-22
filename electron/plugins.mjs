// Installed plugins, shared with the CLI: ~/.config/peridot/plugins/<name> (or $XDG_CONFIG_HOME/peridot/plugins).
// Installing downloads the commit that was approved on peridot.ai from the plugin's GitHub repository.
import { app, ipcMain } from "electron";
import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRoot } from "./workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const PLUGINS_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "peridot", "plugins");
const INDEX = path.join(PLUGINS_DIR, "installed.json");
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

async function readIndex() {
  try {
    return JSON.parse(await fsp.readFile(INDEX, "utf8"));
  } catch {
    return {};
  }
}

async function saveIndex(index) {
  await fsp.mkdir(PLUGINS_DIR, { recursive: true });
  await fsp.writeFile(INDEX, JSON.stringify(index, null, 2));
}

function githubSlug(url) {
  const m = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

function untar(file, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xzf", file, "-C", dest, "--strip-components=1"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("Could not run tar to unpack the plugin.")));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exited with ${code}`))));
  });
}

async function install(name, repoUrl, sha) {
  if (!PLUGIN_NAME.test(String(name))) throw new Error(`Invalid plugin name: ${name}`);
  const slug = githubSlug(repoUrl);
  if (!slug) throw new Error("This plugin has no GitHub repository to install from.");
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error("This plugin has no approved version to install yet.");

  // The exact commit that was approved on peridot.ai
  const res = await fetch(`https://codeload.github.com/${slug}/tar.gz/${sha}`);
  if (!res.ok) throw new Error(`Could not download ${slug} from GitHub (${res.status}).`);

  await fsp.mkdir(PLUGINS_DIR, { recursive: true });
  const archive = path.join(os.tmpdir(), `peridot-plugin-${name}-${Date.now()}.tar.gz`);
  const staging = path.join(PLUGINS_DIR, `.${name}-${Date.now()}`);
  const dest = path.join(PLUGINS_DIR, name);
  try {
    await fsp.writeFile(archive, Buffer.from(await res.arrayBuffer()));
    await fsp.mkdir(staging);
    await untar(archive, staging);
    if (!fs.existsSync(path.join(staging, "src", "index.ts")) && !fs.existsSync(path.join(staging, "package.json"))) {
      throw new Error(`${slug} does not look like a Peridot plugin (no package.json or src/index.ts).`);
    }
    let version = "0.0.0";
    try {
      version = JSON.parse(await fsp.readFile(path.join(staging, "package.json"), "utf8")).version || version;
    } catch {}
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(staging, dest);

    const entry = { name, version, repo: `https://github.com/${slug}`, sha, installedAt: new Date().toISOString() };
    const index = await readIndex();
    index[name] = entry;
    await saveIndex(index);
    return entry;
  } finally {
    await fsp.rm(archive, { force: true });
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function uninstall(name) {
  if (!PLUGIN_NAME.test(String(name))) throw new Error(`Invalid plugin name: ${name}`);
  await fsp.rm(path.join(PLUGINS_DIR, name), { recursive: true, force: true });
  const index = await readIndex();
  delete index[name];
  await saveIndex(index);
}

// ── Runtime: installed plugins run in plugin-host.mjs, a child process using Electron's own Node
// (ELECTRON_RUN_AS_NODE) with the permission model on: it can read only the plugins folder and the
// open project, write only in the project, and cannot start programs. The host is restarted when the
// project changes (its permissions name the folder), after installs, and when a call hangs.

const CALL_TIMEOUT = 30_000;
// `import { definePlugin } from "@peridot/plugin"` resolves to this, written next to each plugin
// (by this process: the host may not write there)
const SHIM_JS = "export const definePlugin = (plugin) => plugin;\nexport default { definePlugin };\n";

async function ensureShim(dir) {
  const shim = path.join(dir, "node_modules", "@peridot", "plugin");
  if (fs.existsSync(path.join(shim, "index.js"))) return;
  await fsp.mkdir(shim, { recursive: true });
  await fsp.writeFile(path.join(shim, "package.json"), JSON.stringify({ name: "@peridot/plugin", type: "module", main: "index.js" }));
  await fsp.writeFile(path.join(shim, "index.js"), SHIM_JS);
}

/** { child, root, info, pending, nextId } for the running host, or null */
let host = null;
let starting = null;

function stopHost() {
  if (!host) return;
  for (const { reject, timer } of host.pending.values()) {
    clearTimeout(timer);
    reject(new Error("The plugin host stopped."));
  }
  host.child.kill();
  host = null;
}

function call(h, msg) {
  return new Promise((resolve, reject) => {
    const id = ++h.nextId;
    const timer = setTimeout(() => {
      h.pending.delete(id);
      reject(new Error("The plugin took too long and was stopped."));
      if (host === h) stopHost(); // a stuck plugin would block every later call
    }, CALL_TIMEOUT);
    h.pending.set(id, { resolve, reject, timer });
    h.child.send({ ...msg, id });
  });
}

async function startHost(root) {
  await fsp.mkdir(PLUGINS_DIR, { recursive: true });
  const names = Object.keys(await readIndex()).filter((n) => PLUGIN_NAME.test(n));
  for (const n of names) if (fs.existsSync(path.join(PLUGINS_DIR, n))) await ensureShim(path.join(PLUGINS_DIR, n));

  // The host script is copied next to the plugins, so reading it needs no extra permission (and works
  // from inside the packaged app's archive)
  const hostDir = path.join(PLUGINS_DIR, ".host");
  await fsp.mkdir(hostDir, { recursive: true });
  const hostFile = path.join(hostDir, "plugin-host.mjs");
  await fsp.writeFile(hostFile, await fsp.readFile(path.join(here, "plugin-host.mjs")));

  const realPlugins = fs.realpathSync(PLUGINS_DIR);
  const allow = (flag, dir) => [`--allow-fs-${flag}=${dir}`, `--allow-fs-${flag}=${path.join(dir, "*")}`];
  const execArgv = ["--permission", ...allow("read", realPlugins), ...(root ? [...allow("read", root), ...allow("write", root)] : [])];
  const child = fork(hostFile, [realPlugins, root ?? ""], {
    execPath: process.execPath,
    execArgv,
    env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const h = { child, root, info: { plugins: [], errors: [] }, pending: new Map(), nextId: 0 };
  child.on("message", (m) => {
    const p = h.pending.get(m?.id);
    if (!p) return;
    h.pending.delete(m.id);
    clearTimeout(p.timer);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  });
  child.on("exit", () => {
    for (const { reject, timer } of h.pending.values()) {
      clearTimeout(timer);
      reject(new Error("The plugin host stopped."));
    }
    h.pending.clear();
    if (host === h) host = null;
  });
  host = h;
  h.info = await call(h, { op: "load", names });
  return h;
}

/** The host for the current project, started (or restarted for another project) when needed. */
async function getHost() {
  const root = getRoot();
  if (host && host.root === root) return host;
  if (starting) await starting.catch(() => {});
  if (host && host.root === root) return host;
  stopHost();
  starting = startHost(root);
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** Commands and tools of the loaded plugins, for the renderer */
export async function describe() {
  try {
    return (await getHost()).info;
  } catch (e) {
    return { plugins: [], errors: [`Plugins could not start: ${e?.message || e}`] };
  }
}

export async function runCommand(plugin, command, args, user) {
  try {
    return await call(await getHost(), { op: "command", plugin, command, args, user });
  } catch (e) {
    return { ok: false, output: e?.message || String(e) };
  }
}

export async function runTool(id, input, user) {
  try {
    return await call(await getHost(), { op: "tool", id2: id, input, user });
  } catch (e) {
    return { ok: false, output: e?.message || String(e) };
  }
}

app.on("will-quit", stopHost);

export function registerPluginsIpc() {
  ipcMain.handle("plugins:installed", () => readIndex());
  ipcMain.handle("plugins:install", async (_e, name, repoUrl, sha) => {
    const entry = await install(name, repoUrl, sha);
    stopHost(); // loads the new plugin on next use
    return entry;
  });
  ipcMain.handle("plugins:uninstall", async (_e, name) => {
    stopHost();
    await uninstall(name);
  });
  ipcMain.handle("plugins:loaded", () => describe());
  ipcMain.handle("plugins:command", (_e, plugin, command, args, user) => runCommand(plugin, command, args, user));
  ipcMain.handle("plugins:tool", (_e, id, input, user) => runTool(id, input, user));
}
