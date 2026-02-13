const childProcess = require('child_process');
const pty = require('@lydell/node-pty');
const { WebSocket } = require('ws');

function coercePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 2) return fallback;
  return parsed;
}

function isWsOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function isWsActive(ws) {
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function quoteCommandArg(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

class TerminalSession {
  constructor(options) {
    this.id = options.id;
    this.name = options.name;
    this.shell = options.shell;
    this.shellArgs = options.shellArgs;
    this.cwd = options.cwd;
    this.env = options.env;
    this.defaultCols = options.defaultCols;
    this.defaultRows = options.defaultRows;
    this.cols = coercePositiveInt(options.cols, this.defaultCols);
    this.rows = coercePositiveInt(options.rows, this.defaultRows);
    this.logger = options.logger;
    this.tmuxCommand = options.tmuxCommand || 'tmux';
    this.tmuxArgs = Array.isArray(options.tmuxArgs) ? options.tmuxArgs.slice() : [];
    if (this.tmuxArgs.length === 0 && process.platform === 'win32' && this.tmuxCommand.toLowerCase() === 'wsl.exe') {
      this.tmuxArgs = ['-e', 'tmux'];
    }
    this.tmuxHistoryLimit = Math.max(Number.parseInt(options.tmuxHistoryLimit, 10) || 200_000, 2_000);
    this.tmuxMouseMode = options.tmuxMouseMode !== false;
    this.tmuxSessionName = options.tmuxSessionName || `online_cli_${String(this.id).replace(/[^a-zA-Z0-9]/g, '')}`;
    this.tmuxCwd = this._resolveTmuxCwd(this.cwd);

    this.clients = new Map();
    this.serverCopyModeActive = false;
    this.isTerminating = false;
    const nowIso = new Date().toISOString();
    this.createdAt = typeof options.createdAt === 'string' && options.createdAt.trim()
      ? options.createdAt
      : nowIso;
    this.updatedAt = this.createdAt;
    this.lastActivityAt = typeof options.lastActivityAt === 'string' && options.lastActivityAt.trim()
      ? options.lastActivityAt
      : this.createdAt;
    this.lastExitAt = null;
    this.exitCode = null;
    this.status = 'starting';

    this._ensureTmuxSession();
    this.status = 'running';
  }

  _touch() {
    const now = new Date().toISOString();
    this.updatedAt = now;
    this.lastActivityAt = now;
  }

  _resolveTmuxCwd(cwd) {
    if (typeof cwd !== 'string') {
      return null;
    }

    const trimmed = cwd.trim();
    if (!trimmed) {
      return null;
    }

    if (!this._usesWslTmux()) {
      return trimmed;
    }

    if (trimmed.startsWith('/')) {
      return trimmed;
    }

    const drivePath = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (drivePath) {
      const drive = drivePath[1].toLowerCase();
      const rest = drivePath[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }

    const uncPath = trimmed.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.+)$/i);
    if (uncPath && uncPath[1]) {
      return `/${uncPath[1].replace(/\\/g, '/')}`;
    }

    return trimmed;
  }

  _usesWslTmux() {
    if (process.platform !== 'win32') {
      return false;
    }

    const cmd = String(this.tmuxCommand || '').toLowerCase();
    if (!cmd.endsWith('wsl.exe')) {
      return false;
    }

    return this.tmuxArgs.some((arg) => String(arg).toLowerCase() === 'tmux');
  }

  _runTmux(args) {
    return childProcess.spawnSync(this.tmuxCommand, [...this.tmuxArgs, ...args], {
      cwd: this.cwd,
      env: this.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  _assertTmux(result, context) {
    if (result.error) {
      if (result.error.code === 'ENOENT') {
        throw new Error(
          `${context} failed: command not found (${this.tmuxCommand}). Install tmux and/or set TMUX_COMMAND/TMUX_ARGS.`
        );
      }
      throw new Error(`${context} failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim() || `exit code ${result.status}`;
      throw new Error(`${context} failed: ${detail}`);
    }
  }

  _createTmuxSession() {
    const createArgs = [
      'new-session',
      '-d',
      '-s',
      this.tmuxSessionName,
      '-x',
      String(this.cols),
      '-y',
      String(this.rows)
    ];
    if (this.tmuxCwd) {
      createArgs.push('-c', this.tmuxCwd);
    }
    const create = this._runTmux(createArgs);
    this._assertTmux(create, `tmux create session ${this.tmuxSessionName}`);
  }

  _applyTmuxOptions() {
    const optionOperations = [
      {
        command: [
          'set-window-option',
          '-g',
          '-t',
          this.tmuxSessionName,
          'history-limit',
          String(this.tmuxHistoryLimit)
        ],
        option: 'history-limit',
        value: String(this.tmuxHistoryLimit)
      },
      {
        command: [
          'set-option',
          '-t',
          this.tmuxSessionName,
          'mouse',
          this.tmuxMouseMode ? 'on' : 'off'
        ],
        option: 'mouse',
        value: this.tmuxMouseMode ? 'on' : 'off'
      }
    ];

    for (const operation of optionOperations) {
      const result = this._runTmux(operation.command);
      if (result.error || result.status !== 0) {
        this.logger.warn('Failed to apply tmux option', {
          sessionId: this.id,
          tmuxSession: this.tmuxSessionName,
          option: operation.option,
          value: operation.value,
          message: result.error ? result.error.message : String(result.stderr || result.stdout || '').trim()
        });
      }
    }
  }

  _ensureTmuxSession() {
    const check = this._runTmux(['has-session', '-t', this.tmuxSessionName]);
    if (check.status === 0) {
      this._applyTmuxOptions();
      return;
    }

    this._createTmuxSession();
    this._applyTmuxOptions();

    this.logger.info('tmux session ready', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName
    });
  }

  _killTmuxSession() {
    const result = this._runTmux(['kill-session', '-t', this.tmuxSessionName]);
    if (result.error) {
      this.logger.warn('Failed to kill tmux session', {
        sessionId: this.id,
        tmuxSession: this.tmuxSessionName,
        message: result.error.message
      });
      return;
    }

    if (result.status === 0) {
      return;
    }

    const detail = String(result.stderr || result.stdout || '').toLowerCase();
    if (detail.includes('no session')) {
      return;
    }

    this.logger.warn('tmux kill-session returned non-zero', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName,
      status: result.status,
      detail: String(result.stderr || result.stdout || '').trim()
    });
  }

  _spawnClientPty(cols, rows) {
    return pty.spawn(this.tmuxCommand, [...this.tmuxArgs, 'attach-session', '-t', this.tmuxSessionName], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.cwd,
      env: {
        ...this.env,
        TERM: 'xterm-256color'
      }
    });
  }

  _ensureServerCopyMode() {
    if (this.serverCopyModeActive) {
      return true;
    }

    const enable = this._runTmux(['copy-mode', '-t', this.tmuxSessionName]);
    if (enable.error || enable.status !== 0) {
      this.logger.warn('Failed to enter tmux copy-mode for history scroll', {
        sessionId: this.id,
        tmuxSession: this.tmuxSessionName,
        message: enable.error ? enable.error.message : String(enable.stderr || enable.stdout || '').trim()
      });
      return false;
    }

    this.serverCopyModeActive = true;
    return true;
  }

  _cancelServerCopyMode() {
    if (!this.serverCopyModeActive) {
      return true;
    }

    const cancel = this._runTmux(['send-keys', '-t', this.tmuxSessionName, '-X', 'cancel']);
    if (cancel.error || cancel.status !== 0) {
      const detail = String(cancel.stderr || cancel.stdout || '').toLowerCase();
      if (!detail.includes('not in copy mode')) {
        this.logger.warn('Failed to exit tmux copy-mode', {
          sessionId: this.id,
          tmuxSession: this.tmuxSessionName,
          message: cancel.error ? cancel.error.message : String(cancel.stderr || cancel.stdout || '').trim()
        });
      }
    }

    this.serverCopyModeActive = false;
    return true;
  }

  scrollHistory(lines) {
    const parsed = Number.parseInt(lines, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      return false;
    }

    this._ensureTmuxSession();

    const count = Math.min(400, Math.max(1, Math.abs(parsed)));
    if (parsed < 0) {
      if (!this._ensureServerCopyMode()) {
        return false;
      }
    } else if (!this.serverCopyModeActive) {
      // Already at live pane flow; nothing to scroll downward.
      return false;
    }

    const action = parsed < 0 ? 'scroll-up' : 'scroll-down';
    const result = this._runTmux([
      'send-keys',
      '-t',
      this.tmuxSessionName,
      '-X',
      '-N',
      String(count),
      action
    ]);

    if (result.error || result.status !== 0) {
      this.logger.warn('Failed to scroll tmux history', {
        sessionId: this.id,
        tmuxSession: this.tmuxSessionName,
        lines: parsed,
        message: result.error ? result.error.message : String(result.stderr || result.stdout || '').trim()
      });
      return false;
    }

    this._touch();
    return true;
  }

  _killClientPty(client) {
    if (!client || !client.pty) {
      return;
    }

    const attachedPty = client.pty;
    client.pty = null;
    try {
      attachedPty.kill();
    } catch (error) {
      this.logger.warn('Failed to terminate attached tmux client PTY', {
        sessionId: this.id,
        message: error.message
      });
    }
  }

  _createAttachedClient(ws, cols, rows) {
    const normalizedCols = coercePositiveInt(cols, this.cols);
    const normalizedRows = coercePositiveInt(rows, this.rows);
    const clientPty = this._spawnClientPty(normalizedCols, normalizedRows);
    const client = {
      cols: normalizedCols,
      rows: normalizedRows,
      pty: clientPty
    };

    this.clients.set(ws, client);

    clientPty.onData((data) => {
      const active = this.clients.get(ws);
      if (!active || active !== client || client.pty !== clientPty) {
        return;
      }

      if (!isWsOpen(ws)) {
        this.detachClient(ws);
        return;
      }

      ws.send(data);
      this._touch();
    });

    clientPty.onExit((event) => {
      const active = this.clients.get(ws);
      if (!active || active !== client || client.pty !== clientPty) {
        return;
      }

      this.clients.delete(ws);
      client.pty = null;
      this.lastExitAt = new Date().toISOString();
      this.exitCode = event.exitCode;
      this._touch();

      this.logger.info('Attached tmux client PTY exited', {
        sessionId: this.id,
        tmuxSession: this.tmuxSessionName,
        clientCount: this.clients.size,
        exitCode: event.exitCode
      });

      if (isWsActive(ws)) {
        ws.close(1012, 'Terminal stream ended');
      }
    });

    this.cols = normalizedCols;
    this.rows = normalizedRows;
    this.status = 'running';
    this._touch();
    return client;
  }

  _buildLocalAttachCommand() {
    const spec = this.getLocalAttachSpec();
    return [spec.command, ...spec.args].map((part) => quoteCommandArg(part)).join(' ');
  }

  getLocalAttachSpec() {
    return {
      command: this.tmuxCommand,
      args: [
        ...this.tmuxArgs,
        'attach-session',
        '-t',
        this.tmuxSessionName
      ],
      cwd: this.cwd,
      displayCommand: [this.tmuxCommand, ...this.tmuxArgs, 'attach-session', '-t', this.tmuxSessionName]
        .map((part) => quoteCommandArg(part))
        .join(' ')
    };
  }

  attachClient(ws) {
    this._ensureTmuxSession();

    if (this.clients.has(ws)) {
      this.detachClient(ws);
    }

    this._createAttachedClient(ws, this.cols, this.rows);

    this.logger.info('Client attached to tmux session', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName,
      clientCount: this.clients.size
    });
  }

  detachClient(ws) {
    const client = this.clients.get(ws);
    if (!client) return;

    this.clients.delete(ws);
    this._killClientPty(client);
    this._touch();

    this.logger.info('Client detached from tmux session', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName,
      clientCount: this.clients.size
    });
  }

  handleClientMessage(ws, rawMessage) {
    this._touch();

    let payload;
    const text = rawMessage.toString();

    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = null;
    }

    if (payload && payload.type === 'resize') {
      const client = this.clients.get(ws);
      if (!client) return;

      const cols = coercePositiveInt(payload.cols, client.cols);
      const rows = coercePositiveInt(payload.rows, client.rows);
      client.cols = cols;
      client.rows = rows;

      if (client.pty) {
        try {
          client.pty.resize(cols, rows);
        } catch (error) {
          this.logger.warn('Failed to resize attached tmux client PTY', {
            sessionId: this.id,
            cols,
            rows,
            message: error.message
          });
        }
      }

      this.cols = cols;
      this.rows = rows;
      return;
    }

    if (payload && payload.type === 'input' && typeof payload.data === 'string') {
      this.writeInput(payload.data, ws);
      return;
    }

    if (typeof text === 'string' && text.length > 0) {
      this.writeInput(text, ws);
    }
  }

  writeInput(data, ws = null) {
    if (typeof data !== 'string' || data.length === 0) {
      return false;
    }

    const targetClient = ws ? this.clients.get(ws) : this.clients.values().next().value;
    if (!targetClient || !targetClient.pty) {
      return false;
    }

    this._cancelServerCopyMode();

    try {
      targetClient.pty.write(data);
      this._touch();
      return true;
    } catch (error) {
      this.logger.warn('Failed to write input to attached tmux client PTY', {
        sessionId: this.id,
        message: error.message
      });
      return false;
    }
  }

  writeCommand(command) {
    if (typeof command !== 'string' || command.length === 0) {
      return false;
    }

    this._ensureTmuxSession();
    this._cancelServerCopyMode();
    const result = this._runTmux(['send-keys', '-t', this.tmuxSessionName, command, 'C-m']);

    if (result.error || result.status !== 0) {
      this.logger.warn('Failed to send command to tmux session', {
        sessionId: this.id,
        tmuxSession: this.tmuxSessionName,
        message: result.error ? result.error.message : String(result.stderr || result.stdout || '').trim()
      });
      return false;
    }

    this._touch();
    return true;
  }

  restart() {
    const activeClients = Array.from(this.clients.entries());
    this.clients.clear();

    for (const [ws, client] of activeClients) {
      this._killClientPty(client);
      if (isWsActive(ws)) {
        ws.close(1012, 'Session restarted');
      }
    }

    this._killTmuxSession();
    this._createTmuxSession();
    this._applyTmuxOptions();
    this.serverCopyModeActive = false;

    this.status = 'running';
    this.exitCode = null;
    this.lastExitAt = null;
    this._touch();
  }

  terminate(options = {}) {
    const reason = options.reason || '[Session terminated]';
    const closeClients = options.closeClients !== false;
    this.isTerminating = true;

    const activeClients = Array.from(this.clients.entries());
    this.clients.clear();

    for (const [ws, client] of activeClients) {
      this._killClientPty(client);

      if (closeClients) {
        if (isWsActive(ws)) {
          ws.close(1012, reason);
        }
      } else if (isWsOpen(ws)) {
        ws.send(`\r\n${reason}\r\n`);
      }
    }

    this._killTmuxSession();
    this.serverCopyModeActive = false;

    this.status = 'terminated';
    this.lastExitAt = new Date().toISOString();
    this._touch();

    this.logger.info('tmux-backed session terminated', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName,
      closeClients
    });
  }

  disconnectClients(options = {}) {
    const reason = options.reason || '[Session detached]';
    const closeSockets = options.closeSockets !== false;

    const activeClients = Array.from(this.clients.entries());
    this.clients.clear();

    for (const [ws, client] of activeClients) {
      this._killClientPty(client);

      if (closeSockets) {
        if (isWsActive(ws)) {
          ws.close(1012, reason);
        }
      } else if (isWsOpen(ws)) {
        ws.send(`\r\n${reason}\r\n`);
      }
    }

    this.serverCopyModeActive = false;
    this._touch();

    this.logger.info('tmux-backed session detached from web clients', {
      sessionId: this.id,
      tmuxSession: this.tmuxSessionName,
      remainingClients: this.clients.size
    });
  }

  isIdle(idleTimeoutMs, now = Date.now()) {
    if (this.clients.size > 0) {
      return false;
    }

    const last = new Date(this.lastActivityAt).getTime();
    return Number.isFinite(last) && (now - last >= idleTimeoutMs);
  }

  getSnapshot() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastActivityAt: this.lastActivityAt,
      lastExitAt: this.lastExitAt,
      exitCode: this.exitCode,
      clientCount: this.clients.size,
      shell: this.shell,
      shellArgs: this.shellArgs,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      tmuxSession: this.tmuxSessionName,
      replayBytes: 0,
      localAttachCommand: this._buildLocalAttachCommand()
    };
  }
}

module.exports = { TerminalSession };
