const childProcess = require('child_process');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const startedAt = new Date();
const runs = new Map();

function parseInteger(rawValue, fallback) {
  if (rawValue == null || rawValue === '') {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseTimeout(rawValue, fallback) {
  const parsed = parseInteger(rawValue, fallback);
  if (parsed <= 0) {
    return 0;
  }
  return clampInteger(parsed, 5_000, 24 * 60 * 60 * 1000);
}

function parseBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === '') {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeBasePath(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value || value === '/') {
    return '';
  }
  return value.startsWith('/') ? value.replace(/\/+$/, '') : `/${value.replace(/\/+$/, '')}`;
}

function splitRoots(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }
  return rawValue
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function dedupe(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    const key = normalizePathForCompare(resolved);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

const config = {
  host: process.env.COMMAND_SIDECAR_HOST || '127.0.0.1',
  port: clampInteger(parseInteger(process.env.COMMAND_SIDECAR_PORT, 3777), 1, 65_535),
  token: process.env.COMMAND_SIDECAR_TOKEN || '',
  allowNoToken: parseBoolean(process.env.COMMAND_SIDECAR_ALLOW_NO_TOKEN, false),
  basePath: normalizeBasePath(process.env.COMMAND_SIDECAR_BASE_PATH || ''),
  allowedRoots: dedupe([
    repoRoot,
    ...splitRoots(process.env.COMMAND_SIDECAR_ROOTS),
    ...splitRoots(process.env.COMMAND_SIDECAR_EXTRA_ROOTS)
  ]),
  defaultCwd: path.resolve(process.env.COMMAND_SIDECAR_CWD || repoRoot),
  maxRuns: clampInteger(parseInteger(process.env.COMMAND_SIDECAR_MAX_RUNS, 80), 10, 400),
  defaultTimeoutMs: clampInteger(
    parseTimeout(process.env.COMMAND_SIDECAR_DEFAULT_TIMEOUT_MS, 15 * 60 * 1000),
    0,
    24 * 60 * 60 * 1000
  ),
  maxTimeoutMs: clampInteger(
    parseInteger(process.env.COMMAND_SIDECAR_MAX_TIMEOUT_MS, 60 * 60 * 1000),
    10_000,
    24 * 60 * 60 * 1000
  ),
  maxOutputChars: clampInteger(
    parseInteger(process.env.COMMAND_SIDECAR_MAX_OUTPUT_CHARS, 1_000_000),
    16_000,
    8_000_000
  ),
  powerShellCommand: process.env.COMMAND_SIDECAR_POWERSHELL || 'powershell.exe'
};

if (!config.token && !config.allowNoToken) {
  console.error('[command-sidecar] COMMAND_SIDECAR_TOKEN is required.');
  console.error('[command-sidecar] Generate one with: npm run token');
  process.exit(1);
}

function isPathAllowed(candidate) {
  const resolved = normalizePathForCompare(candidate);
  return config.allowedRoots.some((root) => {
    const normalizedRoot = normalizePathForCompare(root).replace(/[\\/]$/, '');
    return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function resolveCwd(rawValue) {
  const cwd = path.resolve(typeof rawValue === 'string' && rawValue.trim() ? rawValue : config.defaultCwd);
  if (!isPathAllowed(cwd)) {
    const error = new Error(`cwd is outside COMMAND_SIDECAR_ROOTS: ${cwd}`);
    error.statusCode = 400;
    throw error;
  }
  return cwd;
}

function requestToken(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (req.headers['x-command-token']) {
    return String(req.headers['x-command-token']).trim();
  }
  if (url.searchParams.has('token')) {
    return url.searchParams.get('token') || '';
  }
  return '';
}

function safeTokenEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function requireAuth(req, url) {
  if (config.allowNoToken) {
    return true;
  }
  const suppliedToken = requestToken(req, url);
  if (suppliedToken && safeTokenEquals(suppliedToken, config.token)) {
    return true;
  }
  const error = new Error('Unauthorized');
  error.statusCode = 401;
  throw error;
}

function stripBasePath(pathname) {
  if (!config.basePath) {
    return pathname || '/';
  }
  if (pathname === config.basePath) {
    return '/';
  }
  if (pathname.startsWith(`${config.basePath}/`)) {
    return pathname.slice(config.basePath.length) || '/';
  }
  return pathname || '/';
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  sendJson(res, statusCode, {
    error: statusCode >= 500 ? 'Internal server error' : error.message
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function makeRunId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function appendOutput(run, streamName, text) {
  if (!text) {
    return;
  }
  run[streamName] += text;
  if (run[streamName].length > config.maxOutputChars) {
    run[streamName] = run[streamName].slice(run[streamName].length - config.maxOutputChars);
    run.outputTruncated = true;
  }
  emitRunEvent(run, streamName, {
    text,
    at: new Date().toISOString()
  });
}

function emitRunEvent(run, eventName, payload) {
  const body = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const subscriber of run.subscribers) {
    try {
      subscriber.write(body);
    } catch (_error) {
      run.subscribers.delete(subscriber);
    }
  }
}

function publicRun(run, includeOutput = false) {
  const payload = {
    id: run.id,
    label: run.label,
    command: run.command,
    args: run.args,
    shell: run.shell,
    cwd: run.cwd,
    status: run.status,
    pid: run.pid,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    timeoutMs: run.timeoutMs,
    durationMs: run.endedAt
      ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
      : Date.now() - new Date(run.startedAt).getTime(),
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    outputTruncated: run.outputTruncated,
    stdoutLength: run.stdout.length,
    stderrLength: run.stderr.length
  };

  if (includeOutput) {
    payload.stdout = run.stdout;
    payload.stderr = run.stderr;
  }

  return payload;
}

function coerceStringArray(value, label) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    const error = new Error(`${label} must be an array`);
    error.statusCode = 400;
    throw error;
  }
  return value.map((item) => String(item));
}

function resolveSpawn(payload) {
  const requestedShell = payload.shell === true ? 'system' : String(payload.shell || 'none').toLowerCase();
  const command = typeof payload.command === 'string' ? payload.command.trim() : '';
  const args = coerceStringArray(payload.args, 'args');

  if (!command) {
    const error = new Error('command is required');
    error.statusCode = 400;
    throw error;
  }

  if (requestedShell === 'powershell' || payload.powerShell === true) {
    return {
      command: config.powerShellCommand,
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      shell: 'powershell'
    };
  }

  if (requestedShell === 'cmd') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      shell: 'cmd'
    };
  }

  if (requestedShell === 'system') {
    return {
      command,
      args,
      shell: true
    };
  }

  return {
    command,
    args,
    shell: false
  };
}

function buildEnv(rawEnv) {
  if (rawEnv == null) {
    return process.env;
  }
  if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    const error = new Error('env must be an object');
    error.statusCode = 400;
    throw error;
  }

  const nextEnv = { ...process.env };
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      const error = new Error(`Invalid env key: ${key}`);
      error.statusCode = 400;
      throw error;
    }
    if (value == null) {
      delete nextEnv[key];
    } else {
      nextEnv[key] = String(value);
    }
  }
  return nextEnv;
}

