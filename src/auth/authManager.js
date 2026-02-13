const crypto = require('crypto');

function parseCookies(rawCookieHeader) {
  if (!rawCookieHeader || typeof rawCookieHeader !== 'string') {
    return {};
  }

  const cookies = {};
  const parts = rawCookieHeader.split(';');
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const value = part.slice(separatorIndex + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_error) {
      cookies[key] = value;
    }
  }

  return cookies;
}

function buildCookieValue(name, value, options = {}) {
  const cookieParts = [`${name}=${encodeURIComponent(value)}`];

  cookieParts.push(`Path=${options.path || '/'}`);
  if (Number.isFinite(options.maxAgeSec)) {
    cookieParts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  }
  if (options.httpOnly !== false) {
    cookieParts.push('HttpOnly');
  }

  cookieParts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) {
    cookieParts.push('Secure');
  }

  return cookieParts.join('; ');
}

function compareSecrets(expectedValue, providedValue) {
  const expectedHash = crypto.createHash('sha256').update(String(expectedValue)).digest();
  const providedHash = crypto.createHash('sha256').update(String(providedValue)).digest();
  return crypto.timingSafeEqual(expectedHash, providedHash);
}

class AuthManager {
  constructor(options) {
    this.enabled = options.enabled === true;
    this.password = typeof options.password === 'string' ? options.password : '';
    this.cookieName = options.cookieName || 'online_cli_auth';
    this.sessionTtlMs = Number.isFinite(options.sessionTtlMs)
      ? Math.max(Math.floor(options.sessionTtlMs), 60_000)
      : 12 * 60 * 60 * 1000;
    this.cookieSecure = options.cookieSecure === true;
    this.logger = options.logger;
    this.activeSessions = new Map();
    this.cleanupTimer = null;

    if (this.enabled && !this.password) {
      throw new Error('AUTH_ENABLED is true but AUTH_PASSWORD is not set.');
    }

    if (this.enabled) {
      const cleanupIntervalMs = Math.max(30_000, Math.min(10 * 60 * 1000, Math.floor(this.sessionTtlMs / 2)));
      this.cleanupTimer = setInterval(() => {
        this.pruneExpiredSessions();
      }, cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  isEnabled() {
    return this.enabled;
  }

  pruneExpiredSessions() {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    for (const [token, session] of this.activeSessions.entries()) {
      if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now) {
        this.activeSessions.delete(token);
      }
    }
  }

  getTokenFromRequest(req) {
    const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
    return cookies[this.cookieName] || null;
  }

  validateSessionToken(token, options = {}) {
    if (!this.enabled) {
      return true;
    }
    if (!token || typeof token !== 'string') {
      return false;
    }

    const session = this.activeSessions.get(token);
    if (!session) {
      return false;
    }

    const now = Date.now();
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) {
      this.activeSessions.delete(token);
      return false;
    }

    if (options.extendTtl !== false) {
      session.expiresAt = now + this.sessionTtlMs;
    }

    return true;
  }

  isAuthenticatedRequest(req) {
    if (!this.enabled) {
      return true;
    }
    const token = this.getTokenFromRequest(req);
    return this.validateSessionToken(token);
  }

  issueSession(res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.activeSessions.set(token, { expiresAt });

    const cookie = buildCookieValue(this.cookieName, token, {
      maxAgeSec: Math.floor(this.sessionTtlMs / 1000),
      httpOnly: true,
      sameSite: 'Lax',
      secure: this.cookieSecure,
      path: '/'
    });
    res.setHeader('Set-Cookie', cookie);
  }

  clearSession(req, res) {
    const token = this.getTokenFromRequest(req);
    if (token) {
      this.activeSessions.delete(token);
    }

    const cookie = buildCookieValue(this.cookieName, '', {
      maxAgeSec: 0,
      httpOnly: true,
      sameSite: 'Lax',
      secure: this.cookieSecure,
      path: '/'
    });
    res.setHeader('Set-Cookie', cookie);
  }

  verifyPassword(inputPassword) {
    if (!this.enabled) {
      return true;
    }
    if (typeof inputPassword !== 'string' || inputPassword.length === 0) {
      return false;
    }

    return compareSecrets(this.password, inputPassword);
  }

  requirePageAuth() {
    return (req, res, next) => {
      if (!this.enabled) {
        return next();
      }
      if (this.isAuthenticatedRequest(req)) {
        return next();
      }
      return res.redirect('/login');
    };
  }

  requireApiAuth() {
    return (req, res, next) => {
      if (!this.enabled) {
        return next();
      }
      if (this.isAuthenticatedRequest(req)) {
        return next();
      }
      return res.status(401).json({ error: 'Authentication required.' });
    };
  }

  logAuthEnabled() {
    if (!this.enabled || !this.logger) {
      return;
    }

    this.logger.info('Password authentication enabled', {
      cookieName: this.cookieName,
      sessionTtlMs: this.sessionTtlMs,
      cookieSecure: this.cookieSecure
    });
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.activeSessions.clear();
  }
}

function createAuthManager(options) {
  return new AuthManager({
    enabled: options.enabled,
    password: options.password,
    cookieName: options.cookieName,
    sessionTtlMs: options.sessionTtlMs,
    cookieSecure: options.cookieSecure,
    logger: options.logger
  });
}

module.exports = {
  createAuthManager
};
