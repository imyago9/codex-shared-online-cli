function normalizeRemoteAddress(rawAddress) {
  if (!rawAddress || typeof rawAddress !== 'string') {
    return '';
  }

  let address = rawAddress.trim().toLowerCase();
  if (address.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  return address;
}

function parseIpv4Address(address) {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const parsed = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255 ? value : null;
  });

  if (parsed.some((part) => part === null)) {
    return null;
  }
  return parsed;
}

function isLoopbackAddress(rawAddress) {
  const address = normalizeRemoteAddress(rawAddress);
  if (!address) {
    return false;
  }

  if (address === '::1' || address === '0:0:0:0:0:0:0:1') {
    return true;
  }

  const ipv4 = parseIpv4Address(address);
  return Boolean(ipv4 && ipv4[0] === 127);
}

function isTailscaleAddress(rawAddress) {
  const address = normalizeRemoteAddress(rawAddress);
  if (!address) {
    return false;
  }

  const ipv4 = parseIpv4Address(address);
  if (ipv4) {
    return ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127;
  }

  return address.startsWith('fd7a:115c:a1e0:');
}

function getHostnameFromHostHeader(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') {
    return '';
  }

  const host = rawHost.trim().toLowerCase();
  if (!host) {
    return '';
  }

  if (host.startsWith('[')) {
    const closingIndex = host.indexOf(']');
    return closingIndex > 0 ? host.slice(1, closingIndex) : '';
  }

  return host.split(':')[0].replace(/\.$/, '');
}

function getHostnamesFromHeaderValue(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  return rawValue
    .split(',')
    .map((value) => getHostnameFromHostHeader(value))
    .filter(Boolean);
}

function getForwardedHostnames(rawForwardedHeader) {
  if (!rawForwardedHeader || typeof rawForwardedHeader !== 'string') {
    return [];
  }

  const hostnames = [];
  const entries = rawForwardedHeader.split(',');
  for (const entry of entries) {
    const parts = entry.split(';');
    for (const part of parts) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = part.slice(0, separatorIndex).trim().toLowerCase();
      if (key !== 'host') {
        continue;
      }

      const value = part.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '');
      const hostname = getHostnameFromHostHeader(value);
      if (hostname) {
        hostnames.push(hostname);
      }
    }
  }

  return hostnames;
}

function getRequestHostnames(req) {
  const headers = req && req.headers ? req.headers : {};
  return [
    ...getHostnamesFromHeaderValue(headers.host || ''),
    ...getHostnamesFromHeaderValue(headers['x-forwarded-host'] || ''),
    ...getHostnamesFromHeaderValue(headers['x-original-host'] || ''),
    ...getForwardedHostnames(headers.forwarded || '')
  ];
}

function getOriginHostname(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') {
    return '';
  }

  try {
    return new URL(rawOrigin).hostname.toLowerCase().replace(/\.$/, '');
  } catch (_error) {
    return '';
  }
}

function hasTailscaleServeIdentity(req) {
  const headers = req && req.headers ? req.headers : {};
  return Boolean(
    headers['tailscale-user-login']
      || headers['tailscale-user-name']
      || headers['tailscale-user-profile-pic']
      || headers['tailscale-app-capabilities']
  );
}

class TailscaleAccess {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.tailnetHost = typeof options.tailnetHost === 'string'
      ? options.tailnetHost.trim().toLowerCase().replace(/\.$/, '')
      : '';
  }

  isTrustedNetworkRequest(req) {
    const remoteAddress = req && req.socket ? req.socket.remoteAddress : '';
    if (hasTailscaleServeIdentity(req)) {
      return isLoopbackAddress(remoteAddress);
    }

    return isLoopbackAddress(remoteAddress) || isTailscaleAddress(remoteAddress);
  }

  isSameOriginRequest(req) {
    const origin = req && req.headers ? req.headers.origin : '';
    if (!origin) {
      return true;
    }

    const originHostname = getOriginHostname(origin);
    if (!originHostname) {
      return false;
    }

    const requestHostnames = getRequestHostnames(req);
    if (this.tailnetHost && originHostname === this.tailnetHost) {
      return true;
    }
    if (requestHostnames.includes(originHostname)) {
      return true;
    }

    const fetchSite = String(req && req.headers ? req.headers['sec-fetch-site'] : '').toLowerCase();
    return fetchSite === 'same-origin' || fetchSite === 'none';
  }

  checkRequest(req) {
    const servedByTailscale = hasTailscaleServeIdentity(req);
    if (!this.isTrustedNetworkRequest(req)) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'tailscale-required',
        message: 'Tailscale connection required.'
      };
    }

    if (isLoopbackAddress(req && req.socket ? req.socket.remoteAddress : '') && !servedByTailscale) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'tailscale-serve-required',
        message: 'Tailscale Serve connection required.'
      };
    }

    if (!this.isSameOriginRequest(req)) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'same-origin-required',
        message: 'Same-origin request required.'
      };
    }

    return { allowed: true };
  }

  requireHttpAccess() {
    return (req, res, next) => {
      const result = this.checkRequest(req);
      if (result.allowed) {
        return next();
      }

      if (this.logger) {
        this.logger.warn('Blocked request outside Tailscale access policy', {
          code: result.code,
          remoteAddress: req && req.socket ? req.socket.remoteAddress : null,
          host: req && req.headers ? req.headers.host : null,
          origin: req && req.headers ? req.headers.origin : null,
          path: req ? req.path : null
        });
      }

      const wantsJson = (req && req.path && req.path.startsWith('/api/'))
        || String(req && req.headers ? req.headers.accept : '').includes('application/json');
      if (wantsJson) {
        return res.status(result.statusCode).json({
          error: result.message,
          code: result.code
        });
      }

      return res.status(result.statusCode).type('text/plain').send(result.message);
    };
  }

  logAccessMode() {
    if (!this.logger) {
      return;
    }

    this.logger.info('Tailscale access mode configured', {
      tailscaleRequired: true,
      acceptedRemoteAddresses: ['Tailscale Serve identity headers', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
      tailnetHost: this.tailnetHost || null
    });
  }
}

function createTailscaleAccess(options) {
  return new TailscaleAccess(options);
}

module.exports = {
  createTailscaleAccess,
  isLoopbackAddress,
  isTailscaleAddress
};
