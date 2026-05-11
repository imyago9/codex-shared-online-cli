const { WebSocket } = require('ws');

const STREAM_PRESETS = [
  {
    id: 'economy',
    label: 'Economy',
    fps: 5,
    videoFps: 15,
    jpegQuality: 46,
    intent: 'Lower bandwidth and calmer battery use'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    fps: 10,
    videoFps: 30,
    jpegQuality: 62,
    intent: 'Good default for iPhone remote control'
  },
  {
    id: 'fluid',
    label: 'Fluid',
    fps: 20,
    videoFps: 60,
    jpegQuality: 64,
    intent: 'Smoother pointer movement'
  },
  {
    id: 'sharp',
    label: 'Sharp',
    fps: 12,
    videoFps: 60,
    jpegQuality: 86,
    intent: 'More readable text and UI detail'
  }
];

const REMOTE_ACTIONS = [
  { id: 'copy', label: 'Copy', key: 'c', code: 'KeyC', modifiers: { ctrl: true } },
  { id: 'paste', label: 'Paste', key: 'v', code: 'KeyV', modifiers: { ctrl: true } },
  { id: 'cut', label: 'Cut', key: 'x', code: 'KeyX', modifiers: { ctrl: true } },
  { id: 'undo', label: 'Undo', key: 'z', code: 'KeyZ', modifiers: { ctrl: true } },
  { id: 'redo', label: 'Redo', key: 'y', code: 'KeyY', modifiers: { ctrl: true } },
  { id: 'selectAll', label: 'Select All', key: 'a', code: 'KeyA', modifiers: { ctrl: true } },
  { id: 'find', label: 'Find', key: 'f', code: 'KeyF', modifiers: { ctrl: true } },
  { id: 'save', label: 'Save', key: 's', code: 'KeyS', modifiers: { ctrl: true } },
  { id: 'print', label: 'Print', key: 'p', code: 'KeyP', modifiers: { ctrl: true } },
  { id: 'newTab', label: 'New Tab', key: 't', code: 'KeyT', modifiers: { ctrl: true } },
  { id: 'closeTab', label: 'Close Tab', key: 'w', code: 'KeyW', modifiers: { ctrl: true } },
  { id: 'nextTab', label: 'Next Tab', key: 'Tab', code: 'Tab', modifiers: { ctrl: true } },
  { id: 'previousTab', label: 'Previous Tab', key: 'Tab', code: 'Tab', modifiers: { ctrl: true, shift: true } },
  { id: 'reopenClosedTab', label: 'Reopen Tab', key: 't', code: 'KeyT', modifiers: { ctrl: true, shift: true } },
  { id: 'newWindow', label: 'New Window', key: 'n', code: 'KeyN', modifiers: { ctrl: true } },
  { id: 'addressBar', label: 'Address Bar', key: 'l', code: 'KeyL', modifiers: { ctrl: true } },
  { id: 'browserBack', label: 'Back', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: { alt: true } },
  { id: 'browserForward', label: 'Forward', key: 'ArrowRight', code: 'ArrowRight', modifiers: { alt: true } },
  { id: 'enter', label: 'Enter', key: 'Enter', code: 'Enter', modifiers: {} },
  { id: 'escape', label: 'Escape', key: 'Escape', code: 'Escape', modifiers: {} },
  { id: 'backspace', label: 'Backspace', key: 'Backspace', code: 'Backspace', modifiers: {} },
  { id: 'delete', label: 'Delete', key: 'Delete', code: 'Delete', modifiers: {} },
  { id: 'home', label: 'Home', key: 'Home', code: 'Home', modifiers: {} },
  { id: 'end', label: 'End', key: 'End', code: 'End', modifiers: {} },
  { id: 'pageUp', label: 'Page Up', key: 'PageUp', code: 'PageUp', modifiers: {} },
  { id: 'pageDown', label: 'Page Down', key: 'PageDown', code: 'PageDown', modifiers: {} },
  { id: 'insert', label: 'Insert', key: 'Insert', code: 'Insert', modifiers: {} },
  { id: 'rename', label: 'Rename', key: 'F2', code: 'F2', modifiers: {} },
  { id: 'refresh', label: 'Refresh', key: 'F5', code: 'F5', modifiers: {} },
  { id: 'fullScreen', label: 'Full Screen', key: 'F11', code: 'F11', modifiers: {} },
  { id: 'devTools', label: 'Dev Tools', key: 'F12', code: 'F12', modifiers: {} },
  { id: 'properties', label: 'Properties', key: 'Enter', code: 'Enter', modifiers: { alt: true } },
  { id: 'windowMenu', label: 'Window Menu', key: 'Space', code: 'Space', modifiers: { alt: true } },
  { id: 'closeWindow', label: 'Close Window', key: 'F4', code: 'F4', modifiers: { alt: true } },
  { id: 'altTab', label: 'Alt Tab', key: 'Tab', code: 'Tab', modifiers: { alt: true } },
  { id: 'altShiftTab', label: 'Alt Shift Tab', key: 'Tab', code: 'Tab', modifiers: { alt: true, shift: true } },
  { id: 'winTab', label: 'Win Tab', key: 'Tab', code: 'Tab', modifiers: { meta: true } },
  { id: 'showDesktop', label: 'Show Desktop', key: 'd', code: 'KeyD', modifiers: { meta: true } },
  { id: 'taskManager', label: 'Task Manager', key: 'Escape', code: 'Escape', modifiers: { ctrl: true, shift: true } },
  { id: 'runDialog', label: 'Run', key: 'r', code: 'KeyR', modifiers: { meta: true } },
  { id: 'fileExplorer', label: 'File Explorer', key: 'e', code: 'KeyE', modifiers: { meta: true } },
  { id: 'search', label: 'Search', key: 's', code: 'KeyS', modifiers: { meta: true } },
  { id: 'settings', label: 'Settings', key: 'i', code: 'KeyI', modifiers: { meta: true } },
  { id: 'clipboardHistory', label: 'Clipboard History', key: 'v', code: 'KeyV', modifiers: { meta: true } },
  { id: 'minimizeAll', label: 'Minimize All', key: 'm', code: 'KeyM', modifiers: { meta: true } },
  { id: 'restoreWindows', label: 'Restore Windows', key: 'm', code: 'KeyM', modifiers: { meta: true, shift: true } },
  { id: 'lock', label: 'Lock', key: 'l', code: 'KeyL', modifiers: { meta: true } },
  { id: 'screenshot', label: 'Screenshot', key: 'PrintScreen', code: 'PrintScreen', modifiers: {} },
  { id: 'screenSnip', label: 'Screen Snip', key: 's', code: 'KeyS', modifiers: { meta: true, shift: true } }
];

