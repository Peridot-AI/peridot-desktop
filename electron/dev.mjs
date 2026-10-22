// Starts Vite and Electron together for `bun run electron:dev`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const url = "http://localhost:5173";

// The desktop app in development uses the hosted backend. PERIDOT_DEV_API=local uses the server on localhost:3001 instead.
const hosted = process.env.PERIDOT_DEV_API !== "local";
const viteEnv = hosted ? { ...process.env, VITE_API_URL: "/api", DEV_API_PROXY: "https://api.tryperidot.io" } : process.env;
const vite = spawn("bunx", ["vite", "--port", "5173", "--strictPort"], { stdio: "inherit", env: viteEnv });

async function waitForVite() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Vite did not start in time");
}

await waitForVite();
const app = spawn(electronBin, ["."], { stdio: "inherit", env: { ...process.env, ELECTRON_START_URL: url } });
const stop = () => vite.kill();
app.on("exit", (code) => { stop(); process.exit(code ?? 0); });
process.on("SIGINT", () => { app.kill(); stop(); });
