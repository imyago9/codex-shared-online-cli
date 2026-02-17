const childProcess = require('child_process');
const http = require('http');
const express = require('express');
const screenshotDesktop = require('screenshot-desktop');
const { WebSocketServer, WebSocket } = require('ws');

function parseInteger(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function decodeWsText(rawValue) {
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  if (Buffer.isBuffer(rawValue)) {
    return rawValue.toString('utf8');
  }
  if (rawValue instanceof ArrayBuffer || ArrayBuffer.isView(rawValue)) {
    return Buffer.from(rawValue).toString('utf8');
  }
  return null;
}

function createLogger(level) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const normalizedLevel = levels.includes(level) ? level : 'info';
  const minimumIndex = levels.indexOf(normalizedLevel);

  function shouldLog(nextLevel) {
    return levels.indexOf(nextLevel) >= minimumIndex;
  }

  function format(nextLevel, message, context) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${nextLevel.toUpperCase()}]`;

    if (!context || Object.keys(context).length === 0) {
      return `${prefix} ${message}`;
    }

    return `${prefix} ${message} ${JSON.stringify(context)}`;
  }

  return {
    debug(message, context) {
      if (shouldLog('debug')) {
        console.debug(format('debug', message, context));
      }
    },
    info(message, context) {
      if (shouldLog('info')) {
        console.info(format('info', message, context));
      }
    },
    warn(message, context) {
      if (shouldLog('warn')) {
        console.warn(format('warn', message, context));
      }
    },
    error(message, context) {
      if (shouldLog('error')) {
        console.error(format('error', message, context));
      }
    }
  };
}

function isWsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function parseRequestQuery(req) {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    return parsed.searchParams;
  } catch (_error) {
    return new URLSearchParams();
  }
}

function clampNormalized(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
}

function resolvePrimaryDisplayBounds(logger) {
  if (process.platform !== 'win32') {
    return { width: 1920, height: 1080 };
  }

  try {
    const command = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
      'Write-Output ($b.Width.ToString()+","+$b.Height.ToString())'
    ].join(' ');

    const raw = childProcess.execFileSync('powershell', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const match = String(raw || '').trim().match(/^(\d+),(\d+)$/);
    if (!match) {
      throw new Error(`Unexpected display bounds output: ${String(raw || '').trim()}`);
    }

    const width = clampInteger(Number.parseInt(match[1], 10), 320, 16_384);
    const height = clampInteger(Number.parseInt(match[2], 10), 240, 16_384);
    return { width, height };
  } catch (error) {
    logger.warn('Failed to resolve Windows display bounds, using fallback', {
      message: error.message
    });
    return { width: 1920, height: 1080 };
  }
}

function createUnavailableInputController(reason) {
  return {
    available: false,
    reason,
    async handleEvent() {
      return { ok: false, reason };
    }
  };
}

function pickEnumValue(enumObject, names) {
  if (!enumObject || typeof enumObject !== 'object') {
    return null;
  }

  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(enumObject, name)) {
      return enumObject[name];
    }
  }

  return null;
}

function createNutInputController(nut, displayBounds, logger) {
  const mouse = nut && nut.mouse;
  const keyboard = nut && nut.keyboard;
  const Button = nut && nut.Button;
  const Key = nut && nut.Key;
  const Point = nut && nut.Point;

  if (!mouse || !keyboard || !Button || !Key) {
    return createUnavailableInputController('nut-js api incomplete');
  }

  const keyMapByCode = {
    Enter: ['Enter', 'Return'],
    Escape: ['Escape'],
    Backspace: ['Backspace'],
    Tab: ['Tab'],
    Space: ['Space'],
    ArrowUp: ['Up'],
    ArrowDown: ['Down'],
    ArrowLeft: ['Left'],
    ArrowRight: ['Right'],
    Delete: ['Delete'],
    Home: ['Home'],
    End: ['End'],
    PageUp: ['PageUp'],
    PageDown: ['PageDown'],
    Insert: ['Insert'],
    F1: ['F1'],
    F2: ['F2'],
    F3: ['F3'],
    F4: ['F4'],
    F5: ['F5'],
    F6: ['F6'],
    F7: ['F7'],
    F8: ['F8'],
    F9: ['F9'],
    F10: ['F10'],
    F11: ['F11'],
    F12: ['F12']
  };

  const keyMapByName = {
    enter: ['Enter', 'Return'],
    escape: ['Escape'],
    esc: ['Escape'],
    backspace: ['Backspace'],
    tab: ['Tab'],
    space: ['Space'],
    ' ': ['Space'],
    arrowup: ['Up'],
    arrowdown: ['Down'],
    arrowleft: ['Left'],
    arrowright: ['Right'],
    up: ['Up'],
    down: ['Down'],
    left: ['Left'],
    right: ['Right'],
    delete: ['Delete'],
    home: ['Home'],
    end: ['End'],
    pageup: ['PageUp'],
    pagedown: ['PageDown']
  };

  function resolveCharacterKey(keyValue) {
    if (!keyValue || typeof keyValue !== 'string' || keyValue.length !== 1) {
      return null;
    }

    const upper = keyValue.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return pickEnumValue(Key, [upper]);
    }

    if (upper >= '0' && upper <= '9') {
      return pickEnumValue(Key, [`Num${upper}`, `Number${upper}`, upper]);
    }

    return null;
  }

  function resolveKey(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const code = typeof event.code === 'string' ? event.code.trim() : '';
    if (code) {
      if (/^Key[A-Z]$/.test(code)) {
        return pickEnumValue(Key, [code.slice(3)]);
      }
      if (/^Digit[0-9]$/.test(code)) {
        const digit = code.slice(5);
        return pickEnumValue(Key, [`Num${digit}`, `Number${digit}`, digit]);
      }
      if (keyMapByCode[code]) {
        return pickEnumValue(Key, keyMapByCode[code]);
      }
    }

    const keyName = typeof event.key === 'string' ? event.key.trim() : '';
    const fromCharacter = resolveCharacterKey(keyName);
    if (fromCharacter !== null) {
      return fromCharacter;
    }

    if (keyName) {
      const normalized = keyName.toLowerCase();
      if (keyMapByName[normalized]) {
        return pickEnumValue(Key, keyMapByName[normalized]);
      }
    }

    return null;
  }

  function resolveModifierKeys(event) {
    const modifiers = event && event.modifiers && typeof event.modifiers === 'object'
      ? event.modifiers
      : {};

    const keys = [];
    if (modifiers.ctrl === true) {
      const value = pickEnumValue(Key, ['LeftControl', 'RightControl', 'Control']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.shift === true) {
      const value = pickEnumValue(Key, ['LeftShift', 'RightShift', 'Shift']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.alt === true) {
      const value = pickEnumValue(Key, ['LeftAlt', 'RightAlt', 'Alt']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.meta === true) {
      const value = pickEnumValue(Key, ['LeftSuper', 'RightSuper', 'Meta']);
      if (value !== null) {
        keys.push(value);
      }
    }

    return keys;
  }

  function resolveButton(buttonName) {
    const normalized = typeof buttonName === 'string' ? buttonName.trim().toLowerCase() : '';
    if (normalized === 'right') {
      return pickEnumValue(Button, ['RIGHT', 'Right', 'right']);
    }
    if (normalized === 'middle') {
      return pickEnumValue(Button, ['MIDDLE', 'Middle', 'middle']);
    }
    return pickEnumValue(Button, ['LEFT', 'Left', 'left']);
  }

  function buildPoint(x, y) {
    if (typeof Point === 'function') {
      return new Point(x, y);
    }
    return { x, y };
  }

  async function moveToNormalized(x, y) {
    const normalizedX = clampNormalized(x);
    const normalizedY = clampNormalized(y);
    if (normalizedX === null || normalizedY === null) {
      throw new Error('invalid-normalized-coordinates');
    }

    const px = Math.round(normalizedX * Math.max(1, displayBounds.width - 1));
    const py = Math.round(normalizedY * Math.max(1, displayBounds.height - 1));

    if (typeof mouse.setPosition !== 'function') {
      throw new Error('mouse-setPosition-unavailable');
    }

    await mouse.setPosition(buildPoint(px, py));
  }

  async function handleMouseButton(event) {
    if (event && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      await moveToNormalized(event.x, event.y);
    }

    const button = resolveButton(event.button);
    if (button === null) {
      throw new Error('unknown-mouse-button');
    }

    if (event.action === 'down') {
      if (typeof mouse.pressButton !== 'function') {
        throw new Error('mouse-pressButton-unavailable');
      }
      await mouse.pressButton(button);
      return;
    }

    if (event.action === 'up') {
      if (typeof mouse.releaseButton !== 'function') {
        throw new Error('mouse-releaseButton-unavailable');
      }
      await mouse.releaseButton(button);
      return;
    }

    if (typeof mouse.click === 'function') {
      await mouse.click(button);
      return;
    }

    if (typeof mouse.pressButton === 'function' && typeof mouse.releaseButton === 'function') {
      await mouse.pressButton(button);
      await mouse.releaseButton(button);
      return;
    }

    throw new Error('mouse-click-unavailable');
  }

  async function handleMouseWheel(event) {
    const deltaY = Number(event.deltaY) || 0;
    if (deltaY === 0) {
      return;
    }

    const scrollAmount = clampInteger(Math.abs(Math.round(deltaY / 20)), 1, 40);
    if (deltaY < 0) {
      if (typeof mouse.scrollUp !== 'function') {
        throw new Error('mouse-scrollUp-unavailable');
      }
      await mouse.scrollUp(scrollAmount);
      return;
    }

    if (typeof mouse.scrollDown !== 'function') {
      throw new Error('mouse-scrollDown-unavailable');
    }
    await mouse.scrollDown(scrollAmount);
  }

  async function handleKeyEvent(event) {
    const action = typeof event.action === 'string' ? event.action : 'press';
    const key = resolveKey(event);
    const text = typeof event.text === 'string' ? event.text : '';
    const modifiers = resolveModifierKeys(event);

    if (action === 'down') {
      if (key === null || typeof keyboard.pressKey !== 'function') {
        return;
      }
      await keyboard.pressKey(key);
      return;
    }

    if (action === 'up') {
      if (key === null || typeof keyboard.releaseKey !== 'function') {
        return;
      }
      await keyboard.releaseKey(key);
      return;
    }

    if (modifiers.length > 0 && typeof keyboard.pressKey === 'function') {
      await keyboard.pressKey(...modifiers);
    }

    if (key !== null && typeof keyboard.pressKey === 'function' && typeof keyboard.releaseKey === 'function') {
      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);
    } else if (text && typeof keyboard.type === 'function') {
      await keyboard.type(text);
    } else if (typeof event.key === 'string' && event.key.length === 1 && typeof keyboard.type === 'function') {
      await keyboard.type(event.key);
    }

    if (modifiers.length > 0 && typeof keyboard.releaseKey === 'function') {
      await keyboard.releaseKey(...modifiers.slice().reverse());
    }
  }

  return {
    available: true,
    reason: null,
    async handleEvent(event) {
      if (!event || typeof event !== 'object') {
        throw new Error('invalid-input-event');
      }

      const type = typeof event.type === 'string' ? event.type.trim().toLowerCase() : '';
      if (!type) {
        throw new Error('input-event-missing-type');
      }

      if (type === 'mouse_move') {
        await moveToNormalized(event.x, event.y);
        return { ok: true };
      }

      if (type === 'mouse_button') {
        await handleMouseButton(event);
        return { ok: true };
      }

      if (type === 'mouse_wheel') {
        await handleMouseWheel(event);
        return { ok: true };
      }

      if (type === 'key') {
        await handleKeyEvent(event);
        return { ok: true };
      }

      if (type === 'text') {
        const text = typeof event.text === 'string' ? event.text : '';
        if (!text) {
          return { ok: true };
        }
        if (typeof keyboard.type !== 'function') {
          throw new Error('keyboard-type-unavailable');
        }
        await keyboard.type(text);
        return { ok: true };
      }

      throw new Error(`unsupported-input-type:${type}`);
    }
  };
}

function createInputController(config, displayBounds, logger) {
  if (!config.inputEnabled) {
    return createUnavailableInputController('disabled-by-env');
  }

  let nut = null;
  try {
    // Optional dependency: if this fails, we intentionally keep view-only streaming.
    nut = require('@nut-tree-fork/nut-js');
  } catch (error) {
    logger.warn('Input automation unavailable, starting in view-only mode', {
      message: error.message
    });
    return createUnavailableInputController('nut-js-not-installed');
  }

  try {
    return createNutInputController(nut, displayBounds, logger);
  } catch (error) {
    logger.warn('Failed to initialize input automation controller', {
      message: error.message
    });
    return createUnavailableInputController('nut-js-init-failed');
  }
}

const config = {
  host: process.env.REMOTE_AGENT_HOST || '127.0.0.1',
  port: clampInteger(parseInteger(process.env.REMOTE_AGENT_PORT, 3390), 1, 65_535),
  streamFps: clampInteger(parseInteger(process.env.REMOTE_STREAM_FPS, 8), 1, 20),
  jpegQuality: clampInteger(parseInteger(process.env.REMOTE_JPEG_QUALITY, 55), 20, 95),
  inputEnabled: parseBoolean(process.env.REMOTE_INPUT_ENABLED, true),
  logLevel: process.env.LOG_LEVEL || 'info'
};

const logger = createLogger(config.logLevel);
const displayBounds = resolvePrimaryDisplayBounds(logger);
const inputController = createInputController(config, displayBounds, logger);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const streamState = {
  clients: new Set(),
  timer: null,
  inFlight: false,
  activeFps: config.streamFps,
  activeQuality: config.jpegQuality,
  framesInWindow: 0,
  windowStartedAt: Date.now(),
  currentFps: 0,
  lastFrameBytes: 0,
  lastCaptureTs: 0,
  lastCaptureLatencyMs: 0,
  lastCaptureError: null,
  lastErrorAt: 0
};

function getOpenStreamClientCount() {
  let count = 0;
  for (const client of streamState.clients) {
    if (isWsOpen(client)) {
      count += 1;
    }
  }
  return count;
}

function broadcastStreamControl(payload) {
  const message = JSON.stringify(payload);
  for (const client of streamState.clients) {
    if (!isWsOpen(client)) {
      continue;
    }
    try {
      client.send(message);
    } catch (_error) {
      // Ignore send races.
    }
  }
}

function recomputeStreamSettings() {
  let nextFps = config.streamFps;
  let nextQuality = config.jpegQuality;

  for (const client of streamState.clients) {
    if (!isWsOpen(client)) {
      continue;
    }

    if (Number.isFinite(client.requestedFps)) {
      nextFps = clampInteger(client.requestedFps, 1, 20);
    }
    if (Number.isFinite(client.requestedQuality)) {
      nextQuality = clampInteger(client.requestedQuality, 20, 95);
    }
  }

  const fpsChanged = nextFps !== streamState.activeFps;
  streamState.activeFps = nextFps;
  streamState.activeQuality = nextQuality;

  if (fpsChanged && streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
    startStreamLoop();
  }
}

async function captureAndBroadcastFrame() {
  if (streamState.inFlight) {
    return;
  }
  if (getOpenStreamClientCount() === 0) {
    return;
  }

  streamState.inFlight = true;
  const captureStart = Date.now();

  try {
    const frame = await screenshotDesktop({
      format: 'jpg',
      quality: streamState.activeQuality
    });

    const frameBuffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const now = Date.now();

    streamState.lastCaptureTs = now;
    streamState.lastCaptureLatencyMs = now - captureStart;
    streamState.lastFrameBytes = frameBuffer.length;
    streamState.framesInWindow += 1;
    streamState.lastCaptureError = null;

    for (const client of streamState.clients) {
      if (!isWsOpen(client)) {
        continue;
      }
      try {
        client.send(frameBuffer, { binary: true });
      } catch (_error) {
        // Ignore send races.
      }
    }

    const elapsedWindowMs = now - streamState.windowStartedAt;
    if (elapsedWindowMs >= 1000) {
      streamState.currentFps = (streamState.framesInWindow * 1000) / Math.max(1, elapsedWindowMs);
      streamState.framesInWindow = 0;
      streamState.windowStartedAt = now;

      broadcastStreamControl({
        type: 'stats',
        fps: Number(streamState.currentFps.toFixed(2)),
        frameBytes: streamState.lastFrameBytes,
        captureTs: streamState.lastCaptureTs,
        captureLatencyMs: streamState.lastCaptureLatencyMs,
        clients: getOpenStreamClientCount()
      });
    }
  } catch (error) {
    streamState.lastCaptureError = error && error.message ? error.message : 'capture-failed';
    const now = Date.now();

    if ((now - streamState.lastErrorAt) >= 2000) {
      streamState.lastErrorAt = now;
      logger.warn('Desktop capture failed', {
        message: streamState.lastCaptureError
      });

      broadcastStreamControl({
        type: 'error',
        message: streamState.lastCaptureError
      });
    }
  } finally {
    streamState.inFlight = false;
  }
}

function startStreamLoop() {
  if (streamState.timer || getOpenStreamClientCount() === 0) {
    return;
  }

  const intervalMs = Math.max(60, Math.round(1000 / streamState.activeFps));
  streamState.timer = setInterval(() => {
    captureAndBroadcastFrame().catch(() => {});
  }, intervalMs);
  streamState.timer.unref();

  captureAndBroadcastFrame().catch(() => {});
}

function stopStreamLoopIfIdle() {
  if (getOpenStreamClientCount() > 0) {
    return;
  }

  if (streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    stream: {
      fps: Number(streamState.currentFps.toFixed(2)),
      targetFps: streamState.activeFps,
      jpegQuality: streamState.activeQuality,
      clients: getOpenStreamClientCount(),
      lastFrameBytes: streamState.lastFrameBytes,
      lastCaptureTs: streamState.lastCaptureTs || null,
      lastCaptureLatencyMs: streamState.lastCaptureLatencyMs || null,
      lastError: streamState.lastCaptureError
    },
    input: {
      available: inputController.available === true,
      reason: inputController.reason || null
    },
    display: displayBounds,
    platform: process.platform
  });
});

const server = http.createServer(app);

const streamWss = new WebSocketServer({ server, path: '/stream' });
streamWss.on('connection', (socket, req) => {
  const query = parseRequestQuery(req);
  socket.requestedFps = clampInteger(parseInteger(query.get('fps'), config.streamFps), 1, 20);
  socket.requestedQuality = clampInteger(parseInteger(query.get('quality'), config.jpegQuality), 20, 95);

  streamState.clients.add(socket);
  recomputeStreamSettings();
  startStreamLoop();

  if (isWsOpen(socket)) {
    socket.send(JSON.stringify({
      type: 'ready',
      fps: streamState.activeFps,
      jpegQuality: streamState.activeQuality
    }));
  }

  socket.on('close', () => {
    streamState.clients.delete(socket);
    recomputeStreamSettings();
    stopStreamLoopIfIdle();
  });

  socket.on('error', (error) => {
    logger.warn('Stream websocket client error', {
      message: error.message
    });
  });
});

const inputWss = new WebSocketServer({ server, path: '/input' });
inputWss.on('connection', (socket) => {
  if (inputController.available !== true) {
    if (isWsOpen(socket)) {
      socket.send(JSON.stringify({
        type: 'error',
        message: `input unavailable (${inputController.reason || 'unknown'})`
      }));
    }
    socket.close(1013, 'Input unavailable');
    return;
  }

  if (isWsOpen(socket)) {
    socket.send(JSON.stringify({
      type: 'ready'
    }));
  }

  let pending = Promise.resolve();

  socket.on('message', (rawValue, isBinary) => {
    if (isBinary) {
      return;
    }

    const text = decodeWsText(rawValue);
    if (!text) {
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      if (isWsOpen(socket)) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'invalid-json'
        }));
      }
      return;
    }

    const event = payload && payload.type === 'input' ? payload.event : payload;
    if (!event || typeof event !== 'object') {
      return;
    }

    pending = pending
      .then(async () => {
        await inputController.handleEvent(event);
      })
      .catch((error) => {
        const message = error && error.message ? error.message : 'input-execution-failed';
        logger.warn('Input event failed', {
          message
        });

        if (isWsOpen(socket)) {
          socket.send(JSON.stringify({
            type: 'error',
            message
          }));
        }
      });
  });

  socket.on('error', (error) => {
    logger.warn('Input websocket client error', {
      message: error.message
    });
  });
});

server.listen(config.port, config.host, () => {
  logger.info('Remote sidecar listening', {
    url: `http://${config.host}:${config.port}`,
    streamFps: config.streamFps,
    jpegQuality: config.jpegQuality,
    inputAvailable: inputController.available,
    inputReason: inputController.reason,
    display: displayBounds
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Shutting down remote sidecar', { signal });

  if (streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
  }

  for (const socket of streamWss.clients) {
    try {
      socket.close(1001, 'Sidecar shutting down');
    } catch (_error) {
      // Ignore close races.
    }
  }

  for (const socket of inputWss.clients) {
    try {
      socket.close(1001, 'Sidecar shutting down');
    } catch (_error) {
      // Ignore close races.
    }
  }

  streamWss.close();
  inputWss.close();

  server.close(() => {
    logger.info('Remote sidecar stopped');
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