function normalizeMode(rawValue, fallback = 'view') {
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (normalized === 'view' || normalized === 'control') {
    return normalized;
  }
  return fallback;
}

function toSafeInteger(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function videoBitrateForQuality(rawQuality, fallbackQuality = 62) {
  const quality = toSafeInteger(rawQuality, fallbackQuality, 20, 95);
  const ratio = (quality - 20) / 75;
  return toSafeInteger(Math.round(8_000 + ratio * 24_000), 20_000, 500, 50_000);
}

function preferLowLatency(socket) {
  socket.on('open', () => {
    const transport = socket && socket._socket;
    if (transport && typeof transport.setNoDelay === 'function') {
      try {
        transport.setNoDelay(true);
      } catch (_error) {
        // Best-effort TCP tuning.
      }
    }
  });
  return socket;
}

function serializeMonitorLayout(layout) {
  if (!Array.isArray(layout) || layout.length === 0) {
    return null;
  }

  const items = layout
    .map((entry) => {
      const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
      const dx = Number.parseInt(entry && entry.dx, 10);
      const dy = Number.parseInt(entry && entry.dy, 10);
      if (!id || id.length > 120 || (!Number.isFinite(dx) && !Number.isFinite(dy))) {
        return null;
      }
      return {
        id,
        dx: Number.isFinite(dx) ? dx : 0,
        dy: Number.isFinite(dy) ? dy : 0
      };
    })
    .filter((entry) => entry && (entry.dx !== 0 || entry.dy !== 0));

  return items.length > 0 ? JSON.stringify(items.slice(0, 16)) : null;
}

function normalizeAgentUrl(rawValue) {
  const fallback = 'http://127.0.0.1:3390';
  const candidate = typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : fallback;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }

    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return fallback;
  }
}

