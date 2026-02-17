const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const wsTextDecoder = new TextDecoder();

function isWsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function decodeWsText(rawValue) {
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  if (rawValue instanceof ArrayBuffer || ArrayBuffer.isView(rawValue)) {
    return wsTextDecoder.decode(rawValue);
  }
  return null;
}

function normalizeMode(rawValue, fallback = 'view') {
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (normalized === 'view' || normalized === 'control') {
    return normalized;
  }
  return fallback;
}

function parseQueryValue(req, key) {
  try {
    const host = req.headers.host || 'localhost';
    const parsed = new URL(req.url, `http://${host}`);
    const value = parsed.searchParams.get(key);
    return value && typeof value === 'string' ? value : null;
  } catch (_error) {
    return null;
  }
}

function toBoundedInteger(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function clampNormalized(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
}

function clampDelta(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.trunc(parsed);
  return Math.max(-1200, Math.min(1200, normalized));
}

function sanitizeModifierMap(rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};
  return {
    alt: source.alt === true,
    ctrl: source.ctrl === true,
    meta: source.meta === true,
    shift: source.shift === true
  };
}

function sanitizeInputEvent(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') {
    return null;
  }

  const type = typeof rawValue.type === 'string' ? rawValue.type.trim().toLowerCase() : '';
  if (!type) {
    return null;
  }

  if (type === 'mouse_move') {
    const x = clampNormalized(rawValue.x);
    const y = clampNormalized(rawValue.y);
    if (x === null || y === null) {
      return null;
    }
    return {
      type,
      x,
      y,
      at: Date.now()
    };
  }

  if (type === 'mouse_button') {
    const button = typeof rawValue.button === 'string' ? rawValue.button.trim().toLowerCase() : '';
    const action = typeof rawValue.action === 'string' ? rawValue.action.trim().toLowerCase() : '';
    if (!['left', 'right', 'middle'].includes(button)) {
      return null;
    }
    if (!['down', 'up', 'click'].includes(action)) {
      return null;
    }

    const payload = {
      type,
      button,
      action,
      at: Date.now()
    };

    const x = clampNormalized(rawValue.x);
    const y = clampNormalized(rawValue.y);
    if (x !== null && y !== null) {
      payload.x = x;
      payload.y = y;
    }

    return payload;
  }

  if (type === 'mouse_wheel') {
    const deltaX = clampDelta(rawValue.deltaX, 0);
    const deltaY = clampDelta(rawValue.deltaY, 0);
    if (deltaX === 0 && deltaY === 0) {
      return null;
    }

    const payload = {
      type,
      deltaX,
      deltaY,
      at: Date.now()
    };

    const x = clampNormalized(rawValue.x);
    const y = clampNormalized(rawValue.y);
    if (x !== null && y !== null) {
      payload.x = x;
      payload.y = y;
    }

    return payload;
  }

  if (type === 'key') {
    const action = typeof rawValue.action === 'string' ? rawValue.action.trim().toLowerCase() : 'press';
    if (!['down', 'up', 'press'].includes(action)) {
      return null;
    }

    const key = typeof rawValue.key === 'string' ? rawValue.key.slice(0, 64) : '';
    const code = typeof rawValue.code === 'string' ? rawValue.code.slice(0, 64) : '';
    const text = typeof rawValue.text === 'string' ? rawValue.text.slice(0, 64) : '';

    if (!key && !code && !text) {
      return null;
    }

    return {
      type,
      action,
      key,
      code,
      text,
      modifiers: sanitizeModifierMap(rawValue.modifiers),
      at: Date.now()
    };
  }

  if (type === 'text') {
    const text = typeof rawValue.text === 'string' ? rawValue.text : '';
    if (!text || text.length > 64) {
      return null;
    }

    return {
      type,
      text,
      at: Date.now()
    };
  }

  return null;
}

function controlEnvelope(type, payload = {}) {
  return JSON.stringify({
    __onlineCliControl: true,
    channel: 'remote',
    type,
    ...payload
  });
}

