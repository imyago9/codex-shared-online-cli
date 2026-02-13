const express = require('express');

function isSafeSessionId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function createSessionRoutes(sessionManager, codexSessionIndex) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalSessions: sessionManager.listSessions().length,
      defaultSessionId: sessionManager.defaultSessionId,
      singleConsoleMode: sessionManager.singleConsoleMode === true
    });
  });

  router.get('/sessions', (_req, res) => {
    res.json({
      sessions: sessionManager.listSessions(),
      defaultSessionId: sessionManager.defaultSessionId,
      singleConsoleMode: sessionManager.singleConsoleMode === true
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

      const session = sessionManager.createSession({
        name: name || undefined
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

  router.get('/codex/sessions', async (req, res, next) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      const result = await codexSessionIndex.listSessions({
        force,
        limit: req.query.limit,
        search: req.query.search,
        cwd: req.query.cwd,
        resumable: req.query.resumable
      });

      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/codex/sessions/:codexSessionId', async (req, res, next) => {
    try {
      const codexSession = await codexSessionIndex.getSessionById(req.params.codexSessionId);
      if (!codexSession) {
        return res.status(404).json({ error: 'Codex session not found' });
      }

      return res.json({ session: codexSession });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/codex/sessions/:codexSessionId/resume', async (req, res, next) => {
    try {
      const codexSessionId = req.params.codexSessionId;
      if (!isSafeSessionId(codexSessionId)) {
        return res.status(400).json({ error: 'Invalid Codex session id format' });
      }

      const codexSession = await codexSessionIndex.getSessionById(codexSessionId);
      if (!codexSession) {
        return res.status(404).json({ error: 'Codex session not found' });
      }

      if (codexSession.isResumable === false) {
        return res.status(409).json({
          error: codexSession.resumeReason || 'Codex session is indexed but not resumable in local CLI history.'
        });
      }

      const body = req.body || {};
      const terminalSessionId = sessionManager.singleConsoleMode
        ? sessionManager.defaultSessionId
        : (typeof body.terminalSessionId === 'string' ? body.terminalSessionId : sessionManager.defaultSessionId);

      const command = typeof codexSession.resumeCommand === 'string'
        ? codexSession.resumeCommand
        : `codex resume ${codexSessionId}`;
      const wrote = sessionManager.writeCommandToSession(terminalSessionId, command);
      if (wrote === null) {
        return res.status(404).json({ error: 'Target terminal session not found' });
      }
      if (wrote === false) {
        return res.status(502).json({ error: 'Failed to enqueue resume command in terminal session' });
      }

      return res.status(202).json({
        ok: true,
        terminalSessionId,
        codexSessionId,
        command
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSessionRoutes };
