const crypto = require('crypto');
const { WebSocket } = require('ws');

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
    this.tokenTtlMs = toSafeInteger(options.tokenTtlMs, 60_000, 5_000, 10 * 60 * 1000);
    this.healthTimeoutMs = toSafeInteger(options.healthTimeoutMs, 2_500, 500, 10_000);

    this.sessionTokens = new Map();
    this.healthCache = {
      fetchedAt: 0,
      result: null,
      inFlight: null
    };

    this.tokenCleanupTimer = setInterval(() => {
      this.pruneExpiredTokens();
    }, Math.max(5_000, Math.min(this.tokenTtlMs, 60_000)));
    this.tokenCleanupTimer.unref();
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
      tokenTtlMs: this.tokenTtlMs,
      agentUrl: this.agentUrl
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

  issueSessionToken(options = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    const requestedMode = normalizeMode(options.mode, this.defaultMode);
    const controlAllowed = options.controlAllowed === true;
    const mode = requestedMode === 'control' && controlAllowed ? 'control' : 'view';
    const now = Date.now();

    const payload = {
      mode,
      requestedMode,
      controlAllowed,
      streamFps: toSafeInteger(options.streamFps, this.streamFps, 1, 20),
      jpegQuality: toSafeInteger(options.jpegQuality, this.jpegQuality, 20, 95),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.tokenTtlMs).toISOString(),
      meta: {
        ip: options.ip || null,
        userAgent: options.userAgent || null
      }
    };

    this.sessionTokens.set(token, {
      ...payload,
      expiresAtMs: now + this.tokenTtlMs
    });

    return {
      token,
      ...payload,
      ttlMs: this.tokenTtlMs
    };
  }

  consumeSessionToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 160) {
      return null;
    }

    const entry = this.sessionTokens.get(token);
    if (!entry) {
      return null;
    }

    this.sessionTokens.delete(token);
    if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= Date.now()) {
      return null;
    }

    return {
      token,
      mode: entry.mode,
      requestedMode: entry.requestedMode,
      controlAllowed: entry.controlAllowed,
      streamFps: entry.streamFps,
      jpegQuality: entry.jpegQuality,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      meta: entry.meta || {}
    };
  }

  pruneExpiredTokens() {
    const now = Date.now();
    for (const [token, entry] of this.sessionTokens.entries()) {
      if (!entry || !Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.sessionTokens.delete(token);
      }
    }
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
      tokenTtlMs: this.tokenTtlMs,
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

  openStreamSocket(options = {}) {
    const wsUrl = this.buildSidecarWsUrl('/stream', {
      fps: toSafeInteger(options.fps, this.streamFps, 1, 20),
      quality: toSafeInteger(options.quality, this.jpegQuality, 20, 95)
    });

    return new WebSocket(wsUrl);
  }

  openInputSocket() {
    const wsUrl = this.buildSidecarWsUrl('/input');
    return new WebSocket(wsUrl);
  }

  close() {
    if (this.tokenCleanupTimer) {
      clearInterval(this.tokenCleanupTimer);
      this.tokenCleanupTimer = null;
    }
    this.sessionTokens.clear();
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
