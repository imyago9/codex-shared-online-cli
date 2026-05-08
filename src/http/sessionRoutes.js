const express = require('express');

function createSessionRoutes(sessionManager) {
  const router = express.Router();
  const terminalProfiles = () => ['powershell'];

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalSessions: sessionManager.listSessions().length,
      defaultSessionId: sessionManager.defaultSessionId,
      singleConsoleMode: sessionManager.singleConsoleMode === true,
      defaultTerminalProfile: sessionManager.defaultTerminalProfile,
      terminalProfiles: terminalProfiles()
    });
  });

  router.get('/sessions', (_req, res) => {
    res.json({
      sessions: sessionManager.listSessions(),
      defaultSessionId: sessionManager.defaultSessionId,
      singleConsoleMode: sessionManager.singleConsoleMode === true,
      defaultTerminalProfile: sessionManager.defaultTerminalProfile,
      terminalProfiles: terminalProfiles()
    });
  });

  router.get('/sessions/:sessionId', (req, res) => {
    const targetSessionId = sessionManager.singleConsoleMode
      ? sessionManager.defaultSessionId
      : req.params.sessionId;
    const session = sessionManager.getSession(targetSessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({ session: session.getSnapshot() });
  });

  router.post('/sessions', (req, res, next) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const terminalProfile = typeof body.terminalProfile === 'string'
        ? body.terminalProfile.trim()
        : (typeof body.shellType === 'string' ? body.shellType.trim() : '');
      if (terminalProfile && terminalProfile.toLowerCase() !== 'powershell') {
        return res.status(400).json({ error: 'Only native PowerShell terminal sessions are supported' });
      }

      const session = sessionManager.createSession({
        name: name || undefined,
        terminalProfile: 'powershell'
      });

      return res.status(201).json({
        session: session.getSnapshot(),
        defaultSessionId: sessionManager.defaultSessionId
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/sessions/:sessionId/restart', (req, res) => {
    const targetSessionId = sessionManager.singleConsoleMode
      ? sessionManager.defaultSessionId
      : req.params.sessionId;
    const session = sessionManager.restartSession(targetSessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({ session: session.getSnapshot() });
  });

  router.delete('/sessions/:sessionId', (req, res, next) => {
    try {
      const removed = sessionManager.deleteSession(req.params.sessionId);
      if (!removed) {
        return res.status(404).json({ error: 'Session not found' });
      }

      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/sessions/:sessionId/command', (req, res) => {
    const body = req.body || {};
    const command = typeof body.command === 'string' ? body.command : '';
    const normalized = command.trim();

    if (!normalized) {
      return res.status(400).json({ error: 'command is required' });
    }

    if (normalized.length > 2000) {
      return res.status(413).json({ error: 'command is too long' });
    }

    const targetSessionId = sessionManager.singleConsoleMode
      ? sessionManager.defaultSessionId
      : req.params.sessionId;
    const wrote = sessionManager.writeCommandToSession(targetSessionId, normalized);
    if (wrote === null) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (wrote === false) {
      return res.status(502).json({ error: 'Failed to write command to terminal session' });
    }

    return res.status(202).json({ ok: true });
  });

  router.post('/sessions/:sessionId/scroll', (req, res) => {
    const body = req.body || {};
    const rawLines = Number.parseInt(body.lines, 10);
    if (!Number.isFinite(rawLines) || rawLines === 0) {
      return res.status(400).json({ error: 'lines must be a non-zero integer' });
    }

    const lines = Math.max(-400, Math.min(400, rawLines));
    const targetSessionId = sessionManager.singleConsoleMode
      ? sessionManager.defaultSessionId
      : req.params.sessionId;
    const scrolled = sessionManager.scrollSessionHistory(targetSessionId, lines);
    if (scrolled === null) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.status(202).json({ ok: true, lines, applied: scrolled === true });
  });

  return router;
}

module.exports = { createSessionRoutes };
