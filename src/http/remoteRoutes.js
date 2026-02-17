const express = require('express');
const { normalizeMode } = require('../remote/remoteClient');

function createRemoteRoutes(remoteClient, options = {}) {
  const logger = options.logger;
  const router = express.Router();

  router.get('/remote/status', async (_req, res, next) => {
    try {
      const status = await remoteClient.getStatus();
      return res.json(status);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/remote/capabilities', async (_req, res, next) => {
    try {
      const status = await remoteClient.getStatus();
      return res.json({
        enabled: status.enabled === true,
        defaultMode: status.defaultMode,
        sidecarReachable: status.sidecar.reachable === true,
        controlAvailable: status.sidecar.inputAvailable === true,
        streamFps: status.streamFps,
        jpegQuality: status.jpegQuality,
        inputRateLimitPerSec: status.inputRateLimitPerSec,
        tokenTtlMs: status.tokenTtlMs
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/remote/token', async (req, res, next) => {
    try {
      if (!remoteClient.isEnabled()) {
        return res.status(404).json({ error: 'Remote capability is disabled' });
      }

      const status = await remoteClient.getStatus({ forceHealthCheck: true });
      if (!status.sidecar.reachable) {
        return res.status(503).json({
          error: 'Remote sidecar is unreachable',
          reason: status.sidecar.reason || 'sidecar-offline'
        });
      }

      const body = req.body || {};
      const requestedMode = normalizeMode(body.mode, status.defaultMode || 'view');
      const controlRequested = requestedMode === 'control';
      const controlAllowed = status.sidecar.inputAvailable === true;

      const issued = remoteClient.issueSessionToken({
        mode: requestedMode,
        controlAllowed,
        ip: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null,
        userAgent: req.headers['user-agent'] || null
      });

      if (logger) {
        logger.info('Remote session token issued', {
          requestedMode,
          effectiveMode: issued.mode,
          controlAllowed,
          controlRequested
        });
      }

      return res.status(201).json({
        token: issued.token,
        wsPath: '/ws/remote',
        expiresAt: issued.expiresAt,
        ttlMs: issued.ttlMs,
        mode: issued.mode,
        controlAllowed: issued.controlAllowed,
        sidecarReachable: true,
        inputAvailable: controlAllowed
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createRemoteRoutes };
