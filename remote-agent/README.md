# Remote Agent (Windows Sidecar)

This sidecar runs on the Windows host and exposes desktop streaming + input control for the main `online-cli` app.

## Endpoints
- `GET /health`
- `WS /stream` (JPEG frame stream)
- `WS /input` (normalized mouse/keyboard input)

## Why this exists
Windows desktop capture/control runs as a host-side service so the main app can keep terminal, Codex, and remote desktop responsibilities cleanly separated.

## Startup
Set `REMOTE_ENABLED=true` in the main app `.env`, then run `npm start` from the repository root. The main startup script installs missing sidecar dependencies and starts this process automatically.

Manual sidecar startup is still useful for debugging:
```powershell
cd remote-agent
npm start
```

Default bind: `127.0.0.1:3390`

## Environment
- `REMOTE_AGENT_HOST` (default: `127.0.0.1`)
- `REMOTE_AGENT_PORT` (default: `3390`)
- `REMOTE_STREAM_FPS` (default: `10`)
- `REMOTE_JPEG_QUALITY` (default: `62`)
- `REMOTE_INPUT_ENABLED` (default: `true`)
- `REMOTE_INPUT_BACKEND` (Windows default: `powershell`; set `nut-js` to force the optional nut-js backend)

## Input automation fallback
On Windows, input automation defaults to a persistent Win32/PowerShell controller because it writes directly to the OS input APIs with minimal per-event overhead. The optional `@nut-tree-fork/nut-js` backend is still available by setting `REMOTE_INPUT_BACKEND=nut-js`.

If the selected backend is unavailable and no fallback can be started, the sidecar starts in **view-only mode**:
- `/stream` remains available
- `/input` returns a clear unavailable error
- `/health` reports `input.available=false` with a reason

## Notes
- Keep this service private to localhost/Tailscale.
- Browser clients should connect through the main app over Tailscale, not directly to this sidecar.
