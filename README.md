# HTTP Toolkit Pro Patcher
# httptoolkit-pro-patcher-2026

A patcher for HTTP Toolkit that unlocks Pro features by injecting a fake subscription into the UI and patching the local server to accept connections from the patched app.

The patched app uses a local proxy server to serve the UI and intercept requests to `app.httptoolkit.tech`, so the UI loads from `http://localhost:5067` while the local backend server is patched to allow cross-origin requests from that origin.

## Features

- Unlocks Pro features in HTTP Toolkit.
- No interactive email prompt — uses a fixed built-in account.
- Auto-detects HTTP Toolkit install path on Windows, macOS and Linux.
- Auto-elevates with `sudo` on Linux when patching system paths.
- Handles HTTP Toolkit updates: re-patches app and server automatically when needed.
- Built-in restore command to revert to original files.
- Cross-platform: Windows, Linux, macOS (path detection included, server patching should work on all platforms).

## Requirements

- [Node.js](https://nodejs.org/) 18 or higher
- HTTP Toolkit installed

## Installation

```bash
npm install
```

## Usage

### Patch and start HTTP Toolkit

```bash
node . start
```

This command:
1. Checks whether the app and server are already patched.
2. Patches them if needed (requires `sudo` on Linux for system installs).
3. Launches HTTP Toolkit.

### Patch only

```bash
node . patch
```

### Restore original files

```bash
node . restore
```

This restores `app.asar` and `httptoolkit-server/bundle/index.js` from their backups.

## How it works

1. **App patch** (`app.asar`):
   - Extracts the Electron app archive.
   - Injects a small proxy server (`patch.js`) at the top of `build/index.js`.
   - Injects a fake `User` object matching `@httptoolkit/accounts` interface into `main.js` when it is downloaded.
   - Repacks the app archive and backs up the original.

2. **Server patch** (`httptoolkit-server/bundle/index.js`):
   - Forces the local API server into development-mode origin allowlist so `http://localhost:5067` is accepted.
   - Patches the strict custom CORS gate to allow requests from the patched UI origin.

3. **Proxy server** (`patch.js`):
   - Starts an HTTP server on `localhost:5067`.
   - Caches UI files from `app.httptoolkit.tech` to the system temp directory.
   - Serves cached files immediately after the first download to avoid slow loading.
   - Patches `main.js` on the fly to inject Pro subscription data.

## Environment variables

- `PORT` — proxy server port (default: `5067`)
- `APP_URL` — internal, set automatically from `PORT`

## Update behavior

HTTP Toolkit auto-updates can overwrite the patched files. The patcher handles this in two ways:

- `node . start` re-patches automatically before launching when it detects unpatched files.
- You can also run `node . patch` manually after an update.

If the UI cache becomes stale or broken, clear it:

```bash
rm -rf /tmp/httptoolkit-patch        # Linux/macOS
rmdir /s /q %TEMP%\httptoolkit-patch  # Windows
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Permission denied` on Linux | The patcher will ask for `sudo`. Run `node . patch` or `node . start` as a normal user and let it re-elevate. |
| "Initialization failed" dialog | Already fixed in `patch.js` by serving an empty service worker instead of `404`. |
| "This is taking longer than normal..." | Already fixed by patching server CORS to accept `localhost:5067` and by caching UI files locally. |
| UI cache is stale | Delete the temp cache directory and run `node . start` again. |
| `ERR_CONNECTION_REFUSED` | Make sure the proxy server started on port `5067` and no other HTTP Toolkit process is running. |

## Disclaimer

This project is for educational purposes only. Use at your own risk. If you find HTTP Toolkit useful, please consider supporting the developers by purchasing a license.

## License

[MIT](LICENSE)
