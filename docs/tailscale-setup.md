# Tailscale Setup For Private Remote Access

This guide keeps the app private inside your tailnet while enabling terminal + remote desktop access from desktop and iOS.

## 1) Install and sign in

### Windows host
1. Install Tailscale from https://tailscale.com/download/windows
2. Open Tailscale and sign in to your tailnet account.
3. Confirm the machine appears as `Online` in the Tailscale admin console.

### iOS client
1. Install the Tailscale iOS app from the App Store.
2. Sign in with the same tailnet account (or an allowed shared-user account).
3. Confirm iOS shows `Connected` before opening the web app.

## 2) Start this app + sidecar locally

On the host, run the main app (WSL or Windows, based on your setup):
```bash
npm start
```

If using remote desktop streaming/control, run the Windows sidecar too:
```powershell
cd remote-agent
npm install
npm start
```

## 3) Expose app privately with Tailscale Serve (recommended)

Use Serve, not Funnel, for private tailnet-only access.

From Windows PowerShell:
```powershell
tailscale serve --bg 3000
```

Equivalent explicit HTTP backend form:
```powershell
tailscale serve --bg http://127.0.0.1:3000
```

Check Serve status:
```powershell
tailscale serve status
```

If configured correctly, Tailscale prints a private HTTPS URL for your node (for example `https://your-node.your-tailnet.ts.net`).

## 4) Open from iOS/remote desktop browser

1. Ensure iOS Tailscale is connected.
2. Open the private tailnet HTTPS URL in Safari.
3. Log in to the app normally (`/login` flow still applies).
4. Use Console + Remote tabs side-by-side (or Remote split mode in Console).

## 5) ACL recommendation (important)

Restrict who can reach this node/port in your tailnet ACL policy.

Suggested approach:
1. Create a group (for example `group:online_cli_remote_users`).
2. Allow only that group to connect to this host on HTTPS (`:443`) and/or app port (`:3000`) depending on your Serve policy.
3. Deny broad `* -> *` access when possible.

Example ACL shape (adapt to your tailnet policy file):
```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["group:online_cli_remote_users"],
      "dst": ["tag:online-cli-node:443", "tag:online-cli-node:3000"]
    }
  ]
}
```

## 6) Keep it private by default

- Prefer `tailscale serve` (private) over `tailscale funnel` (public internet).
- Keep `REMOTE_ENABLED=false` unless you explicitly need remote desktop.
- Keep app authentication enabled (`AUTH_ENABLED=true`) for all non-localhost exposure.
