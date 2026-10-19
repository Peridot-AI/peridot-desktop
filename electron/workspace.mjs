// File and shell tools for the coding agent. Everything is confined to the folder the user picked.
import { app, dialog, ipcMain, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", "target", "__pycache__", ".venv", "release"]);
const MAX_FILE_BYTES = 400_000;
const MAX_OUTPUT = 30_000;

let root = null; // real path of the active workspace
const storeFile = () => path.join(app.getPath("userData"), "workspaces.json");

function readStore() {
  try { return JSON.parse(fs.readFileSync(storeFile(), "utf8")); } catch { return { recent: [] }; }
}
function remember(dir) {
  const recent = [dir, ...readStore().recent.filter((d) => d !== dir)].slice(0, 8);
  fs.writeFileSync(storeFile(), JSON.stringify({ recent }));
  return recent;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Resolves a user/model supplied path inside the workspace, following symlinks. */
function inside(rel = ".") {
  if (!root) throw new Error("No folder is open.");
  const abs = path.resolve(root, String(rel));
  // For files that don't exist yet, check the nearest existing parent
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

function listFiles({ path: p = ".", recursive = false }) {
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
  return out.join("\n") || "(empty)";
}

function readText(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error("Not a file.");
  if (st.size > MAX_FILE_BYTES) throw new Error(`File is too large (${st.size} bytes). Use search or read part of it.`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error("Binary file.");
  return buf.toString("utf8");
}

function readFile({ path: p, offset = 1, limit = 2000 }) {
  const lines = readText(inside(p)).split("\n");
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
  return body + (start - 1 + limit < lines.length ? `\n… (${lines.length} lines total)` : "");
}

function search({ pattern, path: p = ".", ignore_case = false }) {
  let re;
  try { re = new RegExp(pattern, ignore_case ? "i" : ""); } catch (e) { throw new Error(`Bad regex: ${e.message}`); }
  const start = inside(p);
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
  visit(start);
  return hits.join("\n") || "No matches.";
}

function writeFile({ path: p, content }) {
  const abs = inside(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, String(content));
  return `${existed ? "Overwrote" : "Created"} ${relOf(abs)} (${String(content).split("\n").length} lines).`;
}

function editFile({ path: p, old_string, new_string, replace_all = false }) {
  const abs = inside(p);
  const text = readText(abs);
  if (!old_string) throw new Error("old_string is empty.");
  const count = text.split(old_string).length - 1;
  if (count === 0) throw new Error("old_string was not found. Read the file again and copy the text exactly.");
  if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times. Add more context or set replace_all.`);
  fs.writeFileSync(abs, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
  return `Edited ${relOf(abs)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""}).`;
}

const running = new Set();
function runCommand({ command }) {
  if (!root) throw new Error("No folder is open.");
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], { cwd: root, env: process.env });
    running.add(child);
    let out = "";
    const add = (d) => { if (out.length < MAX_OUTPUT * 2) out += d.toString(); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { out += "\n[timed out after 120s]"; child.kill("SIGKILL"); }, 120_000);
    const end = (code) => {
      clearTimeout(timer);
      running.delete(child);
      const text = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT / 2) + "\n… (output cut) …\n" + out.slice(-MAX_OUTPUT / 2) : out;
      resolve(`${text.trim() || "(no output)"}\n[exit code ${code}]`);
    };
    child.on("error", (e) => { out += String(e.message); end(-1); });
    child.on("close", end);
  });
}

const TOOLS = { list_files: listFiles, read_file: readFile, search, write_file: writeFile, edit_file: editFile, run_command: runCommand };

export function registerWorkspaceIpc() {
  ipcMain.handle("workspace:get", () => ({ root, recent: readStore().recent.filter(isDir) }));

  ipcMain.handle("workspace:pick", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { title: "Choose your project folder", properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return { root, recent: readStore().recent.filter(isDir) };
    root = fs.realpathSync(res.filePaths[0]);
    return { root, recent: remember(root) };
  });

  // Only folders the user picked earlier (via the dialog) can be reopened without it
  ipcMain.handle("workspace:open", (_e, dir) => {
    const known = readStore().recent;
    if (typeof dir !== "string" || !known.includes(dir) || !isDir(dir)) throw new Error("Unknown folder.");
    root = fs.realpathSync(dir);
    return { root, recent: remember(root) };
  });

  ipcMain.handle("workspace:close", () => { root = null; });

  ipcMain.handle("workspace:tool", async (_e, name, input) => {
    const fn = TOOLS[name];
    if (!fn) return { ok: false, output: `Unknown tool: ${name}` };
    try {
      return { ok: true, output: String(await fn(input ?? {})) };
    } catch (err) {
      return { ok: false, output: err.message || String(err) };
    }
  });

  ipcMain.handle("workspace:stop", () => { for (const c of running) c.kill("SIGKILL"); });
}
