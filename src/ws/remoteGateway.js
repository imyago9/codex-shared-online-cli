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

function sanitizeMonitorIds(rawValue) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || '').split(',');
  const seen = new Set();
  const ids = [];

  for (const entry of source) {
    const id = String(entry || '').trim();
    if (!id || id.toLowerCase() === 'all' || seen.has(id) || id.length > 120) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= 16) {
      break;
    }
  }

  return ids;
}

function clampMonitorDelta(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(-32_768, Math.min(32_768, Math.trunc(parsed)));
}

function sanitizeMonitorLayout(rawValue) {
  let source = rawValue;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return [];
    }
    try {
      source = JSON.parse(trimmed);
    } catch (_error) {
      return [];
    }
  }

  const entries = Array.isArray(source)
    ? source
    : (source && typeof source === 'object' ? Object.values(source) : []);
  const seen = new Set();
  const layout = [];

  for (const entry of entries) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > 120 || seen.has(id)) {
      continue;
    }

    const dx = clampMonitorDelta(entry.dx);
    const dy = clampMonitorDelta(entry.dy);
    if (dx === 0 && dy === 0) {
      continue;
    }

    seen.add(id);
    layout.push({ id, dx, dy });
    if (layout.length >= 16) {
      break;
    }
  }

  return layout;
}

function monitorLayoutsEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry, index) => {
    const other = b[index];
    return other
      && entry.id === other.id
      && entry.dx === other.dx
      && entry.dy === other.dy;
  });
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

  if (type === 'release_all') {
    return {
      type,
      at: Date.now()
    };
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
  const accessManager = options.accessManager;
  const heartbeatMs = toBoundedInteger(options.wsHeartbeatMs, 30_000, 10_000, 120_000);
  const defaults = remoteClient.getDefaults();

  const wss = new WebSocketServer({ noServer: true });
  const activeContexts = new Map();

  function heartbeat() {
    this.isAlive = true;
  }

  function publishGatewaySnapshot(extra = {}) {
    const contexts = Array.from(activeContexts.values()).filter((context) => !context.closed);
    const controlConnections = contexts.filter((context) => context.mode === 'control').length;
    const droppedEvents = contexts.reduce((total, context) => total + context.droppedEvents, 0);

    remoteClient.updateGatewaySnapshot({
      activeConnections: contexts.length,
      controlConnections,
      viewConnections: contexts.length - controlConnections,
      droppedEvents,
      ...extra
    });
  }

  wss.on('connection', async (clientSocket, req) => {
    const access = accessManager ? accessManager.checkRequest(req) : { allowed: true };
    if (!access.allowed) {
      clientSocket.close(1008, access.message || 'Tailscale connection required');
      return;
    }

    if (!remoteClient.isEnabled()) {
      clientSocket.close(1008, 'Remote capability disabled');
      return;
    }

    let status = null;
    try {
      status = await remoteClient.getStatus({ forceHealthCheck: true });
    } catch (error) {
      clientSocket.close(1013, 'Remote status unavailable');
      return;
    }

    if (!isWsOpen(clientSocket)) {
      return;
    }

    if (!status || !status.sidecar || status.sidecar.reachable !== true) {
      clientSocket.close(1013, 'Remote sidecar unavailable');
      return;
    }

    const requestedMode = normalizeMode(parseQueryValue(req, 'mode'), defaults.defaultMode);
    const requestedStreamFps = toBoundedInteger(parseQueryValue(req, 'fps'), defaults.streamFps, 1, 20);
    const requestedJpegQuality = toBoundedInteger(parseQueryValue(req, 'quality'), defaults.jpegQuality, 20, 95);
    const requestedMonitorIds = sanitizeMonitorIds(parseQueryValue(req, 'monitors'));
    const requestedMonitorLayout = sanitizeMonitorLayout(parseQueryValue(req, 'layout'));
    const controlAllowed = status.sidecar.inputAvailable === true;
    let connectionSettings = {
      mode: requestedMode === 'control' && controlAllowed ? 'control' : 'view',
      requestedMode,
      controlAllowed,
      streamFps: requestedStreamFps,
      jpegQuality: requestedJpegQuality,
      monitorIds: requestedMonitorIds,
      monitorLayout: requestedMonitorLayout
    };

    const remoteConnectionId = crypto.randomUUID();
    const connectionMeta = {
      remoteConnectionId,
      remoteIp: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null
    };

    const context = {
      closed: false,
      streamSocket: null,
      inputSocket: null,
      mode: normalizeMode(connectionSettings.mode, 'view'),
      controlAllowed: connectionSettings.controlAllowed === true,
      inputQueue: [],
      inputFlushTimer: null,
      rateWindowStartedAt: Date.now(),
      rateWindowCount: 0,
      droppedEvents: 0,
      lastThrottleNoticeAt: 0,
      lastBackpressureNoticeAt: 0,
      lastFrameStats: null,
      lastInputError: null
    };
    activeContexts.set(remoteConnectionId, context);
    publishGatewaySnapshot({
      totalConnections: (remoteClient.getGatewaySnapshot().totalConnections || 0) + 1,
      lastConnectedAt: new Date().toISOString()
    });

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

    function sendInputEventDirect(event) {
      if (!context.inputSocket || context.inputSocket.readyState !== WebSocket.OPEN) {
        return false;
      }

      try {
        context.inputSocket.send(JSON.stringify({
          type: 'input',
          event
        }));
        return true;
      } catch (error) {
        context.lastInputError = error && error.message ? error.message : 'input-send-failed';
        return false;
      }
    }

    function releaseRemoteInputState(reason) {
      const event = {
        type: 'release_all',
        reason: reason || null,
        at: Date.now()
      };

      context.inputQueue.length = 0;
      sendInputEventDirect(event);
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
      releaseRemoteInputState('client-disconnected');
      context.closed = true;

      clearInputFlushTimer();
      cleanupSidecarSockets();
      activeContexts.delete(remoteConnectionId);
      publishGatewaySnapshot({
        lastDisconnectedAt: new Date().toISOString(),
        lastInputError: context.lastInputError
      });

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
      let modeReason = reason || null;

      if (requested === 'control' && !context.controlAllowed) {
        effectiveMode = 'view';
        modeReason = 'control-unavailable';
      }

      if (previous === 'control' && effectiveMode !== 'control') {
        releaseRemoteInputState(modeReason || 'control-disabled');
      }

      context.mode = effectiveMode;
      publishGatewaySnapshot();
      sendControl('remote-mode', {
        mode: context.mode,
        controlAllowed: context.controlAllowed,
        reason: modeReason
      });

      if (previous !== context.mode && logger) {
        const message = context.mode === 'control'
          ? 'Remote control enabled'
          : 'Remote control disabled';
        logger.info(message, {
          ...connectionMeta,
          previousMode: previous,
          mode: context.mode,
          reason: modeReason
        });
      }

      if (context.mode === 'control') {
        ensureInputSocket();
      }
    }

    function applyStreamSettings(nextFps, nextQuality, reason) {
      const streamFps = toBoundedInteger(nextFps, connectionSettings.streamFps, 1, 20);
      const jpegQuality = toBoundedInteger(nextQuality, connectionSettings.jpegQuality, 20, 95);
      const changed = streamFps !== connectionSettings.streamFps || jpegQuality !== connectionSettings.jpegQuality;

      connectionSettings = {
        ...connectionSettings,
        streamFps,
        jpegQuality
      };

      sendControl('remote-stream-config', {
        fps: connectionSettings.streamFps,
        jpegQuality: connectionSettings.jpegQuality,
        reason: reason || null
      });

      publishGatewaySnapshot();

      if (!changed || context.closed) {
        return;
      }

      const previousStreamSocket = context.streamSocket;
      context.streamSocket = null;
      if (previousStreamSocket && (
        previousStreamSocket.readyState === WebSocket.OPEN
        || previousStreamSocket.readyState === WebSocket.CONNECTING
      )) {
        try {
          previousStreamSocket.close(1000, 'stream-settings-changed');
        } catch (_error) {
          // Ignore close races.
        }
      }
      bindStreamSocket();
    }

    function applyMonitorSelection(rawMonitorIds, reason) {
      const monitorIds = sanitizeMonitorIds(rawMonitorIds);
      const previous = connectionSettings.monitorIds || [];
      const changed = previous.length !== monitorIds.length
        || previous.some((id, index) => id !== monitorIds[index]);

      connectionSettings = {
        ...connectionSettings,
        monitorIds
      };

      sendControl('remote-monitor-config', {
        monitorIds,
        monitors: status.sidecar && status.sidecar.health
          ? status.sidecar.health.displays || status.sidecar.health.monitors || []
          : [],
        reason: reason || null
      });

      if (!changed || context.closed) {
        return;
      }

      const previousStreamSocket = context.streamSocket;
      context.streamSocket = null;
      if (previousStreamSocket && (
        previousStreamSocket.readyState === WebSocket.OPEN
        || previousStreamSocket.readyState === WebSocket.CONNECTING
      )) {
        try {
          previousStreamSocket.close(1000, 'monitor-selection-changed');
        } catch (_error) {
          // Ignore close races.
        }
      }
      bindStreamSocket();
    }

    function sendMonitorLayoutToStream() {
      if (!context.streamSocket || context.streamSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        context.streamSocket.send(JSON.stringify({
          type: 'set-monitor-layout',
          layout: connectionSettings.monitorLayout || []
        }));
      } catch (_error) {
        // The next stream reconnect or layout update will refresh sidecar state.
      }
    }

    function applyMonitorLayout(rawLayout, reason) {
      const monitorLayout = sanitizeMonitorLayout(rawLayout);
      const changed = !monitorLayoutsEqual(connectionSettings.monitorLayout, monitorLayout);

      connectionSettings = {
        ...connectionSettings,
        monitorLayout
      };

      sendControl('remote-monitor-layout', {
        layout: monitorLayout,
        reason: reason || null
      });

      if (!changed || context.closed) {
        return;
      }

      sendMonitorLayoutToStream();
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
          publishGatewaySnapshot({ lastInputError: context.lastInputError });
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
        fps: connectionSettings.streamFps,
        quality: connectionSettings.jpegQuality,
        monitors: connectionSettings.monitorIds,
        layout: connectionSettings.monitorLayout
      });
      context.streamSocket = streamSocket;

      streamSocket.on('open', () => {
        if (context.closed || context.streamSocket !== streamSocket) {
          return;
        }

        sendControl('remote-stream-connected', {
          fps: connectionSettings.streamFps,
          jpegQuality: connectionSettings.jpegQuality,
          monitorIds: connectionSettings.monitorIds,
          monitorLayout: connectionSettings.monitorLayout
        });
        sendMonitorLayoutToStream();
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

        if (payload.type === 'ready') {
          sendControl('remote-stream-config', {
            fps: Number(payload.fps) || connectionSettings.streamFps,
            jpegQuality: Number(payload.jpegQuality) || connectionSettings.jpegQuality,
            monitors: Array.isArray(payload.monitors) ? payload.monitors : [],
            monitorIds: Array.isArray(payload.monitorIds) ? payload.monitorIds : connectionSettings.monitorIds,
            monitorLayout: connectionSettings.monitorLayout
          });
          return;
        }

        if (payload.type === 'stats') {
          const frameStats = {
            fps: Number(payload.fps) || 0,
            frameBytes: Number(payload.frameBytes) || 0,
            captureTs: Number(payload.captureTs) || null,
            captureLatencyMs: Number(payload.captureLatencyMs) || null,
            receivedAt: new Date().toISOString()
          };
          context.lastFrameStats = frameStats;
          publishGatewaySnapshot({ lastFrameStats: frameStats });
          sendControl('remote-stats', {
            ...frameStats,
            display: payload.display || null,
            monitors: Array.isArray(payload.displays) ? payload.displays : []
          });
          return;
        }

        if (payload.type === 'cursor') {
          const normalizedX = clampNormalized(payload.x);
          const normalizedY = clampNormalized(payload.y);
          if (normalizedX === null || normalizedY === null) {
            return;
          }

          sendControl('remote-cursor', {
            x: normalizedX,
            y: normalizedY,
            at: Number(payload.at) || Date.now()
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

      if (rawType === 'set-stream' || rawType === 'remote:set-stream') {
        const requestedQuality = Object.prototype.hasOwnProperty.call(payload, 'quality')
          ? payload.quality
          : payload.jpegQuality;
        applyStreamSettings(payload.fps, requestedQuality, 'client-toggle');
        return;
      }

      if (rawType === 'set-monitors' || rawType === 'remote:set-monitors') {
        applyMonitorSelection(payload.monitors || payload.monitorIds, 'client-toggle');
        return;
      }

      if (rawType === 'set-monitor-layout' || rawType === 'remote:set-monitor-layout') {
        applyMonitorLayout(payload.layout || payload.monitors || [], 'client-drag');
        return;
      }

      if (rawType === 'release-all' || rawType === 'remote:release-all') {
        releaseRemoteInputState('client-request');
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
        stream: {
          fps: connectionSettings.streamFps,
          jpegQuality: connectionSettings.jpegQuality,
          presets: remoteClient.getStreamPresets()
        },
        actions: remoteClient.getRemoteActions(),
        display: status.sidecar && status.sidecar.health ? status.sidecar.health.display || null : null,
        monitors: status.sidecar && status.sidecar.health
          ? status.sidecar.health.displays || status.sidecar.health.monitors || []
          : [],
        monitorIds: connectionSettings.monitorIds,
        monitorLayout: connectionSettings.monitorLayout,
        sidecar: {
          reachable: status.sidecar.reachable === true,
          inputAvailable: status.sidecar.inputAvailable === true,
          platform: status.sidecar.health ? status.sidecar.health.platform || null : null
        },
        gateway: remoteClient.getGatewaySnapshot()
      });
    }

    if (logger) {
      logger.info('Remote websocket connected', {
        ...connectionMeta,
        requestedMode: connectionSettings.requestedMode,
        mode: context.mode,
        controlAllowed: context.controlAllowed
      });
    }

    applyMode(connectionSettings.mode, 'client-default');
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
