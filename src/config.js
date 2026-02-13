const fs = require('fs');
const path = require('path');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseInteger(rawValue, fallback) {
  if (rawValue == null || rawValue === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === '') return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const tokens = rawValue.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!tokens) {
    return [];
  }

  return tokens.map((token) => token.replace(/^"|"$/g, '')).filter(Boolean);
}

function resolveDefaultCwd() {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || process.cwd();
  }
  return process.env.HOME || process.cwd();
}

function resolveDefaultShell() {
  if (process.env.PTY_COMMAND) {
    return process.env.PTY_COMMAND;
  }

  if (process.platform === 'win32') {
    return 'wsl.exe';
  }

  return process.env.SHELL || '/bin/bash';
}

// Load .env once so repo-shared defaults work without a dependency.
loadEnvFile(path.join(process.cwd(), '.env'));

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parseInteger(process.env.PORT, 3000),
  defaultCols: parseInteger(process.env.DEFAULT_COLS, 120),
  defaultRows: parseInteger(process.env.DEFAULT_ROWS, 30),
  maxSessions: Math.max(parseInteger(process.env.MAX_SESSIONS, 24), 1),
  sessionIdleTimeoutMs: Math.max(parseInteger(process.env.SESSION_IDLE_TIMEOUT_MS, 45 * 60 * 1000), 30_000),
  sessionSweepIntervalMs: Math.max(parseInteger(process.env.SESSION_SWEEP_INTERVAL_MS, 60 * 1000), 10_000),
  wsHeartbeatMs: Math.max(parseInteger(process.env.WS_HEARTBEAT_MS, 30_000), 10_000),
  defaultShell: resolveDefaultShell(),
  defaultShellArgs: parseArgs(process.env.PTY_ARGS),
  defaultCwd: process.env.PTY_CWD || resolveDefaultCwd(),
  tmuxCommand: process.env.TMUX_COMMAND || (process.platform === 'win32' ? 'wsl.exe' : 'tmux'),
  tmuxArgs: parseArgs(process.env.TMUX_ARGS),
  tmuxHistoryLimit: Math.max(parseInteger(process.env.TMUX_HISTORY_LIMIT, 200_000), 2_000),
  tmuxMouseMode: parseBoolean(process.env.TMUX_MOUSE_MODE, true),
  singleConsoleMode: parseBoolean(process.env.SINGLE_CONSOLE_MODE, false),
  authEnabled: parseBoolean(process.env.AUTH_ENABLED, false),
  authPassword: process.env.AUTH_PASSWORD || '',
  authCookieName: process.env.AUTH_COOKIE_NAME || 'online_cli_auth',
  authSessionTtlMs: Math.max(parseInteger(process.env.AUTH_SESSION_TTL_MS, 12 * 60 * 60 * 1000), 60_000),
  authCookieSecure: parseBoolean(process.env.AUTH_COOKIE_SECURE, false),
  sessionStateFile: process.env.SESSION_STATE_FILE
    ? path.resolve(process.env.SESSION_STATE_FILE)
    : path.join(process.cwd(), '.online-cli', 'sessions-state.json'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

module.exports = config;
