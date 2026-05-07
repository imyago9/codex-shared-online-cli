# Online CLI iOS

This is a native SwiftUI shell for the Tailscale-only Online CLI server.

## Run

1. Start the server from the project root:
   ```bash
   npm start
   ```
2. Keep Tailscale connected on the iPhone.
3. Open `ios/OnlineCLI.xcodeproj` in Xcode.
4. Pick an iPhone simulator or device, then build and run the `OnlineCLI` scheme.
5. In the app settings, use the printed tailnet URL from `npm start`, for example:
   ```text
   https://desktop-cguakc2.tailbca5e0.ts.net
   ```

The Console tab is a native terminal client. It connects to `/ws?sessionId=...`, sends PTY input/resize messages directly, and runs native PowerShell sessions. Codex history appears in the Threads tab so terminal sessions and Codex threads are no longer mixed together.

The Remote tab uses the `/ws/remote` stream directly from Swift for a native desktop-control surface with stream profiles, live cursor position, gateway diagnostics, sensitivity controls, and one-tap desktop shortcuts.

## Remote Desktop

Set this in `.env` before running `npm start` if you want remote desktop:

```bash
REMOTE_ENABLED=true
REMOTE_AGENT_URL=http://127.0.0.1:3390
REMOTE_DEFAULT_MODE=view
```

`npm start` starts the Windows sidecar automatically when `REMOTE_ENABLED=true`.

The native app asks `/api/remote/status` and `/api/remote/capabilities` for sidecar health, input availability, display bounds, stream presets, and supported actions. Changing the stream profile in the Remote tab sends a WebSocket `set-stream` message and retunes the sidecar stream without restarting the server.
