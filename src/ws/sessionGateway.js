const { WebSocketServer, WebSocket } = require('ws');

function getSessionIdFromRequest(req) {
  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url, `http://${host}`);
    return url.searchParams.get('sessionId');
  } catch (error) {
    return null;
  }
}

function createSessionGateway(server, sessionManager, options) {
  const logger = options.logger;
  const heartbeatMs = options.wsHeartbeatMs;
  const authManager = options.authManager;

  const wss = new WebSocketServer({ noServer: true });

  function heartbeat() {
    this.isAlive = true;
  }

  wss.on('connection', (ws, req) => {
    if (authManager && authManager.isEnabled() && !authManager.isAuthenticatedRequest(req)) {
      ws.close(1008, 'Authentication required');
      return;
    }

    const requestedSessionId = getSessionIdFromRequest(req);
    const fallbackSession = sessionManager.ensureDefaultSession();
    const sessionId = sessionManager.singleConsoleMode
      ? fallbackSession.id
      : (requestedSessionId || fallbackSession.id);
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      ws.close(1008, 'Invalid sessionId');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    try {
      session.attachClient(ws);
    } catch (error) {
      logger.error('Failed to attach websocket client to session', {
        sessionId: session.id,
        message: error.message
      });
      ws.close(1011, 'Failed to attach terminal session');
      return;
    }

    ws.on('message', (message) => {
      session.handleClientMessage(ws, message);
    });

    ws.on('close', () => {
      session.detachClient(ws);
    });

    ws.on('error', (error) => {
      logger.warn('WebSocket client error', {
        sessionId: session.id,
        message: error.message
      });
      session.detachClient(ws);
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        __onlineCliControl: true,
        channel: 'control',
        type: 'session-ready',
        sessionId: session.id,
        cols: session.cols,
        rows: session.rows
      }));
    }

    logger.info('WebSocket connected', {
      sessionId: session.id,
      clientCount: session.clients.size
    });
  });

  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);

  function close() {
    clearInterval(pingInterval);
    wss.close();
  }

  function handleUpgrade(req, socket, head) {
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname !== '/ws') {
        return false;
      }
    } catch (_error) {
      return false;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return {
    wss,
    handleUpgrade,
    close
  };
}

module.exports = { createSessionGateway };
