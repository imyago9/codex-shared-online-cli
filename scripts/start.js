const childProcess = require('child_process');
const path = require('path');

const config = require('../src/config');
const { startServer } = require('../src/server');

const projectRoot = path.join(__dirname, '..');
const remoteAgentDir = path.join(projectRoot, 'remote-agent');

function runCommand(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    shell: options.shell === true,
    timeout: options.timeoutMs || 15_000
  });
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function requireSuccessfulCommand(result, label) {
  if (!result.error && result.status === 0) {
    return;
  }

  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`${label} timed out.`);
  }

  const detail = [
    result.error ? result.error.message : '',
    result.stderr || '',
    result.stdout || ''
  ].filter(Boolean).join('\n').trim();
  throw new Error(`${label} failed${detail ? `:\n${detail}` : '.'}`);
}

function runCommandAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputMatched = false;
    let stopAfterOutputTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch (_error) {
        // Ignore kill races.
      }
    }, options.timeoutMs || 45_000);

    function handleOutput(text, source) {
      if (typeof options.onOutput === 'function') {
        options.onOutput(text, source);
      }
      if (
        options.stopOnOutputPattern
        && options.stopOnOutputPattern.test(text)
        && !outputMatched
      ) {
        outputMatched = true;
        stopAfterOutputTimer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch (_error) {
            // Ignore kill races.
          }
        }, options.stopAfterOutputDelayMs || 750);
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      handleOutput(text, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      handleOutput(text, 'stderr');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (stopAfterOutputTimer) {
        clearTimeout(stopAfterOutputTimer);
      }
      resolve({ error, stdout, stderr, timedOut, outputMatched });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (stopAfterOutputTimer) {
        clearTimeout(stopAfterOutputTimer);
      }
      resolve({ code, signal, stdout, stderr, timedOut, outputMatched });
    });
  });
}

function getTailscaleStatus() {
  console.info('[startup] Checking Tailscale status...');
  const result = runCommand('tailscale', ['status', '--json']);
  requireSuccessfulCommand(result, 'tailscale status --json');

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse tailscale status output: ${error.message}`);
  }
}

function normalizeTailnetDnsName(status) {
  const dnsName = status && status.Self && typeof status.Self.DNSName === 'string'
    ? status.Self.DNSName.trim().replace(/\.$/, '')
    : '';
  if (!dnsName) {
    throw new Error('Tailscale status did not include this node DNS name.');
  }
  return dnsName;
}

function getTailscaleIps(status) {
  const self = status && status.Self ? status.Self : {};
  const candidates = [
    ...(Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []),
    ...(Array.isArray(self.Addresses) ? self.Addresses : []),
    typeof self.TailscaleIP === 'string' ? self.TailscaleIP : ''
  ];

  return candidates
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function configureTailscaleServe(port) {
  const status = getTailscaleStatus();
  if (!status || status.BackendState !== 'Running') {
    throw new Error(`Tailscale is not running (BackendState=${status ? status.BackendState : 'unknown'}).`);
  }

  const dnsName = normalizeTailnetDnsName(status);
  const tailscaleIps = getTailscaleIps(status);
  const tailnetUrl = `https://${dnsName}`;
  console.info(`[startup] Tailnet URL: ${tailnetUrl}`);
  if (tailscaleIps.length > 0) {
    console.info(`[startup] Tailscale IP${tailscaleIps.length === 1 ? '' : 's'}: ${tailscaleIps.join(', ')}`);
  } else {
    console.info('[startup] Tailscale IPs: unavailable from tailscale status');
  }

  process.env.TAILSCALE_DNS_NAME = dnsName;
  config.tailnetHost = dnsName.toLowerCase();

  return { dnsName, tailnetUrl, tailscaleIps };
}

