# Peridot Desktop

Electron shell for [Peridot AI](https://peridot.ai): window, custom title bar, Google sign-in through the system browser, project folders for Peridot Code, and the integrated terminal.

This repository contains **only the desktop shell**. The web interface is not part of it: the app serves a prebuilt copy of the Peridot web app from `dist/` under the `peridot://app` origin.

## Run / build

1. Put a production build of the Peridot web app into `dist/` (its `index.html` at `dist/index.html`).
2. Install dependencies and start:

```bash
bun install
bun run start          # run the app
bun run build          # installers into release/ (AppImage/deb, NSIS)
bun run build:linux
bun run build:win
```

For development against a running web dev server: `ELECTRON_START_URL=http://localhost:5173 bun run dev`.

The API the packaged app talks to is baked into the web build (`VITE_API_URL`), and that server's `CORS_ORIGIN` must include `peridot://app`.
