// Installed plugins, shared with the CLI: ~/.config/peridot/plugins/<name> (or $XDG_CONFIG_HOME/peridot/plugins).
// Installing downloads the plugin's GitHub repository; the web app only offers plugins approved on peridot.ai.
import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

async function install(name, repoUrl) {
  if (!PLUGIN_NAME.test(String(name))) throw new Error(`Invalid plugin name: ${name}`);
  const slug = githubSlug(repoUrl);
  if (!slug) throw new Error("This plugin has no GitHub repository to install from.");

  const res = await fetch(`https://codeload.github.com/${slug}/tar.gz/HEAD`);
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

    const entry = { name, version, repo: `https://github.com/${slug}`, installedAt: new Date().toISOString() };
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

export function registerPluginsIpc() {
  ipcMain.handle("plugins:installed", () => readIndex());
  ipcMain.handle("plugins:install", (_e, name, repoUrl) => install(name, repoUrl));
  ipcMain.handle("plugins:uninstall", (_e, name) => uninstall(name));
}
