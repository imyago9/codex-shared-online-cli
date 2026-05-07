# Command Sidecar (Windows)

This sidecar is a tiny token-gated command runner for the Windows host. Keep it running on Windows, expose it only through Tailscale, then use the Mac-side client script to fetch/pull, start the server, inspect logs, or run one-off PowerShell commands.

It intentionally has no npm dependencies. Node 18+ is enough.

## Setup

From the Windows checkout:

```powershell
cd command-sidecar
npm run token
```

Save the generated token somewhere private, then start the sidecar:

```powershell
$env:COMMAND_SIDECAR_TOKEN = "<generated-token>"
$env:COMMAND_SIDECAR_ROOTS = "C:\Users\yagof\Projects\codex-shared-online-cli"
$env:COMMAND_SIDECAR_BASE_PATH = "/cmd"
npm start
```

The server binds to `127.0.0.1:3777` by default. Keep that loopback bind and use Tailscale Serve to publish it privately to the tailnet.

```powershell
tailscale serve --bg --set-path=/cmd http://127.0.0.1:3777
```

If your Tailscale client does not support `--set-path`, publish the sidecar on a separate Serve port or temporarily at `/` while debugging. Prefer Serve over Funnel; Funnel is public internet exposure.

## Run From Mac

Set these on the Mac side:

```sh
export WINDOWS_COMMAND_URL="https://desktop-cguakc2.tailbca5e0.ts.net/cmd"
export WINDOWS_COMMAND_TOKEN="<generated-token>"
```

Examples:

```sh
node scripts/windows-command.js --powershell --cwd 'C:\Users\yagof\Projects\codex-shared-online-cli' 'git fetch --all --prune; git pull --ff-only'
node scripts/windows-command.js --powershell --timeout-ms 0 --cwd 'C:\Users\yagof\Projects\codex-shared-online-cli' 'npm start'
node scripts/windows-command.js --cwd 'C:\Users\yagof\Projects\codex-shared-online-cli' -- git status --short --branch
```

## API

- `GET /health`
- `GET /runs`
- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `POST /runs/:id/stop`

Auth is required on every endpoint unless `COMMAND_SIDECAR_ALLOW_NO_TOKEN=true` is set. Pass either `Authorization: Bearer <token>` or `X-Command-Token: <token>`.

`POST /runs` accepts:

```json
{
  "command": "git status --short --branch",
  "shell": "powershell",
  "cwd": "C:\\Users\\yagof\\Projects\\codex-shared-online-cli",
  "timeoutMs": 60000,
  "label": "status"
}
```

Set `"timeoutMs": 0` for intentionally long-running commands such as `npm start`.

For exact executable mode, omit `shell` and pass `args`:

```json
{
  "command": "git",
  "args": ["status", "--short", "--branch"],
  "cwd": "C:\\Users\\yagof\\Projects\\codex-shared-online-cli"
}
```
