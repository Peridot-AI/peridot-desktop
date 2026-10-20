// `bun run dev`: opens Electron against a running dev server of the web app.
// Start the site's dev server first, then run: ELECTRON_START_URL=http://localhost:5173 bun run dev
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const url = process.env.ELECTRON_START_URL || "http://localhost:5173";

const app = spawn(electronBin, ["."], { stdio: "inherit", env: { ...process.env, ELECTRON_START_URL: url } });
app.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => app.kill());
