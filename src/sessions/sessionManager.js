const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TerminalSession } = require('./terminalSession');

class SessionManager {
  constructor(options) {
    this.logger = options.logger;
    this.maxSessions = options.maxSessions;
    this.defaultCols = options.defaultCols;
    this.defaultRows = options.defaultRows;
    this.defaultShell = options.defaultShell;
    this.defaultShellArgs = options.defaultShellArgs;
    this.defaultCwd = options.defaultCwd;
    this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs;
    this.sessionSweepIntervalMs = options.sessionSweepIntervalMs;
    this.tmuxCommand = options.tmuxCommand || 'tmux';
    this.tmuxArgs = Array.isArray(options.tmuxArgs) ? options.tmuxArgs : [];
    this.tmuxHistoryLimit = options.tmuxHistoryLimit;
    this.tmuxMouseMode = options.tmuxMouseMode !== false;
    this.singleConsoleMode = options.singleConsoleMode !== false;
    this.sessionStateFile = options.sessionStateFile;

    this.sessions = new Map();
    this.defaultSessionId = null;
    this.cleanupTimer = null;
  }

  start() {
    this._restoreSessionState();
    this.ensureDefaultSession();
    this._persistSessionState('startup');

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions();
    }, this.sessionSweepIntervalMs);
  }

  stop(options = {}) {
    const persistState = options.persistState !== false;
    const preserveTmux = options.preserveTmux !== false;
    const closeClients = options.closeClients !== false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (persistState) {
      this._persistSessionState('shutdown');
    }

    for (const session of this.sessions.values()) {
      if (preserveTmux) {
        session.disconnectClients({
          reason: 'Server shutting down',
          closeSockets: closeClients
        });
      } else {
        session.terminate({ reason: 'Server shutting down', closeClients });
      }
    }

    this.sessions.clear();
  }

  _nextName() {
    return `Session ${this.sessions.size + 1}`;
  }

  createSession(options = {}) {
    const bypassSingleConsole = options.allowSingleConsoleBypass === true;
    if (this.singleConsoleMode && this.sessions.size >= 1 && !bypassSingleConsole) {
      const error = new Error('SINGLE_CONSOLE_MODE is enabled: additional sessions are disabled');
      error.statusCode = 409;
      throw error;
    }

    if (this.sessions.size >= this.maxSessions) {
      const error = new Error(`Max sessions limit reached (${this.maxSessions})`);
      error.statusCode = 409;
      throw error;
    }

    const explicitId = typeof options.id === 'string' ? options.id.trim() : '';
    const id = explicitId || crypto.randomUUID();
    if (this.sessions.has(id)) {
      const error = new Error(`Session id already exists (${id})`);
      error.statusCode = 409;
      throw error;
    }

    const session = new TerminalSession({
      id,
      name: options.name || this._nextName(),
      shell: options.shell || this.defaultShell,
      shellArgs: Array.isArray(options.shellArgs) ? options.shellArgs : this.defaultShellArgs,
      cwd: options.cwd || this.defaultCwd,
      env: process.env,
      defaultCols: options.defaultCols || this.defaultCols,
      defaultRows: options.defaultRows || this.defaultRows,
      cols: options.cols,
      rows: options.rows,
      createdAt: options.createdAt,
      lastActivityAt: options.lastActivityAt,
      tmuxCommand: this.tmuxCommand,
      tmuxArgs: this.tmuxArgs,
      tmuxHistoryLimit: this.tmuxHistoryLimit,
      tmuxMouseMode: this.tmuxMouseMode,
      tmuxSessionName: options.tmuxSessionName,
      logger: this.logger
    });

    this.sessions.set(id, session);

    this.logger.info('Session created', {
      sessionId: id,
      name: session.name,
      total: this.sessions.size
    });

    if (options.skipPersist !== true) {
      this._persistSessionState('create');
    }

    return session;
  }

  ensureDefaultSession() {
    if (this.defaultSessionId) {
      const existing = this.sessions.get(this.defaultSessionId);
      if (existing) {
        return existing;
      }
    }

    const defaultSession = this.createSession({
      name: 'Default Session',
      allowSingleConsoleBypass: true,
      skipPersist: true
    });
    this.defaultSessionId = defaultSession.id;
    this._persistSessionState('default');
    return defaultSession;
  }

  getSession(id) {
    if (!id) {
      return null;
    }
    return this.sessions.get(id) || null;
  }

  listSessions() {
    const sessions = Array.from(this.sessions.values()).map((session) => session.getSnapshot());
    sessions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return sessions;
  }

  deleteSession(id) {
    if (this.singleConsoleMode) {
      const error = new Error('SINGLE_CONSOLE_MODE is enabled: deleting sessions is disabled');
      error.statusCode = 409;
      throw error;
    }

    const session = this.getSession(id);
    if (!session) {
      return false;
    }

    session.terminate({ reason: 'Session removed', closeClients: true });
    this.sessions.delete(id);

    if (this.defaultSessionId === id) {
      this.defaultSessionId = null;
      if (this.sessions.size > 0) {
        this.defaultSessionId = this.sessions.keys().next().value;
      } else {
        this.ensureDefaultSession();
      }
    }

    this.logger.info('Session deleted', {
      sessionId: id,
      total: this.sessions.size
    });

    this._persistSessionState('delete');
    return true;
  }

  restartSession(id) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    session.restart();
    this._persistSessionState('restart');
    return session;
  }

  writeInputToSession(id, input) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    return session.writeInput(input);
  }

  writeCommandToSession(id, command) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    return session.writeCommand(command);
  }

  scrollSessionHistory(id, lines) {
    const session = this.getSession(id);
    if (!session) {
      return null;
    }

    return session.scrollHistory(lines);
  }

  cleanupIdleSessions() {
    const now = Date.now();
    const removedIds = [];

    for (const [id, session] of this.sessions.entries()) {
      const isDefault = id === this.defaultSessionId;
      if (isDefault) {
        continue;
      }

      if (session.isIdle(this.sessionIdleTimeoutMs, now)) {
        session.terminate({ reason: 'Session timed out from inactivity', closeClients: true });
        this.sessions.delete(id);
        removedIds.push(id);
      }
    }

    if (removedIds.length > 0) {
      this.logger.info('Cleaned up idle sessions', {
        count: removedIds.length,
        sessionIds: removedIds
      });
      this._persistSessionState('idle-cleanup');
    }

    if (!this.defaultSessionId || !this.sessions.has(this.defaultSessionId)) {
      this.ensureDefaultSession();
    }
  }

  _serializeSessionsForState() {
    const sessions = Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      name: session.name,
      shell: session.shell,
      shellArgs: Array.isArray(session.shellArgs) ? session.shellArgs : [],
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      tmuxSessionName: session.tmuxSessionName,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt
    }));

    sessions.sort((a, b) => {
      const aCreatedAt = Number.isFinite(Date.parse(a.createdAt)) ? Date.parse(a.createdAt) : 0;
      const bCreatedAt = Number.isFinite(Date.parse(b.createdAt)) ? Date.parse(b.createdAt) : 0;
      return aCreatedAt - bCreatedAt;
    });

    return sessions;
  }

  _persistSessionState(reason) {
    if (!this.sessionStateFile || typeof this.sessionStateFile !== 'string') {
      return;
    }

    try {
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        reason: reason || 'update',
        defaultSessionId: this.defaultSessionId,
        singleConsoleMode: this.singleConsoleMode === true,
        sessions: this._serializeSessionsForState()
      };

      const targetPath = this.sessionStateFile;
      const parentDir = path.dirname(targetPath);
      if (parentDir && parentDir !== '.' && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      this.logger.warn('Failed to persist session state', {
        path: this.sessionStateFile,
        message: error.message
      });
    }
  }

  _restoreSessionState() {
    if (!this.sessionStateFile || typeof this.sessionStateFile !== 'string') {
      return;
    }

    if (!fs.existsSync(this.sessionStateFile)) {
      return;
    }

    let payload = null;
    try {
      const raw = fs.readFileSync(this.sessionStateFile, 'utf8');
      payload = JSON.parse(raw);
    } catch (error) {
      this.logger.warn('Failed to read persisted session state', {
        path: this.sessionStateFile,
        message: error.message
      });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    let restored = 0;
    const seenIds = new Set();

    for (const candidate of sessions) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);

      if (this.singleConsoleMode && restored >= 1) {
        break;
      }

      try {
        const session = this.createSession({
          id,
          name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : undefined,
          shell: typeof candidate.shell === 'string' && candidate.shell.trim() ? candidate.shell : undefined,
          shellArgs: Array.isArray(candidate.shellArgs) ? candidate.shellArgs : undefined,
          cwd: typeof candidate.cwd === 'string' && candidate.cwd.trim() ? candidate.cwd : undefined,
          cols: candidate.cols,
          rows: candidate.rows,
          tmuxSessionName: typeof candidate.tmuxSessionName === 'string' && candidate.tmuxSessionName.trim()
            ? candidate.tmuxSessionName
            : undefined,
          createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : undefined,
          lastActivityAt: typeof candidate.lastActivityAt === 'string' ? candidate.lastActivityAt : undefined,
          allowSingleConsoleBypass: true,
          skipPersist: true
        });
        restored += 1;

        if (!this.defaultSessionId && payload.defaultSessionId === session.id) {
          this.defaultSessionId = session.id;
        }
      } catch (error) {
        this.logger.warn('Failed to restore persisted session', {
          sessionId: id,
          message: error.message
        });
      }
    }

    if (!this.defaultSessionId || !this.sessions.has(this.defaultSessionId)) {
      this.defaultSessionId = this.sessions.size > 0
        ? this.sessions.keys().next().value
        : null;
    }

    if (restored > 0) {
      this.logger.info('Restored persisted sessions', {
        restored,
        defaultSessionId: this.defaultSessionId
      });
    }
  }
}

module.exports = { SessionManager };