class RemoteClient {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.logger = options.logger;
    this.agentUrl = normalizeAgentUrl(options.agentUrl);
    this.defaultMode = normalizeMode(options.defaultMode, 'view');
    this.streamFps = toSafeInteger(options.streamFps, 10, 1, 20);
    this.jpegQuality = toSafeInteger(options.jpegQuality, 62, 20, 95);
    this.inputRateLimitPerSec = toSafeInteger(options.inputRateLimitPerSec, 360, 10, 600);
    this.inputMaxQueue = toSafeInteger(options.inputMaxQueue, 120, 20, 2_000);
    this.healthTimeoutMs = toSafeInteger(options.healthTimeoutMs, 2_500, 500, 10_000);

    this.healthCache = {
      fetchedAt: 0,
      result: null,
      inFlight: null
    };

    this.gatewaySnapshot = {
      activeConnections: 0,
      viewConnections: 0,
      controlConnections: 0,
      totalConnections: 0,
      droppedEvents: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastFrameStats: null,
      lastInputError: null,
      updatedAt: null
    };
  }

  isEnabled() {
    return this.enabled;
  }

  getDefaults() {
    return {
      defaultMode: this.defaultMode,
      streamFps: this.streamFps,
      jpegQuality: this.jpegQuality,
      inputRateLimitPerSec: this.inputRateLimitPerSec,
      inputMaxQueue: this.inputMaxQueue,
      agentUrl: this.agentUrl
    };
  }

  getStreamPresets() {
    return STREAM_PRESETS.map((preset) => ({ ...preset }));
  }

  getRemoteActions() {
    return REMOTE_ACTIONS.map((action) => ({
      ...action,
      modifiers: { ...(action.modifiers || {}) }
    }));
  }

  getGatewaySnapshot() {
    return {
      ...this.gatewaySnapshot,
      lastFrameStats: this.gatewaySnapshot.lastFrameStats
        ? { ...this.gatewaySnapshot.lastFrameStats }
        : null
    };
  }

  updateGatewaySnapshot(patch = {}) {
    this.gatewaySnapshot = {
      ...this.gatewaySnapshot,
      ...patch,
      updatedAt: new Date().toISOString()
    };
  }

  buildSidecarHttpUrl(pathname) {
    const url = new URL(this.agentUrl);
    url.pathname = pathname;
    url.search = '';
    return url.toString();
  }

  buildSidecarWsUrl(pathname, query = {}) {
    const url = new URL(this.agentUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = pathname;
    url.search = '';

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  async checkAgentHealth(options = {}) {
    if (!this.enabled) {
      return {
        reachable: false,
        ok: false,
        inputAvailable: false,
        reason: 'remote-disabled',
        health: null
      };
    }

    const now = Date.now();
    const force = options.force === true;
    const cacheAgeMs = now - this.healthCache.fetchedAt;
    if (!force && this.healthCache.result && cacheAgeMs < 2_000) {
      return this.healthCache.result;
    }

    if (!force && this.healthCache.inFlight) {
      return this.healthCache.inFlight;
    }

    const inFlight = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timeout = null;

      if (controller) {
        timeout = setTimeout(() => {
          controller.abort();
        }, this.healthTimeoutMs);
        timeout.unref();
      }

      try {
        const response = await fetch(this.buildSidecarHttpUrl('/health'), {
          method: 'GET',
          signal: controller ? controller.signal : undefined,
          headers: { Accept: 'application/json' }
        });

        if (!response.ok) {
          throw new Error(`sidecar health status ${response.status}`);
        }

        const payload = await response.json();
        const result = {
          reachable: true,
          ok: payload && payload.ok !== false,
          inputAvailable: payload && payload.input && payload.input.available === true,
          reason: null,
          health: payload || null
        };

        this.healthCache.result = result;
        this.healthCache.fetchedAt = Date.now();
        return result;
      } catch (error) {
        const result = {
          reachable: false,
          ok: false,
          inputAvailable: false,
          reason: error && error.message ? error.message : 'health-check-failed',
          health: null
        };

        this.healthCache.result = result;
        this.healthCache.fetchedAt = Date.now();
        return result;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    })();

    this.healthCache.inFlight = inFlight;

    try {
      return await inFlight;
    } finally {
      if (this.healthCache.inFlight === inFlight) {
        this.healthCache.inFlight = null;
      }
    }
  }

  async getStatus(options = {}) {
    const health = await this.checkAgentHealth({ force: options.forceHealthCheck === true });
    return {
      enabled: this.enabled,
      defaultMode: this.defaultMode,
      streamFps: this.streamFps,
      jpegQuality: this.jpegQuality,
      inputRateLimitPerSec: this.inputRateLimitPerSec,
      inputMaxQueue: this.inputMaxQueue,
      streamPresets: this.getStreamPresets(),
      actions: this.getRemoteActions(),
      gateway: this.getGatewaySnapshot(),
      sidecar: {
        url: this.agentUrl,
        reachable: health.reachable === true,
        ok: health.ok === true,
        inputAvailable: health.inputAvailable === true,
        reason: health.reason || null,
        health: health.health || null
      }
    };
  }

  getCapabilities(status) {
    const resolvedStatus = status || {
      enabled: this.enabled,
      defaultMode: this.defaultMode,
      streamFps: this.streamFps,
      jpegQuality: this.jpegQuality,
      inputRateLimitPerSec: this.inputRateLimitPerSec,
      inputMaxQueue: this.inputMaxQueue,
      sidecar: {
        reachable: false,
        inputAvailable: false
      }
    };

    return {
      enabled: resolvedStatus.enabled === true,
      defaultMode: resolvedStatus.defaultMode || this.defaultMode,
      sidecarReachable: Boolean(resolvedStatus.sidecar && resolvedStatus.sidecar.reachable === true),
      controlAvailable: Boolean(resolvedStatus.sidecar && resolvedStatus.sidecar.inputAvailable === true),
      streamFps: resolvedStatus.streamFps || this.streamFps,
      jpegQuality: resolvedStatus.jpegQuality || this.jpegQuality,
      inputRateLimitPerSec: resolvedStatus.inputRateLimitPerSec || this.inputRateLimitPerSec,
      inputMaxQueue: resolvedStatus.inputMaxQueue || this.inputMaxQueue,
      streamPresets: this.getStreamPresets(),
      actions: this.getRemoteActions(),
      display: resolvedStatus.sidecar && resolvedStatus.sidecar.health
        ? resolvedStatus.sidecar.health.display || null
        : null,
      monitors: resolvedStatus.sidecar && resolvedStatus.sidecar.health
        ? resolvedStatus.sidecar.health.displays || resolvedStatus.sidecar.health.monitors || []
        : [],
      video: resolvedStatus.sidecar && resolvedStatus.sidecar.health
        ? resolvedStatus.sidecar.health.video || null
        : null,
      gateway: this.getGatewaySnapshot()
    };
  }

  openStreamSocket(options = {}) {
    const wsUrl = this.buildSidecarWsUrl('/stream', {
      fps: toSafeInteger(options.fps, this.streamFps, 1, 20),
      quality: toSafeInteger(options.quality, this.jpegQuality, 20, 95),
      monitors: Array.isArray(options.monitors) && options.monitors.length > 0
        ? options.monitors.join(',')
        : null,
      layout: serializeMonitorLayout(options.layout)
    });

    return preferLowLatency(new WebSocket(wsUrl, {
      perMessageDeflate: false
    }));
  }

  openVideoSocket(options = {}) {
    const quality = toSafeInteger(options.quality, this.jpegQuality, 20, 95);
    const wsUrl = this.buildSidecarWsUrl('/video', {
      fps: toSafeInteger(options.fps, 60, 1, 120),
      quality,
      bitrateKbps: toSafeInteger(options.bitrateKbps, videoBitrateForQuality(quality, this.jpegQuality), 500, 50_000),
      monitors: Array.isArray(options.monitors) && options.monitors.length > 0
        ? options.monitors.join(',')
        : null,
      layout: serializeMonitorLayout(options.layout)
    });

    return preferLowLatency(new WebSocket(wsUrl, {
      perMessageDeflate: false
    }));
  }

  openInputSocket() {
    const wsUrl = this.buildSidecarWsUrl('/input');
    return preferLowLatency(new WebSocket(wsUrl, {
      perMessageDeflate: false
    }));
  }

  close() {
    this.healthCache.result = null;
    this.healthCache.inFlight = null;
    this.healthCache.fetchedAt = 0;
  }
}

function createRemoteClient(options) {
  return new RemoteClient(options);
}

module.exports = {
  createRemoteClient,
  normalizeMode
};
