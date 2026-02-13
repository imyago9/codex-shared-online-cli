const express = require('express');

function createAuthRoutes(authManager) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      enabled: authManager.isEnabled(),
      authenticated: authManager.isAuthenticatedRequest(req)
    });
  });

  router.post('/login', (req, res) => {
    if (!authManager.isEnabled()) {
      return res.status(400).json({ error: 'Authentication is disabled.' });
    }

    const body = req.body || {};
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return res.status(400).json({ error: 'password is required.' });
    }

    const validPassword = authManager.verifyPassword(password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    authManager.issueSession(res);
    return res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    authManager.clearSession(req, res);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = { createAuthRoutes };
