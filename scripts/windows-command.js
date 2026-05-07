#!/usr/bin/env node

const { TextDecoder } = require('util');

function printHelpAndExit(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  node scripts/windows-command.js [options] -- <command> [args...]
  node scripts/windows-command.js --powershell [options] '<powershell command>'

Options:
  --url <url>          Command sidecar URL. Env: WINDOWS_COMMAND_URL
  --token <token>      Command sidecar token. Env: WINDOWS_COMMAND_TOKEN
  --cwd <path>         Windows working directory for the command.
  --timeout-ms <ms>    Server-side timeout.
  --label <label>      Optional run label.
  --powershell         Run the remaining text through powershell.exe -Command.
  --cmd                Run the remaining text through cmd.exe /c.
  --json               Print final run JSON after streaming output.
  -h, --help           Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    url: process.env.WINDOWS_COMMAND_URL || process.env.COMMAND_SIDECAR_URL || '',
    token: process.env.WINDOWS_COMMAND_TOKEN || process.env.COMMAND_SIDECAR_TOKEN || '',
    cwd: '',
    timeoutMs: null,
    label: '',
    shell: 'none',
    json: false,
    commandParts: []
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      options.commandParts = argv.slice(index + 1);
      return options;
    }
    if (arg === '-h' || arg === '--help') {
      printHelpAndExit(0);
    }
    if (arg === '--url') {
      options.url = argv[++index] || '';
    } else if (arg === '--token') {
      options.token = argv[++index] || '';
    } else if (arg === '--cwd') {
      options.cwd = argv[++index] || '';
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[++index] || '', 10);
    } else if (arg === '--label') {
      options.label = argv[++index] || '';
    } else if (arg === '--powershell') {
      options.shell = 'powershell';
    } else if (arg === '--cmd') {
      options.shell = 'cmd';
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.commandParts = argv.slice(index);
      return options;
    }
    index += 1;
  }

  return options;
}

function joinUrl(baseUrl, pathname) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildPayload(options) {
  if (!options.commandParts.length) {
    printHelpAndExit(1);
  }

  const payload = {
    cwd: options.cwd || undefined,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : undefined,
    label: options.label || undefined
  };

  if (options.shell === 'powershell' || options.shell === 'cmd') {
    payload.shell = options.shell;
    payload.command = options.commandParts.join(' ');
  } else {
    payload.command = options.commandParts[0];
    payload.args = options.commandParts.slice(1);
  }

  return payload;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

function parseEventBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const dataText = dataLines.join('\n');
  let data = null;
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch (_error) {
      data = dataText;
    }
  }

  return { event, data };
}

async function streamEvents(url, token) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`event stream failed: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = '';
  let finalRun = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });

    let separatorIndex = pending.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const block = pending.slice(0, separatorIndex);
      pending = pending.slice(separatorIndex + 2);
      const { event, data } = parseEventBlock(block);

      if (event === 'stdout' && data && typeof data.text === 'string') {
        process.stdout.write(data.text);
      } else if (event === 'stderr' && data && typeof data.text === 'string') {
        process.stderr.write(data.text);
      } else if (event === 'exit') {
        finalRun = data;
        return finalRun;
      }

      separatorIndex = pending.indexOf('\n\n');
    }
  }

  return finalRun;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url) {
    throw new Error('Missing --url or WINDOWS_COMMAND_URL');
  }
  if (!options.token) {
    throw new Error('Missing --token or WINDOWS_COMMAND_TOKEN');
  }

  const payload = buildPayload(options);
  const run = await requestJson(joinUrl(options.url, '/runs'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  process.stderr.write(`[windows-command] started ${run.id}${run.pid ? ` pid=${run.pid}` : ''}\n`);
  const finalRun = await streamEvents(joinUrl(options.url, `/runs/${run.id}/events`), options.token);
  const resolvedFinalRun = finalRun || await requestJson(joinUrl(options.url, `/runs/${run.id}`), {
    headers: {
      authorization: `Bearer ${options.token}`
    }
  });

  if (options.json) {
    process.stdout.write(`\n${JSON.stringify(resolvedFinalRun, null, 2)}\n`);
  }

  if (resolvedFinalRun && resolvedFinalRun.exitCode != null) {
    process.exit(Math.max(0, Math.min(255, resolvedFinalRun.exitCode)));
  }
}

main().catch((error) => {
  process.stderr.write(`[windows-command] ${error.message}\n`);
  process.exit(1);
});
