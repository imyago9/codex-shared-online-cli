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

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === '') return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRemoteMode(rawValue, fallback) {
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (normalized === 'view' || normalized === 'control') {
    return normalized;
  }
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

function resolvePowerShellCommand() {
  return process.env.POWERSHELL_COMMAND || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
}

function resolvePowerShellArgs() {
  if (process.env.POWERSHELL_ARGS) {
    return parseArgs(process.env.POWERSHELL_ARGS);
  }
  return ['-NoLogo'];
}

// Load .env once so repo-shared defaults work without a dependency.
loadEnvFile(path.join(process.cwd(), '.env'));

const config = {
  host: '127.0.0.1',
  port: parseInteger(process.env.PORT, 3000),
  defaultCols: parseInteger(process.env.DEFAULT_COLS, 120),
  defaultRows: parseInteger(process.env.DEFAULT_ROWS, 30),
  maxSessions: Math.max(parseInteger(process.env.MAX_SESSIONS, 24), 1),
  sessionIdleTimeoutMs: Math.max(parseInteger(process.env.SESSION_IDLE_TIMEOUT_MS, 45 * 60 * 1000), 30_000),
  sessionSweepIntervalMs: Math.max(parseInteger(process.env.SESSION_SWEEP_INTERVAL_MS, 60 * 1000), 10_000),
  wsHeartbeatMs: Math.max(parseInteger(process.env.WS_HEARTBEAT_MS, 30_000), 10_000),
  defaultTerminalProfile: 'powershell',
  powerShellCommand: resolvePowerShellCommand(),
  powerShellArgs: resolvePowerShellArgs(),
  defaultCwd: process.env.PTY_CWD || resolveDefaultCwd(),
  singleConsoleMode: parseBoolean(process.env.SINGLE_CONSOLE_MODE, false),
  tailnetHost: process.env.TAILSCALE_DNS_NAME || '',
  remoteEnabled: parseBoolean(process.env.REMOTE_ENABLED, false),
  remoteAgentUrl: process.env.REMOTE_AGENT_URL || 'http://127.0.0.1:3390',
  remoteDefaultMode: parseRemoteMode(process.env.REMOTE_DEFAULT_MODE, 'view'),
  remoteStreamFps: clampInteger(parseInteger(process.env.REMOTE_STREAM_FPS, 8), 1, 20),
  remoteJpegQuality: clampInteger(parseInteger(process.env.REMOTE_JPEG_QUALITY, 55), 20, 95),
  remoteInputRateLimitPerSec: clampInteger(parseInteger(process.env.REMOTE_INPUT_RATE_LIMIT_PER_SEC, 120), 10, 600),
  remoteInputMaxQueue: clampInteger(parseInteger(process.env.REMOTE_INPUT_MAX_QUEUE, 300), 20, 2_000),
  remoteHealthTimeoutMs: clampInteger(parseInteger(process.env.REMOTE_HEALTH_TIMEOUT_MS, 2_500), 500, 10_000),
  sessionStateFile: process.env.SESSION_STATE_FILE
    ? path.resolve(process.env.SESSION_STATE_FILE)
    : path.join(process.cwd(), '.online-cli', 'sessions-state.json'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

module.exports = config;
