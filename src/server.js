const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
const { createLogger } = require('./logger');
const { SessionManager } = require('./sessions/sessionManager');
const { createAuthManager } = require('./auth/authManager');
const { createAuthRoutes } = require('./http/authRoutes');
const { createSessionRoutes } = require('./http/sessionRoutes');
const { createSessionGateway } = require('./ws/sessionGateway');
const { CodexSessionIndex } = require('./codex/codexSessionIndex');

function startServer() {
  const logger = createLogger(config.logLevel);
  const publicDir = path.join(__dirname, '..', 'public');

  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: '128kb' }));

  const authManager = createAuthManager({
    enabled: config.authEnabled,
    password: config.authPassword,
    cookieName: config.authCookieName,
    sessionTtlMs: config.authSessionTtlMs,
    cookieSecure: config.authCookieSecure,
    logger
  });
  authManager.logAuthEnabled();

  app.use('/assets', express.static(publicDir));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', 'xterm', 'lib')));
  app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, '..', 'node_modules', 'xterm-addon-fit', 'lib')));
  app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', 'xterm', 'css')));
  app.use('/api/auth', createAuthRoutes(authManager));

  app.get('/login', (req, res) => {
    if (!authManager.isEnabled()) {
      return res.redirect('/');
    }
    if (authManager.isAuthenticatedRequest(req)) {
      return res.redirect('/');
    }
    return res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.get('/', authManager.requirePageAuth(), (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const sessionManager = new SessionManager({
    logger,
    maxSessions: config.maxSessions,
    defaultCols: config.defaultCols,
    defaultRows: config.defaultRows,
    defaultShell: config.defaultShell,
    defaultShellArgs: config.defaultShellArgs,
    defaultCwd: config.defaultCwd,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    sessionSweepIntervalMs: config.sessionSweepIntervalMs,
    tmuxCommand: config.tmuxCommand,
    tmuxArgs: config.tmuxArgs,
    tmuxHistoryLimit: config.tmuxHistoryLimit,
    tmuxMouseMode: config.tmuxMouseMode,
    singleConsoleMode: config.singleConsoleMode,
    sessionStateFile: config.sessionStateFile
  });

  sessionManager.start();
  const codexSessionIndex = new CodexSessionIndex({
    logger,
    defaultShell: config.defaultShell
  });

  app.use('/api', authManager.requireApiAuth());
  app.use('/api', createSessionRoutes(sessionManager, codexSessionIndex));

  app.use((error, _req, res, _next) => {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    const message = statusCode >= 500 ? 'Internal server error' : (error.message || 'Request failed');

    logger.error('Request failed', {
      statusCode,
      message: error.message
    });

    res.status(statusCode).json({ error: message });
  });

  const server = http.createServer(app);
  const sessionGateway = createSessionGateway(server, sessionManager, {
    logger,
    wsHeartbeatMs: config.wsHeartbeatMs,
    authManager
  });

  server.listen(config.port, config.host, () => {
    logger.info('WSL terminal server listening', {
      url: `http://${config.host}:${config.port}`,
      defaultSessionId: sessionManager.defaultSessionId
    });
  });

  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down server', { signal });

    sessionGateway.close();
    authManager.close();
    sessionManager.stop({
      persistState: true,
      preserveTmux: true,
      closeClients: true
    });

    server.close(() => {
      logger.info('Server stopped');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    app,
    server,
    sessionManager,
    shutdown
  };
}

module.exports = { startServer };
