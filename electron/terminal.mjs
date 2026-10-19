// Integrated terminal: a shell running inside the project folder, streamed to the app window.
// Real PTY without native modules: on Linux/macOS a tiny Python helper allocates the PTY and passes
// resize events over an extra pipe. Without Python (e.g. Windows) it falls back to a plain piped shell.
import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const PTY_HELPER = `
import os, pty, sys, select, struct, fcntl, termios, signal
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(shell, [shell])
def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
setsize(cols, rows)
pending = b""
alive = True
while alive:
    try:
        ready, _, _ = select.select([fd, 0, 3], [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        os.write(1, chunk)
    if 0 in ready:
        chunk = os.read(0, 65536)
        if not chunk:
            os.kill(pid, signal.SIGHUP)
            break
        os.write(fd, chunk)
    if 3 in ready:
        chunk = os.read(3, 4096)
        if chunk:
            pending += chunk
            while b"\\n" in pending:
                line, pending = pending.split(b"\\n", 1)
                try:
                    c, r = line.split()
                    setsize(int(c), int(r))
                except ValueError:
                    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass
`;

const sessions = new Map();
let nextId = 1;

function startPty(cwd, cols, rows) {
  const shell = process.env.SHELL || "/bin/bash";
  const child = spawn("python3", ["-u", "-c", PTY_HELPER, shell, String(cols), String(rows)], {
    cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  });
  return { child, mode: "pty", resize: (c, r) => child.stdio[3].write(`${c} ${r}\n`) };
}

function startPiped(cwd) {
  const win = process.platform === "win32";
  const child = spawn(win ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh", win ? [] : ["-i"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  return { child, mode: "pipe", resize: () => {} };
}

export function registerTerminalIpc(getRoot) {
  ipcMain.handle("term:start", (event, cols, rows) => {
    const cwd = getRoot();
    if (!cwd) throw new Error("Open a project first.");
    const id = nextId++;
    let made = null;
    if (process.platform !== "win32") {
      try {
        made = startPty(cwd, cols || 80, rows || 24);
      } catch {}
    }
    if (!made) made = startPiped(cwd);
    const { child, mode, resize } = made;

    // A missing python3 shows up as an async spawn error; switch to the piped shell then
    let current = { child, mode, resize };
    const send = (channel, ...args) => { if (!event.sender.isDestroyed()) event.sender.send(channel, id, ...args); };
    const wire = (c) => {
      const dec = new StringDecoder("utf8");
      const out = (d) => send("term:data", dec.write(d));
      c.stdout.on("data", out);
      c.stderr.on("data", out);
      c.on("exit", (code) => { sessions.delete(id); send("term:exit", code ?? 0); });
    };
    child.on("error", () => {
      if (mode !== "pty") return send("term:exit", -1);
      const fb = startPiped(cwd);
      current = fb;
      sessions.set(id, fb);
      wire(fb.child);
      send("term:mode", "pipe");
    });
    wire(child);
    sessions.set(id, current);
    event.sender.once("destroyed", () => child.kill());
    return { id, mode };
  });

  ipcMain.handle("term:write", (_e, id, data) => {
    const s = sessions.get(id);
    if (s && !s.child.stdin.destroyed) s.child.stdin.write(String(data));
  });
  ipcMain.handle("term:resize", (_e, id, cols, rows) => {
    const s = sessions.get(id);
    if (s && cols > 0 && rows > 0) s.resize(cols, rows);
  });
  ipcMain.handle("term:kill", (_e, id) => {
    const s = sessions.get(id);
    if (s) { s.child.kill(); sessions.delete(id); }
  });
}