function pruneRuns() {
  if (runs.size <= config.maxRuns) {
    return;
  }

  for (const [id, run] of runs) {
    if (runs.size <= config.maxRuns) {
      return;
    }
    if (run.status !== 'running') {
      runs.delete(id);
    }
  }
}

function terminateRun(run, reason) {
  if (!run || !run.child || run.status !== 'running') {
    return;
  }
  run.timedOut = reason === 'timeout';

  if (process.platform === 'win32' && run.pid) {
    try {
      childProcess.spawnSync('taskkill.exe', ['/PID', String(run.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000
      });
      return;
    } catch (_error) {
      // Fall through to child.kill.
    }
  }

  try {
    run.child.kill('SIGTERM');
  } catch (_error) {
    // Ignore termination races.
  }
}

function createRun(payload) {
  const cwd = resolveCwd(payload.cwd);
  const requestedTimeoutMs = parseInteger(payload.timeoutMs, config.defaultTimeoutMs);
  const timeoutMs = requestedTimeoutMs <= 0
    ? 0
    : clampInteger(requestedTimeoutMs, 1_000, config.maxTimeoutMs);
  const resolved = resolveSpawn(payload);
  const env = buildEnv(payload.env);
  const id = makeRunId();
  const startedAt = new Date().toISOString();
  const run = {
    id,
    label: typeof payload.label === 'string' ? payload.label.slice(0, 120) : '',
    command: resolved.command,
    args: resolved.args,
    shell: resolved.shell,
    cwd,
    status: 'running',
    pid: null,
    startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    subscribers: new Set(),
    child: null,
    timeout: null
  };

  runs.set(id, run);
  pruneRuns();

  const child = childProcess.spawn(resolved.command, resolved.args, {
    cwd,
    env,
    shell: resolved.shell === true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  run.child = child;
  run.pid = child.pid || null;

  if (typeof payload.stdin === 'string' && payload.stdin.length > 0) {
    child.stdin.write(payload.stdin);
  }
  child.stdin.end();

  if (timeoutMs > 0) {
    run.timeout = setTimeout(() => {
      appendOutput(run, 'stderr', `\n[command-sidecar] command timed out after ${timeoutMs}ms\n`);
      terminateRun(run, 'timeout');
    }, timeoutMs);
  }

  child.stdout.on('data', (chunk) => appendOutput(run, 'stdout', chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => appendOutput(run, 'stderr', chunk.toString('utf8')));

  let finalized = false;
  function finishRun(code, signal) {
    if (finalized) {
      return;
    }
    finalized = true;
    clearTimeout(run.timeout);
    run.status = code === 0 ? 'succeeded' : 'failed';
    run.exitCode = Number.isInteger(code) ? code : null;
    run.signal = signal;
    run.endedAt = new Date().toISOString();
    run.child = null;
    emitRunEvent(run, 'exit', publicRun(run));
  }

  child.on('error', (error) => {
    appendOutput(run, 'stderr', `\n[command-sidecar] spawn error: ${error.message}\n`);
    if (!run.pid) {
      finishRun(1, null);
    }
  });

  child.on('close', (code, signal) => {
    finishRun(code, signal);
  });

  return run;
}

function findRun(id) {
  const run = runs.get(id);
  if (!run) {
    const error = new Error('Run not found');
    error.statusCode = 404;
    throw error;
  }
  return run;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const routePath = stripBasePath(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-headers': 'authorization,content-type,x-command-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-origin': '*'
    });
    res.end();
    return;
  }

  requireAuth(req, url);

  if (req.method === 'GET' && (routePath === '/' || routePath === '/health')) {
    sendJson(res, 200, {
      ok: true,
      service: 'online-cli-command-sidecar',
      platform: process.platform,
      hostname: os.hostname(),
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      basePath: config.basePath,
      allowedRoots: config.allowedRoots,
      defaultCwd: config.defaultCwd,
      activeRuns: Array.from(runs.values()).filter((run) => run.status === 'running').length,
      storedRuns: runs.size
    });
    return;
  }

  if (req.method === 'GET' && routePath === '/runs') {
    sendJson(res, 200, {
      runs: Array.from(runs.values()).reverse().map((run) => publicRun(run, false))
    });
    return;
  }

  if (req.method === 'POST' && routePath === '/runs') {
    const payload = await readJsonBody(req);
    const run = createRun(payload);
    sendJson(res, 202, publicRun(run, false));
    return;
  }

  const runMatch = routePath.match(/^\/runs\/([^/]+)(?:\/(events|stop))?$/);
  if (runMatch) {
    const run = findRun(runMatch[1]);
    const action = runMatch[2] || '';

    if (req.method === 'GET' && !action) {
      sendJson(res, 200, publicRun(run, true));
      return;
    }

    if (req.method === 'POST' && action === 'stop') {
      terminateRun(run, 'manual');
      sendJson(res, 202, publicRun(run, false));
      return;
    }

    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(publicRun(run, false))}\n\n`);
      if (run.stdout) {
        res.write(`event: stdout\ndata: ${JSON.stringify({ text: run.stdout, at: new Date().toISOString(), replay: true })}\n\n`);
      }
      if (run.stderr) {
        res.write(`event: stderr\ndata: ${JSON.stringify({ text: run.stderr, at: new Date().toISOString(), replay: true })}\n\n`);
      }
      if (run.status !== 'running') {
        res.write(`event: exit\ndata: ${JSON.stringify(publicRun(run, false))}\n\n`);
        res.end();
        return;
      }

      run.subscribers.add(res);
      req.on('close', () => run.subscribers.delete(res));
      return;
    }
  }

  const error = new Error('Not found');
  error.statusCode = 404;
  throw error;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendError(res, error);
  });
});

server.listen(config.port, config.host, () => {
  console.info('[command-sidecar] listening', {
    url: `http://${config.host}:${config.port}${config.basePath || ''}`,
    roots: config.allowedRoots
  });
});

function shutdown(signal) {
  console.info(`[command-sidecar] shutting down (${signal})`);
  for (const run of runs.values()) {
    terminateRun(run, 'shutdown');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