async function configureTailscaleServeProxy(port) {
  const target = `127.0.0.1:${port}`;
  const explicitTarget = `http://${target}`;
  console.info(`[startup] Configuring Tailscale Serve for ${explicitTarget}...`);
  const echoServeOutput = (text) => {
    process.stdout.write(text);
  };
  const serveConsentPattern = /Serve is not enabled|login\.tailscale\.com\/f\/serve/i;
  const primary = await runCommandAsync('tailscale', ['serve', '--yes', '--bg', String(port)], {
    timeoutMs: 12_000,
    onOutput: echoServeOutput,
    stopOnOutputPattern: serveConsentPattern
  });

  if (primary.outputMatched) {
    throw new Error('Tailscale Serve is not enabled for this tailnet. Open the Tailscale Serve enable URL above, then rerun npm start.');
  }

  if (primary.code !== 0 || primary.error || primary.timedOut) {
    const fallback = await runCommandAsync('tailscale', ['serve', '--yes', '--bg', explicitTarget], {
      timeoutMs: 12_000,
      onOutput: echoServeOutput,
      stopOnOutputPattern: serveConsentPattern
    });
    if (fallback.outputMatched) {
      throw new Error('Tailscale Serve is not enabled for this tailnet. Open the Tailscale Serve enable URL above, then rerun npm start.');
    }
    if (fallback.code !== 0 || fallback.error || fallback.timedOut) {
      const detail = [
        fallback.timedOut ? 'tailscale serve timed out' : '',
        fallback.error ? fallback.error.message : '',
        fallback.stderr || '',
        fallback.stdout || '',
        primary.timedOut ? 'first attempt timed out' : '',
        primary.error ? primary.error.message : '',
        primary.stderr || '',
        primary.stdout || ''
      ].filter(Boolean).join('\n').trim();
      throw new Error(`tailscale serve failed${detail ? `:\n${detail}` : '.'}\nOpen the Tailscale Serve enable URL above if one was printed, then rerun npm start.`);
    }
  }

  console.info(`[startup] Tailscale Serve configured for ${explicitTarget}`);
}

function remoteAgentDependenciesInstalled() {
  const requiredModules = [
    path.join(remoteAgentDir, 'node_modules', 'express'),
    path.join(remoteAgentDir, 'node_modules', 'screenshot-desktop'),
    path.join(remoteAgentDir, 'node_modules', 'ws')
  ];

  return requiredModules.every((modulePath) => {
    try {
      return require('fs').existsSync(modulePath);
    } catch (_error) {
      return false;
    }
  });
}

function ensureRemoteAgentDependencies() {
  if (remoteAgentDependenciesInstalled()) {
    return;
  }

  console.info('[startup] Installing remote sidecar dependencies...');
  const result = runCommand(getNpmCommand(), ['install'], {
    cwd: remoteAgentDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeoutMs: 120_000
  });
  requireSuccessfulCommand(result, 'remote-agent npm install');
}

function prefixOutput(stream, prefix) {
  if (!stream) {
    return;
  }

  stream.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) {
        console.info(`${prefix} ${line}`);
      }
    }
  });
}

function startRemoteSidecar() {
  ensureRemoteAgentDependencies();

  const child = childProcess.spawn(process.execPath, ['server.js'], {
    cwd: remoteAgentDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  prefixOutput(child.stdout, '[remote]');
  prefixOutput(child.stderr, '[remote]');

  child.on('exit', (code, signal) => {
    if (code === 0 || signal) {
      console.info(`[startup] Remote sidecar stopped${signal ? ` (${signal})` : ''}.`);
      return;
    }
    console.error(`[startup] Remote sidecar exited with code ${code}.`);
  });

  console.info('[startup] Remote sidecar starting because REMOTE_ENABLED=true.');
  return child;
}

function stopChild(child, label) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch (error) {
    console.warn(`[startup] Failed to stop ${label}: ${error.message}`);
  }
}

async function start() {
  configureTailscaleServe(config.port);

  const remoteSidecar = config.remoteEnabled === true
    ? startRemoteSidecar()
    : null;

  let runtime = null;
  runtime = startServer({
    onListening({ port }) {
      configureTailscaleServeProxy(port).catch((error) => {
        console.error(`[startup] ${error.message}`);
        if (runtime && typeof runtime.shutdown === 'function') {
          runtime.shutdown('STARTUP_FAILURE', 1);
        } else {
          process.exit(1);
        }
      });
    },
    beforeShutdown() {
      stopChild(remoteSidecar, 'remote sidecar');
    }
  });
}

module.exports = { start };

if (require.main === module) {
  start().catch((error) => {
    console.error(`[startup] ${error.message}`);
    process.exit(1);
  });
}
