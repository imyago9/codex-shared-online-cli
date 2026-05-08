# Online CLI Windows Companion

The Windows Companion is the production bootstrapper for Online CLI. It stays in the system tray, exposes a narrow local controller API, starts/stops the Node server, starts the remote agent through `npm start`, configures Tailscale Serve, and shows a pairing QR code for the iOS app.

## Install From Terminal

From the repository root on Windows:

```powershell
.\windows\install-companion.ps1 -Start
```

For a self-contained build that does not require the .NET runtime on the target machine:

```powershell
.\windows\install-companion.ps1 -SelfContained -Start
```

After launch, open the tray icon panel and use:

- `Run on startup`: starts the companion with Windows.
- `Auto-start server with companion`: starts `npm start` when the companion launches.
- `Configure Tailscale Serve`: publishes `/` to the Node server and `/companion` to the companion controller.
- `Copy Pairing`: copies an `onlinecli://pair?...` payload for the iOS app.

## Controller API

The companion binds to `127.0.0.1:3778` and is intended to be published privately through Tailscale Serve at `/companion`.

Public:

- `GET /companion/api/health`
- `GET /companion/api/status`
- `GET /companion/api/pairing`

Token required:

- `POST /companion/api/server/start`
- `POST /companion/api/server/stop`
- `POST /companion/api/server/restart`
- `POST /companion/api/startup`
- `POST /companion/api/tailscale/serve`
- `GET /companion/api/logs`

Pass the token with:

```text
Authorization: Bearer <token>
```

The token is generated on first launch and stored in `%APPDATA%\OnlineCLICompanion\config.json`.
