import { contextBridge } from "electron";

// Lets the web app know it runs inside the desktop shell.
contextBridge.exposeInMainWorld("peridotDesktop", {
  platform: process.platform,
});
