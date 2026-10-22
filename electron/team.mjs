// "Your AI team": the bots of a project live in <project>/.peridot/team.json. The renderer validates the
// content; this side only reads and writes that one file, inside the open project folder.
import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { resolveInside } from "./paths.mjs";

const MAX_BYTES = 200_000;
const REL = path.join(".peridot", "team.json");

export function registerTeamIpc(getRoot) {
  ipcMain.handle("team:load", () => {
    const root = getRoot();
    if (!root) return null;
    try {
      const file = resolveInside(root, REL);
      if (fs.statSync(file).size > MAX_BYTES) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null; // no team yet, or the file isn't valid JSON
    }
  });

  ipcMain.handle("team:save", (_e, data) => {
    const root = getRoot();
    if (!root) throw new Error("No folder is open.");
    const text = JSON.stringify({ version: 1, ...data }, null, 2);
    if (text.length > MAX_BYTES) throw new Error("The team is too large.");
    const file = resolveInside(root, REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Re-check after creating the folder: .peridot could have been a link pointing outside the project
    resolveInside(root, REL);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text + "\n");
    fs.renameSync(tmp, file);
  });
}
