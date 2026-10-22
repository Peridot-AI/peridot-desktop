// Runs installed plugins in a child process started by plugins.mjs: Electron's Node with the
// permission model on, so this process can read only the plugins folder and the open project,
// write only inside the project, and cannot start other programs. It knows nothing of Electron.
//
// argv: <plugins dir> <project root or "">. Messages from the parent: { id, op, ... }; replies: { id, ok, result | error }.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [PLUGINS_DIR, ROOT_ARG] = process.argv.slice(2);
const root = ROOT_ARG || null;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", "target", "__pycache__", ".venv", "release"]);
const MAX_FILE_BYTES = 400_000;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const toolId = (plugin, tool) => `${plugin.replace(/-/g, "_")}__${tool}`;

// ── ctx.workspace: confined to the project folder (same rules as the agent's tools) ──
function inside(rel = ".") {
  if (!root) throw new Error("Open a project folder first.");
  const abs = path.resolve(root, String(rel));
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}
const relOf = (abs) => path.relative(root, abs) || ".";
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function readText(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error("Not a file.");
  if (st.size > MAX_FILE_BYTES) throw new Error(`File is too large (${st.size} bytes).`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error("Binary file.");
  return buf.toString("utf8");
}

function listFiles(p = ".", recursive = false) {
  const base = inside(p);
  if (!isDir(base)) throw new Error(`Not a directory: ${p}`);
  const out = [];
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 500) return;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      out.push(relOf(abs) + (e.isDirectory() ? "/" : ""));
      if (recursive && e.isDirectory() && depth < 3) walk(abs, depth + 1);
    }
  };
  walk(base, 1);
  return out;
}

function search(pattern, p = ".") {
  let re;
  try { re = new RegExp(pattern); } catch (e) { throw new Error(`Bad regex: ${e.message}`); }
  const hits = [];
  const visit = (abs) => {
    if (hits.length >= 100) return;
    const st = fs.lstatSync(abs); // never follow symlinks out of the workspace
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) if (!SKIP_DIRS.has(e)) visit(path.join(abs, e));
    } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return;
      buf.toString("utf8").split("\n").forEach((line, i) => {
        if (hits.length < 100 && re.test(line)) hits.push(`${relOf(abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
  };
  visit(inside(p));
  return hits;
}

/** `canWrite`: commands the user runs and tools the user approved may write; read-only tools and activate() may not. */
function makeCtx(plugin, user, output, canWrite) {
  return {
    client: "desktop",
    platform: process.platform,
    user: user && typeof user === "object" ? { name: user.name, email: String(user.email ?? "") } : null,
    workspace: {
      root,
      readFile: (p) => readText(inside(p)),
      writeFile: (p, content) => {
        if (!canWrite) throw new Error(`The ${plugin} plugin can only write files from a command or a tool with approval "edit".`);
        const abs = inside(p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content));
      },
      listFiles,
      search,
    },
    print: (text) => output.push(String(text)),
    log: (text) => console.log(`[plugin ${plugin}] ${text}`),
  };
}

// ── Loading ──
async function entryOf(dir) {
  let main;
  try { main = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).main; } catch {}
  for (const rel of [main, "src/index.ts", "index.ts", "index.js"]) {
    if (!rel) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue; // main must stay inside the plugin folder
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error("no entry file (package.json main or src/index.ts)");
}

const loaded = new Map();

async function load(names) {
  const errors = [];
  for (const name of names) {
    if (!PLUGIN_NAME.test(name)) continue;
    const dir = path.join(PLUGINS_DIR, name);
    try {
      const mod = await import(pathToFileURL(await entryOf(dir)).href);
      const def = mod?.default ?? mod;
      if (!def || typeof def !== "object") throw new Error("the default export is not a plugin");
      const commands = {};
      for (const [k, c] of Object.entries(def.commands ?? {})) {
        if (COMMAND_NAME.test(k) && typeof c?.run === "function") commands[k] = c;
        else errors.push(`${name}: skipped command "${k}"`);
      }
      const tools = {};
      for (const [k, t] of Object.entries(def.tools ?? {})) {
        if (TOOL_NAME.test(k) && typeof t?.run === "function" && typeof t.description === "string") tools[k] = t;
        else errors.push(`${name}: skipped tool "${k}"`);
      }
      await def.activate?.(makeCtx(name, null, [], false));
      loaded.set(name, { name, version: String(def.version ?? "0.0.0"), commands, tools });
    } catch (e) {
      errors.push(`${name}: ${e?.message || e}`);
    }
  }
  return {
    errors,
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

async function command(plugin, name, args, user) {
  const cmd = loaded.get(plugin)?.commands[name];
  if (!cmd) return { ok: false, output: `Unknown command /${name}` };
  const output = [];
  try {
    await cmd.run(Array.isArray(args) ? args.map(String) : [], makeCtx(plugin, user, output, true));
    return { ok: true, output: output.join("\n") };
  } catch (e) {
    return { ok: false, output: [...output, e?.message || String(e)].join("\n") };
  }
}

async function tool(id, input, user) {
  for (const p of loaded.values()) {
    for (const [name, t] of Object.entries(p.tools)) {
      if (toolId(p.name, name) !== id) continue;
      const canWrite = t.approval === "edit" || t.approval === "command";
      try {
        const r = await t.run(input ?? {}, makeCtx(p.name, user, [], canWrite));
        if (r && typeof r === "object" && "output" in r) return { ok: r.ok !== false, output: String(r.output) };
        return { ok: true, output: r === undefined ? "(done)" : typeof r === "string" ? r : JSON.stringify(r) };
      } catch (e) {
        return { ok: false, output: e?.message || String(e) };
      }
    }
  }
  return { ok: false, output: `Unknown tool: ${id}` };
}

process.on("message", async (msg) => {
  const { id, op } = msg ?? {};
  try {
    const result =
      op === "load" ? await load(msg.names)
      : op === "command" ? await command(msg.plugin, msg.command, msg.args, msg.user)
      : op === "tool" ? await tool(msg.id2, msg.input, msg.user)
      : (() => { throw new Error(`unknown op ${op}`); })();
    process.send({ id, ok: true, result });
  } catch (e) {
    process.send({ id, ok: false, error: e?.message || String(e) });
  }
});
