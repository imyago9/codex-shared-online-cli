const { WebSocket } = require('ws');

const STREAM_PRESETS = [
  {
    id: 'economy',
    label: 'Economy',
    fps: 4,
    jpegQuality: 42,
    intent: 'Lower bandwidth and calmer battery use'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    fps: 8,
    jpegQuality: 58,
    intent: 'Good default for iPhone remote control'
  },
  {
    id: 'fluid',
    label: 'Fluid',
    fps: 14,
    jpegQuality: 58,
    intent: 'Smoother pointer movement'
  },
  {
    id: 'sharp',
    label: 'Sharp',
    fps: 8,
    jpegQuality: 78,
    intent: 'More readable text and UI detail'
  }
];

const REMOTE_ACTIONS = [
  { id: 'copy', label: 'Copy', key: 'c', code: 'KeyC', modifiers: { ctrl: true } },
  { id: 'paste', label: 'Paste', key: 'v', code: 'KeyV', modifiers: { ctrl: true } },
  { id: 'selectAll', label: 'Select All', key: 'a', code: 'KeyA', modifiers: { ctrl: true } },
  { id: 'altTab', label: 'Alt Tab', key: 'Tab', code: 'Tab', modifiers: { alt: true } },
  { id: 'winTab', label: 'Win Tab', key: 'Tab', code: 'Tab', modifiers: { meta: true } },
  { id: 'showDesktop', label: 'Show Desktop', key: 'd', code: 'KeyD', modifiers: { meta: true } },
  { id: 'taskManager', label: 'Task Manager', key: 'Escape', code: 'Escape', modifiers: { ctrl: true, shift: true } },
  { id: 'lock', label: 'Lock', key: 'l', code: 'KeyL', modifiers: { meta: true } },
  { id: 'screenshot', label: 'Screenshot', key: 'PrintScreen', code: 'PrintScreen', modifiers: {} }
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
    this.streamFps = toSafeInteger(options.streamFps, 8, 1, 20);
    this.jpegQuality = toSafeInteger(options.jpegQuality, 55, 20, 95);
    this.inputRateLimitPerSec = toSafeInteger(options.inputRateLimitPerSec, 120, 10, 600);
    this.inputMaxQueue = toSafeInteger(options.inputMaxQueue, 300, 20, 2_000);
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
      gateway: this.getGatewaySnapshot()
    };
  }

  openStreamSocket(options = {}) {
    const wsUrl = this.buildSidecarWsUrl('/stream', {
      fps: toSafeInteger(options.fps, this.streamFps, 1, 20),
      quality: toSafeInteger(options.quality, this.jpegQuality, 20, 95)
    });

    return new WebSocket(wsUrl, {
      perMessageDeflate: false
    });
  }

  openInputSocket() {
    const wsUrl = this.buildSidecarWsUrl('/input');
    return new WebSocket(wsUrl, {
      perMessageDeflate: false
    });
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
