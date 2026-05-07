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

class TerminalSession {
  constructor(options) {
    this.id = options.id;
    this.name = options.name;
    this.terminalProfile = 'powershell';
    this.backend = 'direct';
    this.shell = options.shell;
    this.shellArgs = Array.isArray(options.shellArgs) ? options.shellArgs : [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.defaultCols = options.defaultCols;
    this.defaultRows = options.defaultRows;
    this.cols = coercePositiveInt(options.cols, this.defaultCols);
    this.rows = coercePositiveInt(options.rows, this.defaultRows);
    this.logger = options.logger;

    this.clients = new Map();
    this.directPty = null;
    this.ptyGeneration = 0;
    this.replayChunks = [];
    this.replayBytes = 0;
    this.maxReplayBytes = Math.max(Number.parseInt(options.maxReplayBytes, 10) || 768_000, 64_000);
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

    this._spawnPersistentPty();
    this.status = 'running';
  }

  _touch() {
    const now = new Date().toISOString();
    this.updatedAt = now;
    this.lastActivityAt = now;
  }

  _spawnPersistentPty() {
    if (this.directPty) {
      return;
    }

    this.ptyGeneration += 1;
    const ptyGeneration = this.ptyGeneration;
    const directPty = pty.spawn(this.shell, this.shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...this.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });
    this.directPty = directPty;

    directPty.onData((data) => {
      if (this.directPty !== directPty || this.ptyGeneration !== ptyGeneration) {
        return;
      }
      this._appendReplay(data);
      this._broadcast(data);
      this._touch();
    });

    directPty.onExit((event) => {
      if (this.directPty !== directPty || this.ptyGeneration !== ptyGeneration) {
        return;
      }

      this.directPty = null;
      this.lastExitAt = new Date().toISOString();
      this.exitCode = event.exitCode;
      this.status = this.isTerminating ? 'terminated' : 'exited';
      this._touch();

      const message = `\r\n[${this.name} exited with code ${event.exitCode}]\r\n`;
      this._appendReplay(message);
      this._broadcast(message);

      this.logger.info('PowerShell terminal PTY exited', {
        sessionId: this.id,
        exitCode: event.exitCode
      });
    });

    this.logger.info('PowerShell terminal PTY ready', {
      sessionId: this.id,
      shell: this.shell,
      cwd: this.cwd
    });
  }

  _appendReplay(data) {
    const text = String(data || '');
    if (!text) {
      return;
    }

    this.replayChunks.push(text);
    this.replayBytes += Buffer.byteLength(text, 'utf8');
    while (this.replayBytes > this.maxReplayBytes && this.replayChunks.length > 1) {
      const removed = this.replayChunks.shift();
      this.replayBytes -= Buffer.byteLength(removed, 'utf8');
    }
  }

  _broadcast(data) {
    for (const ws of this.clients.keys()) {
      if (isWsOpen(ws)) {
        ws.send(data);
      }
    }
  }

  _resizePty(cols, rows) {
    this.cols = coercePositiveInt(cols, this.cols);
    this.rows = coercePositiveInt(rows, this.rows);
    if (!this.directPty) {
      return;
    }

    try {
      this.directPty.resize(this.cols, this.rows);
    } catch (error) {
      this.logger.warn('Failed to resize PowerShell terminal PTY', {
        sessionId: this.id,
        cols: this.cols,
        rows: this.rows,
        message: error.message
      });
    }
  }

  attachClient(ws) {
    if (this.clients.has(ws)) {
      this.detachClient(ws);
    }

    const client = {
      cols: this.cols,
      rows: this.rows
    };
    this.clients.set(ws, client);

    if (!this.directPty && this.status !== 'terminated') {
      this._spawnPersistentPty();
    }

    const replay = this.replayChunks.join('');
    if (replay && isWsOpen(ws)) {
      ws.send(replay);
    }

    this.logger.info('Client attached to PowerShell terminal session', {
      sessionId: this.id,
      clientCount: this.clients.size
    });
  }

  detachClient(ws) {
    const client = this.clients.get(ws);
    if (!client) return;

    this.clients.delete(ws);
    this._touch();

    this.logger.info('Client detached from PowerShell terminal session', {
      sessionId: this.id,
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
      this._resizePty(cols, rows);
      return;
    }

    if (payload && payload.type === 'input' && typeof payload.data === 'string') {
      this.writeInput(payload.data);
      return;
    }

    if (typeof text === 'string' && text.length > 0) {
      this.writeInput(text);
    }
  }

  writeInput(data) {
    if (typeof data !== 'string' || data.length === 0) {
      return false;
    }

    if (!this.directPty || this.status === 'exited' || this.status === 'terminated') {
      return false;
    }

    try {
      this.directPty.write(data);
      this._touch();
      return true;
    } catch (error) {
      this.logger.warn('Failed to write input to PowerShell terminal PTY', {
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

    return this.writeInput(`${command}\r`);
  }

  scrollHistory() {
    return false;
  }

  restart() {
    const activeClients = Array.from(this.clients.keys());
    this.clients.clear();

    for (const ws of activeClients) {
      if (isWsActive(ws)) {
        ws.close(1012, 'Session restarted');
      }
    }

    const existingPty = this.directPty;
    this.directPty = null;
    if (existingPty) {
      try {
        existingPty.kill();
      } catch (error) {
        this.logger.warn('Failed to terminate PowerShell terminal PTY during restart', {
          sessionId: this.id,
          message: error.message
        });
      }
    }

    this.replayChunks = [];
    this.replayBytes = 0;
    this.status = 'starting';
    this.exitCode = null;
    this.lastExitAt = null;
    this.isTerminating = false;
    this._spawnPersistentPty();
    this.status = 'running';
    this._touch();
  }

  terminate(options = {}) {
    const reason = options.reason || '[Session terminated]';
    const closeClients = options.closeClients !== false;
    this.isTerminating = true;

    const activeClients = Array.from(this.clients.keys());
    this.clients.clear();

    for (const ws of activeClients) {
      if (closeClients) {
        if (isWsActive(ws)) {
          ws.close(1012, reason);
        }
      } else if (isWsOpen(ws)) {
        ws.send(`\r\n${reason}\r\n`);
      }
    }

    const existingPty = this.directPty;
    this.directPty = null;
    if (existingPty) {
      try {
        existingPty.kill();
      } catch (error) {
        this.logger.warn('Failed to terminate PowerShell terminal PTY', {
          sessionId: this.id,
          message: error.message
        });
      }
    }

    this.status = 'terminated';
    this.lastExitAt = new Date().toISOString();
    this._touch();

    this.logger.info('PowerShell terminal session terminated', {
      sessionId: this.id,
      closeClients
    });
  }

  disconnectClients(options = {}) {
    const reason = options.reason || '[Session detached]';
    const closeSockets = options.closeSockets !== false;

    const activeClients = Array.from(this.clients.keys());
    this.clients.clear();

    for (const ws of activeClients) {
      if (closeSockets) {
        if (isWsActive(ws)) {
          ws.close(1012, reason);
        }
      } else if (isWsOpen(ws)) {
        ws.send(`\r\n${reason}\r\n`);
      }
    }

    this._touch();

    this.logger.info('PowerShell terminal session detached from clients', {
      sessionId: this.id,
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
      terminalProfile: this.terminalProfile,
      shellType: this.terminalProfile,
      backend: this.backend,
      shell: this.shell,
      shellArgs: this.shellArgs,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      replayBytes: this.replayBytes
    };
  }
}

module.exports = { TerminalSession };
