// Installed plugins, shared with the CLI: ~/.config/peridot/plugins/<name> (or $XDG_CONFIG_HOME/peridot/plugins).
// Installing downloads the commit that was approved on peridot.ai from the plugin's GitHub repository.
import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceApi } from "./workspace.mjs";

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

// ── Runtime: plugins are TypeScript modules (Electron's Node strips the types) whose default export
// is definePlugin({ ... }). They run in this main process, with the app's permissions, which is why
// only plugins approved on peridot.ai are offered for install.

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const toolId = (plugin, tool) => `${plugin.replace(/-/g, "_")}__${tool}`;

// `import { definePlugin } from "@peridot/plugin"` resolves to this, written next to each plugin
const SHIM_JS = "export const definePlugin = (plugin) => plugin;\nexport default { definePlugin };\n";

async function ensureShim(dir) {
  const shim = path.join(dir, "node_modules", "@peridot", "plugin");
  if (fs.existsSync(path.join(shim, "index.js"))) return;
  await fsp.mkdir(shim, { recursive: true });
  await fsp.writeFile(path.join(shim, "package.json"), JSON.stringify({ name: "@peridot/plugin", type: "module", main: "index.js" }));
  await fsp.writeFile(path.join(shim, "index.js"), SHIM_JS);
}

async function entryOf(dir) {
  let main;
  try {
    main = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8")).main;
  } catch {}
  for (const rel of [main, "src/index.ts", "index.ts", "index.js"]) {
    if (!rel) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue; // main must stay inside the plugin folder
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error("no entry file (package.json main or src/index.ts)");
}

/** name → { name, version, description, commands, tools } */
let loaded = new Map();
let loadErrors = [];

function makeCtx(plugin, user, output) {
  return {
    client: "desktop",
    platform: process.platform,
    user: user && typeof user === "object" ? { name: user.name, email: String(user.email ?? "") } : null,
    workspace: workspaceApi,
    print: (text) => output.push(String(text)),
    log: (text) => console.log(`[plugin ${plugin}] ${text}`),
  };
}

async function loadAll() {
  loaded = new Map();
  loadErrors = [];
  for (const name of Object.keys(await readIndex())) {
    if (!PLUGIN_NAME.test(name)) continue;
    const dir = path.join(PLUGINS_DIR, name);
    try {
      await ensureShim(dir);
      // The query makes a reinstalled plugin load fresh instead of from the module cache
      const mod = await import(`${pathToFileURL(await entryOf(dir)).href}?v=${Date.now()}`);
      const def = mod?.default ?? mod;
      if (!def || typeof def !== "object") throw new Error("the default export is not a plugin");
      const commands = {};
      for (const [k, c] of Object.entries(def.commands ?? {})) {
        if (COMMAND_NAME.test(k) && typeof c?.run === "function") commands[k] = c;
        else loadErrors.push(`${name}: skipped command "${k}"`);
      }
      const tools = {};
      for (const [k, t] of Object.entries(def.tools ?? {})) {
        if (TOOL_NAME.test(k) && typeof t?.run === "function" && typeof t.description === "string") tools[k] = t;
        else loadErrors.push(`${name}: skipped tool "${k}"`);
      }
      await def.activate?.(makeCtx(name, null, []));
      loaded.set(name, { name, version: String(def.version ?? "0.0.0"), description: String(def.description ?? ""), commands, tools });
    } catch (e) {
      loadErrors.push(`${name}: ${e?.message || e}`);
    }
  }
}

let ready = null;
const whenLoaded = () => (ready ??= loadAll());
const reload = () => (ready = loadAll());

/** Commands and tools of the loaded plugins, without their code, for the renderer */
export async function describe() {
  await whenLoaded();
  return {
    errors: loadErrors,
    plugins: [...loaded.values()].map((p) => ({
      name: p.name,
      version: p.version,
      commands: Object.entries(p.commands).map(([name, c]) => ({ name, desc: String(c.desc ?? ""), usage: c.usage ? String(c.usage) : "" })),
      tools: Object.entries(p.tools).map(([name, t]) => ({
        name: toolId(p.name, name),
        description: `[${p.name} plugin] ${t.description}`,
        input_schema: t.input && typeof t.input === "object" ? t.input : { type: "object", properties: {} },
        approval: t.approval === "edit" || t.approval === "command" ? t.approval : null,
      })),
    })),
  };
}

export async function runCommand(plugin, command, args, user) {
  await whenLoaded();
  const cmd = loaded.get(plugin)?.commands[command];
  if (!cmd) return { ok: false, output: `Unknown command /${command}` };
  const output = [];
  try {
    await cmd.run(Array.isArray(args) ? args.map(String) : [], makeCtx(plugin, user, output));
    return { ok: true, output: output.join("\n") };
  } catch (e) {
    return { ok: false, output: [...output, e?.message || String(e)].join("\n") };
  }
}

export async function runTool(id, input, user) {
  await whenLoaded();
  for (const p of loaded.values()) {
    for (const [name, t] of Object.entries(p.tools)) {
      if (toolId(p.name, name) !== id) continue;
      try {
        const r = await t.run(input ?? {}, makeCtx(p.name, user, []));
        if (r && typeof r === "object" && "output" in r) return { ok: r.ok !== false, output: String(r.output) };
        return { ok: true, output: r === undefined ? "(done)" : typeof r === "string" ? r : JSON.stringify(r) };
      } catch (e) {
        return { ok: false, output: e?.message || String(e) };
      }
    }
  }
  return { ok: false, output: `Unknown tool: ${id}` };
}

export function registerPluginsIpc() {
  ipcMain.handle("plugins:installed", () => readIndex());
  ipcMain.handle("plugins:install", async (_e, name, repoUrl, sha) => {
    const entry = await install(name, repoUrl, sha);
    await reload();
    return entry;
  });
  ipcMain.handle("plugins:uninstall", async (_e, name) => {
    await uninstall(name);
    await reload();
  });
  ipcMain.handle("plugins:loaded", () => describe());
  ipcMain.handle("plugins:command", (_e, plugin, command, args, user) => runCommand(plugin, command, args, user));
  ipcMain.handle("plugins:tool", (_e, id, input, user) => runTool(id, input, user));
}
