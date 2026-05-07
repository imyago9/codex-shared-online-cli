const express = require('express');

function createRemoteRoutes(remoteClient) {
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
      return res.json(remoteClient.getCapabilities(status));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createRemoteRoutes };
