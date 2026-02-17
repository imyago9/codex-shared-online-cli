# Remote Agent (Windows Sidecar)

This sidecar runs on the Windows host and exposes desktop streaming + input control for the main `online-cli` app.

## Endpoints
- `GET /health`
- `WS /stream` (JPEG frame stream)
- `WS /input` (normalized mouse/keyboard input)

## Why this exists
The main app can run inside WSL, but Windows desktop capture/control must execute on the Windows host. This sidecar keeps those responsibilities isolated.

## Quick start (Windows host)
```powershell
cd remote-agent
npm install
npm start
```

Default bind: `127.0.0.1:3390`

## Environment
- `REMOTE_AGENT_HOST` (default: `127.0.0.1`)
- `REMOTE_AGENT_PORT` (default: `3390`)
- `REMOTE_STREAM_FPS` (default: `8`)
- `REMOTE_JPEG_QUALITY` (default: `55`)
- `REMOTE_INPUT_ENABLED` (default: `true`)

## Input automation fallback
Input automation uses optional dependency `@nut-tree-fork/nut-js`.
On Windows, if it is not installed or fails to load, the sidecar automatically falls back to a built-in PowerShell input controller.

If both `nut-js` and the PowerShell fallback are unavailable, the sidecar starts in **view-only mode**:
- `/stream` remains available
- `/input` returns a clear unavailable error
- `/health` reports `input.available=false` with a reason

## Notes
- Keep this service private to localhost/Tailscale.
- The main app issues short-lived remote tokens; clients should connect through the main app, not directly to this sidecar.
