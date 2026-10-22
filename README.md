# Peridot Desktop

Electron shell for [Peridot AI](https://tryperidot.io). It opens the hosted web app (`https://tryperidot.io/chat`) in its own window and adds what a browser cannot: a custom title bar, Google sign-in through the system browser, project folders for Peridot Code and the integrated terminal.

This repository contains **only the desktop shell**. The interface is the website itself, so there is nothing else to build.

```bash
bun install
bun run start          # run the app
bun run build          # installers into release/ (AppImage/deb, NSIS)
bun run build:linux
bun run build:win
```

Requires internet access. If the site cannot be reached the app shows a "Can't reach Peridot" screen with a retry button.

## Configuration

| Variable | Default | |
|---|---|---|
| `PERIDOT_URL` | `https://tryperidot.io` | Site to load. Must be `https://`, except `localhost` / `127.0.0.1` for development: `PERIDOT_URL=http://localhost:5173 bun run dev` |

The API server's `CORS_ORIGIN` must include the site's origin.

## Security model

The page gets access to files and a shell inside the chosen project folder, so:

- IPC handlers answer **only** the top-level frame of the configured origin (`electron/main.mjs`); any other site or iframe is refused.
- The `window.peridotDesktop` bridge is only exposed on that same origin (`electron/preload.cjs`).
- Navigation away from the site and `window.open` go to the user's browser, never into the app window.
- Only microphone and clipboard-write permissions are granted, and only to the site itself.
- The renderer runs with `sandbox`, `contextIsolation` and without Node integration.

Everything is ultimately trusted to whoever controls the configured site, so only point `PERIDOT_URL` at a server you trust.