function createRemoteGateway(server, remoteClient, options = {}) {
  const logger = options.logger;
  const authManager = options.authManager;
  const heartbeatMs = toBoundedInteger(options.wsHeartbeatMs, 30_000, 10_000, 120_000);
  const defaults = remoteClient.getDefaults();

  const wss = new WebSocketServer({ noServer: true });

  function heartbeat() {
    this.isAlive = true;
  }

  wss.on('connection', (clientSocket, req) => {
    if (authManager && authManager.isEnabled() && !authManager.isAuthenticatedRequest(req)) {
      clientSocket.close(1008, 'Authentication required');
      return;
    }

    if (!remoteClient.isEnabled()) {
      clientSocket.close(1008, 'Remote capability disabled');
      return;
    }

    const sessionToken = parseQueryValue(req, 'token');
    const token = remoteClient.consumeSessionToken(sessionToken || '');
    if (!token) {
      clientSocket.close(1008, 'Invalid or expired remote token');
      return;
    }

    const remoteConnectionId = crypto.randomUUID();
    const connectionMeta = {
      remoteConnectionId,
      remoteIp: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null
    };

    const context = {
      closed: false,
      streamSocket: null,
      inputSocket: null,
      mode: normalizeMode(token.mode, 'view'),
      controlAllowed: token.controlAllowed === true,
      inputQueue: [],
      inputFlushTimer: null,
      rateWindowStartedAt: Date.now(),
      rateWindowCount: 0,
      droppedEvents: 0,
      lastThrottleNoticeAt: 0,
      lastBackpressureNoticeAt: 0,
      lastInputError: null
    };

    clientSocket.isAlive = true;
    clientSocket.on('pong', heartbeat);

    const inputRateLimitPerSec = defaults.inputRateLimitPerSec;
    const inputQueueMax = defaults.inputMaxQueue;

    function sendControl(type, payload = {}) {
      if (!isWsOpen(clientSocket)) {
        return;
      }

      try {
        clientSocket.send(controlEnvelope(type, payload));
      } catch (_error) {
        // Ignore best-effort control message failures.
      }
    }

    function closeConnection(code, reason) {
      if (!isWsOpen(clientSocket)) {
        return;
      }
      try {
        clientSocket.close(code, reason);
      } catch (_error) {
        // Ignore close races.
      }
    }

    function clearInputFlushTimer() {
      if (context.inputFlushTimer) {
        clearTimeout(context.inputFlushTimer);
        context.inputFlushTimer = null;
      }
    }

    function cleanupSidecarSockets() {
      const sockets = [context.streamSocket, context.inputSocket];
      context.streamSocket = null;
      context.inputSocket = null;

      for (const socket of sockets) {
        if (!socket) {
          continue;
        }

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.close();
          } catch (_error) {
            // Ignore close races.
          }
        }
      }
    }

    function cleanup() {
      if (context.closed) {
        return;
      }
      context.closed = true;

      clearInputFlushTimer();
      context.inputQueue.length = 0;
      cleanupSidecarSockets();

      if (logger) {
        logger.info('Remote websocket disconnected', {
          ...connectionMeta,
          mode: context.mode,
          droppedEvents: context.droppedEvents,
          lastInputError: context.lastInputError
        });
      }
    }

    function applyMode(nextMode, reason) {
      const requested = normalizeMode(nextMode, context.mode);
      const previous = context.mode;
      let effectiveMode = requested;

      if (requested === 'control' && !context.controlAllowed) {
        effectiveMode = 'view';
      }

      context.mode = effectiveMode;
      sendControl('remote-mode', {
        mode: context.mode,
        controlAllowed: context.controlAllowed,
        reason: reason || null
      });

      if (previous !== context.mode && logger) {
        const message = context.mode === 'control'
          ? 'Remote control enabled'
          : 'Remote control disabled';
        logger.info(message, {
          ...connectionMeta,
          previousMode: previous,
          mode: context.mode,
          reason: reason || null
        });
      }

      if (context.mode === 'control') {
        ensureInputSocket();
      }
    }

    function consumeRateBudget() {
      const now = Date.now();
      if ((now - context.rateWindowStartedAt) >= 1000) {
        context.rateWindowStartedAt = now;
        context.rateWindowCount = 0;
      }

      if (context.rateWindowCount >= inputRateLimitPerSec) {
        if ((now - context.lastThrottleNoticeAt) >= 1000) {
          context.lastThrottleNoticeAt = now;
          sendControl('remote-input-throttled', {
            rateLimitPerSec: inputRateLimitPerSec
          });
        }
        return false;
      }

      context.rateWindowCount += 1;
      return true;
    }

    function scheduleInputFlush() {
      if (context.inputFlushTimer || context.closed) {
        return;
      }

      context.inputFlushTimer = setTimeout(() => {
        context.inputFlushTimer = null;
        flushInputQueue();
      }, 8);
    }

    function enqueueInputEvent(event) {
      if (context.inputQueue.length >= inputQueueMax) {
        context.droppedEvents += 1;
        const now = Date.now();
        if ((now - context.lastBackpressureNoticeAt) >= 1_200) {
          context.lastBackpressureNoticeAt = now;
          sendControl('remote-input-backpressure', {
            queueMax: inputQueueMax,
            droppedEvents: context.droppedEvents
          });
        }
        return false;
      }

      context.inputQueue.push(event);
      scheduleInputFlush();
      return true;
    }

    function flushInputQueue() {
      if (context.closed || context.mode !== 'control') {
        context.inputQueue.length = 0;
        return;
      }

      if (!context.inputSocket || context.inputSocket.readyState !== WebSocket.OPEN) {
        ensureInputSocket();
        if (context.inputSocket && context.inputSocket.readyState === WebSocket.CONNECTING) {
          scheduleInputFlush();
          return;
        }
        context.inputQueue.length = 0;
        return;
      }

      while (context.inputQueue.length > 0 && context.inputSocket.readyState === WebSocket.OPEN) {
        const eventPayload = context.inputQueue.shift();
        try {
          context.inputSocket.send(JSON.stringify({
            type: 'input',
            event: eventPayload
          }));
        } catch (error) {
          context.lastInputError = error && error.message ? error.message : 'input-send-failed';
          break;
        }
      }

      if (context.inputQueue.length > 0) {
        scheduleInputFlush();
      }
    }

    function ensureInputSocket() {
      if (!context.controlAllowed || context.closed) {
        return;
      }

      if (context.inputSocket && (context.inputSocket.readyState === WebSocket.OPEN || context.inputSocket.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const inputSocket = remoteClient.openInputSocket();
      context.inputSocket = inputSocket;

      inputSocket.on('open', () => {
        if (context.closed || context.inputSocket !== inputSocket) {
          return;
        }
        sendControl('remote-input-connected');
        scheduleInputFlush();
      });

      inputSocket.on('message', (rawValue, isBinary) => {
        if (context.closed || context.inputSocket !== inputSocket || isBinary) {
          return;
        }

        const rawText = decodeWsText(rawValue);
        if (!rawText) {
          return;
        }

        let payload = null;
        try {
          payload = JSON.parse(rawText);
        } catch (_error) {
          return;
        }

        if (!payload || typeof payload !== 'object') {
          return;
        }

        if (payload.type === 'error' && payload.message) {
          context.lastInputError = String(payload.message);
          sendControl('remote-input-error', {
            message: context.lastInputError
          });
        }
      });

      inputSocket.on('close', (code, reasonBuffer) => {
        if (context.inputSocket !== inputSocket) {
          return;
        }

        context.inputSocket = null;
        const reason = typeof reasonBuffer === 'string'
          ? reasonBuffer
          : (reasonBuffer ? reasonBuffer.toString('utf8') : '');

        sendControl('remote-input-disconnected', {
          code,
          reason: reason || null
        });

        if (!context.closed && context.mode === 'control') {
          applyMode('view', 'input-channel-closed');
        }
      });

      inputSocket.on('error', (error) => {
        if (context.inputSocket !== inputSocket) {
          return;
        }

        context.lastInputError = error && error.message ? error.message : 'input-socket-error';
        if (logger) {
          logger.warn('Remote input websocket error', {
            ...connectionMeta,
            message: context.lastInputError
          });
        }
      });
    }

    function bindStreamSocket() {
      const streamSocket = remoteClient.openStreamSocket({
        fps: token.streamFps,
        quality: token.jpegQuality
      });
      context.streamSocket = streamSocket;

      streamSocket.on('open', () => {
        if (context.closed || context.streamSocket !== streamSocket) {
          return;
        }

        sendControl('remote-stream-connected', {
          fps: token.streamFps,
          jpegQuality: token.jpegQuality
        });
      });

      streamSocket.on('message', (rawValue, isBinary) => {
        if (context.closed || context.streamSocket !== streamSocket || !isWsOpen(clientSocket)) {
          return;
        }

        if (isBinary) {
          try {
            clientSocket.send(rawValue, { binary: true });
          } catch (_error) {
            closeConnection(1011, 'Remote frame forwarding failed');
          }
          return;
        }

        const rawText = decodeWsText(rawValue);
        if (!rawText) {
          return;
        }

        let payload = null;
        try {
          payload = JSON.parse(rawText);
        } catch (_error) {
          return;
        }

        if (!payload || typeof payload !== 'object') {
          return;
        }

        if (payload.type === 'stats') {
          sendControl('remote-stats', {
            fps: Number(payload.fps) || 0,
            frameBytes: Number(payload.frameBytes) || 0,
            captureTs: Number(payload.captureTs) || null,
            captureLatencyMs: Number(payload.captureLatencyMs) || null
          });
          return;
        }

        if (payload.type === 'error') {
          sendControl('remote-stream-error', {
            message: payload.message || 'stream-error'
          });
          return;
        }

        sendControl('remote-stream-message', { payload });
      });

      streamSocket.on('close', (code, reasonBuffer) => {
        if (context.streamSocket !== streamSocket) {
          return;
        }

        context.streamSocket = null;
        const reason = typeof reasonBuffer === 'string'
          ? reasonBuffer
          : (reasonBuffer ? reasonBuffer.toString('utf8') : '');

        sendControl('remote-stream-disconnected', {
          code,
          reason: reason || null
        });

        if (!context.closed) {
          closeConnection(1013, 'Remote sidecar unavailable');
        }
      });

      streamSocket.on('error', (error) => {
        if (context.streamSocket !== streamSocket) {
          return;
        }

        if (logger) {
          logger.warn('Remote stream websocket error', {
            ...connectionMeta,
            message: error && error.message ? error.message : 'stream-socket-error'
          });
        }
      });
    }

    function handleClientMessage(rawValue, isBinary) {
      if (isBinary || context.closed) {
        return;
      }

      const rawText = decodeWsText(rawValue);
      if (!rawText) {
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(rawText);
      } catch (_error) {
        sendControl('remote-input-rejected', {
          reason: 'invalid-json'
        });
        return;
      }

      if (!payload || typeof payload !== 'object') {
        return;
      }

      const rawType = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : '';
      if (!rawType) {
        return;
      }

      if (rawType === 'set-mode' || rawType === 'remote:set-mode') {
        applyMode(payload.mode, 'client-toggle');
        return;
      }

      if (rawType === 'ping' || rawType === 'remote:ping') {
        sendControl('remote-pong', { ts: Date.now() });
        return;
      }

      if (rawType !== 'input' && rawType !== 'remote:input') {
        return;
      }

      if (context.mode !== 'control') {
        return;
      }

      if (!consumeRateBudget()) {
        return;
      }

      const sanitizedEvent = sanitizeInputEvent(payload.event);
      if (!sanitizedEvent) {
        sendControl('remote-input-rejected', {
          reason: 'invalid-event-payload'
        });
        return;
      }

      enqueueInputEvent(sanitizedEvent);
    }

    clientSocket.on('message', (rawValue, isBinary) => {
      handleClientMessage(rawValue, isBinary === true);
    });

    clientSocket.on('close', cleanup);

    clientSocket.on('error', (error) => {
      if (logger) {
        logger.warn('Remote websocket client error', {
          ...connectionMeta,
          message: error && error.message ? error.message : 'client-socket-error'
        });
      }
      cleanup();
    });

    bindStreamSocket();

    if (isWsOpen(clientSocket)) {
      sendControl('remote-ready', {
        mode: context.mode,
        controlAllowed: context.controlAllowed,
        inputRateLimitPerSec,
        inputQueueMax,
        tokenExpiresAt: token.expiresAt
      });
    }

    if (logger) {
      logger.info('Remote websocket connected', {
        ...connectionMeta,
        requestedMode: token.requestedMode,
        mode: context.mode,
        controlAllowed: context.controlAllowed
      });
    }

    applyMode(token.mode, 'token-default');
  });

  const pingInterval = setInterval(() => {
    for (const clientSocket of wss.clients) {
      if (clientSocket.isAlive === false) {
        clientSocket.terminate();
        continue;
      }

      clientSocket.isAlive = false;
      clientSocket.ping();
    }
  }, heartbeatMs);

  function close() {
    clearInterval(pingInterval);
    for (const clientSocket of wss.clients) {
      try {
        clientSocket.close(1001, 'Server shutting down');
      } catch (_error) {
        // Ignore close races.
      }
    }
    wss.close();
  }

  function handleUpgrade(req, socket, head) {
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname !== '/ws/remote') {
        return false;
      }
    } catch (_error) {
      return false;
    }

    wss.handleUpgrade(req, socket, head, (clientSocket) => {
      wss.emit('connection', clientSocket, req);
    });
    return true;
  }

  return {
    wss,
    handleUpgrade,
    close
  };
}

module.exports = { createRemoteGateway };
