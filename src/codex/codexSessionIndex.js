const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const childProcess = require('child_process');

const ACTIVE_EVENT_GAP_CAP_MS = 5 * 60 * 1000;
const KNOWN_TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'tool_call',
  'mcp_tool_call',
  'web_search_call'
]);
const KNOWN_TOOL_CALL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'tool_call_output',
  'mcp_tool_call_output',
  'web_search_call_output'
]);

function parseIsoTime(value) {
  if (typeof value !== 'string') return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function toIsoTime(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

function normalizeCount(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function getFirstDefinedTokenValue(raw, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return raw[key];
    }
  }
  return undefined;
}

function normalizeTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const inputTokensRaw = getFirstDefinedTokenValue(raw, ['input_tokens', 'inputTokens']);
  const cachedInputTokensRaw = getFirstDefinedTokenValue(raw, ['cached_input_tokens', 'cachedInputTokens']);
  const outputTokensRaw = getFirstDefinedTokenValue(raw, ['output_tokens', 'outputTokens']);
  const reasoningOutputTokensRaw = getFirstDefinedTokenValue(raw, ['reasoning_output_tokens', 'reasoningOutputTokens']);
  const totalTokensRaw = getFirstDefinedTokenValue(raw, ['total_tokens', 'totalTokens']);

  const hasKnownFields = [inputTokensRaw, cachedInputTokensRaw, outputTokensRaw, reasoningOutputTokensRaw, totalTokensRaw]
    .some((value) => value !== undefined);
  if (!hasKnownFields) {
    return null;
  }

  const inputTokens = normalizeCount(inputTokensRaw);
  const cachedInputTokens = normalizeCount(cachedInputTokensRaw);
  const outputTokens = normalizeCount(outputTokensRaw);
  const reasoningOutputTokens = normalizeCount(reasoningOutputTokensRaw);
  const explicitTotalTokens = normalizeCount(totalTokensRaw);
  const derivedTotalTokens = inputTokens + outputTokens;
  const totalTokens = Math.max(explicitTotalTokens, derivedTotalTokens);

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function mergeTokenUsage(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;

  const inputTokens = Math.max(normalizeCount(current.inputTokens), normalizeCount(incoming.inputTokens));
  const cachedInputTokens = Math.max(normalizeCount(current.cachedInputTokens), normalizeCount(incoming.cachedInputTokens));
  const outputTokens = Math.max(normalizeCount(current.outputTokens), normalizeCount(incoming.outputTokens));
  const reasoningOutputTokens = Math.max(
    normalizeCount(current.reasoningOutputTokens),
    normalizeCount(incoming.reasoningOutputTokens)
  );
  const totalTokens = Math.max(
    normalizeCount(current.totalTokens),
    normalizeCount(incoming.totalTokens),
    inputTokens + outputTokens
  );

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function extractTokenUsage(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    payload.info && payload.info.total_token_usage,
    payload.info && payload.info.totalTokenUsage,
    payload.info && payload.info.token_usage,
    payload.info && payload.info.tokenUsage,
    payload.total_token_usage,
    payload.totalTokenUsage,
    payload.token_usage,
    payload.tokenUsage
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTokenUsage(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeItemType(type) {
  return typeof type === 'string' ? type.trim().toLowerCase() : '';
}

function isToolCallType(type) {
  const normalized = normalizeItemType(type);
  if (!normalized) return false;
  if (KNOWN_TOOL_CALL_TYPES.has(normalized)) return true;
  return normalized.endsWith('_call') && !normalized.endsWith('_call_output');
}

function isToolCallOutputType(type) {
  const normalized = normalizeItemType(type);
  if (!normalized) return false;
  if (KNOWN_TOOL_CALL_OUTPUT_TYPES.has(normalized)) return true;
  if (normalized.endsWith('_call_output')) return true;
  return normalized.includes('tool') && normalized.endsWith('_output');
}

function getResponsePayloadValue(payload, key) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload[key] === 'string') {
    return payload[key];
  }
  if (payload.item && typeof payload.item === 'object' && typeof payload.item[key] === 'string') {
    return payload.item[key];
  }
  return null;
}

function getSessionElapsedDurationMs(session) {
  const elapsedDurationMs = Number(session && session.elapsedDurationMs);
  if (Number.isFinite(elapsedDurationMs) && elapsedDurationMs > 0) {
    return elapsedDurationMs;
  }

  const durationMs = Number(session && session.durationMs);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    return durationMs;
  }

  return 0;
}

function getSessionActiveDurationMs(session) {
  const activeDurationMs = Number(session && session.activeDurationMs);
  if (Number.isFinite(activeDurationMs) && activeDurationMs > 0) {
    return activeDurationMs;
  }

  return getSessionElapsedDurationMs(session);
}

function getMetricsQualityRank(quality) {
  if (quality === 'complete') return 3;
  if (quality === 'partial') return 2;
  return 1;
}

function getDurationSourceRank(source) {
  if (source === 'events') return 3;
  if (source === 'mixed') return 2;
  return 1;
}

function getResumeStatusRank(session) {
  if (!session || typeof session !== 'object') return 0;
  if (session.isResumable === true && session.resumeStatus !== 'unknown') return 3;
  if (session.resumeStatus === 'unknown') return 2;
  if (session.isResumable === false || session.resumeStatus === 'not_resumable') return 1;
  return 0;
}

function chooseIsoTime(chooser, first, second) {
  const firstTs = parseIsoTime(first);
  const secondTs = parseIsoTime(second);
  const chosenTs = chooser(firstTs, secondTs);
  if (chosenTs === null) {
    return first || second || null;
  }
  return toIsoTime(chosenTs);
}

function chooseEarliestIsoTime(first, second) {
  return chooseIsoTime((firstTs, secondTs) => {
    if (firstTs === null) return secondTs;
    if (secondTs === null) return firstTs;
    return Math.min(firstTs, secondTs);
  }, first, second);
}

function chooseLatestIsoTime(first, second) {
  return chooseIsoTime((firstTs, secondTs) => {
    if (firstTs === null) return secondTs;
    if (secondTs === null) return firstTs;
    return Math.max(firstTs, secondTs);
  }, first, second);
}

function isSessionPreferred(current, candidate) {
  const qualityDiff = getMetricsQualityRank(candidate.metricsQuality) - getMetricsQualityRank(current.metricsQuality);
  if (qualityDiff !== 0) {
    return qualityDiff > 0;
  }

  const resumeDiff = getResumeStatusRank(candidate) - getResumeStatusRank(current);
  if (resumeDiff !== 0) {
    return resumeDiff > 0;
  }

  const candidateTokens = candidate.metrics && candidate.metrics.totalTokenUsage
    ? normalizeCount(candidate.metrics.totalTokenUsage.totalTokens)
    : 0;
  const currentTokens = current.metrics && current.metrics.totalTokenUsage
    ? normalizeCount(current.metrics.totalTokenUsage.totalTokens)
    : 0;
  if (candidateTokens !== currentTokens) {
    return candidateTokens > currentTokens;
  }

  const candidateEnded = parseIsoTime(candidate.endedAt) || parseIsoTime(candidate.startedAt) || 0;
  const currentEnded = parseIsoTime(current.endedAt) || parseIsoTime(current.startedAt) || 0;
  return candidateEnded > currentEnded;
}

function mergeSessionMetrics(currentMetrics, incomingMetrics) {
  const current = currentMetrics || {};
  const incoming = incomingMetrics || {};

  return {
    userMessages: Math.max(normalizeCount(current.userMessages), normalizeCount(incoming.userMessages)),
    assistantMessages: Math.max(normalizeCount(current.assistantMessages), normalizeCount(incoming.assistantMessages)),
    toolCalls: Math.max(normalizeCount(current.toolCalls), normalizeCount(incoming.toolCalls)),
    toolCallOutputs: Math.max(normalizeCount(current.toolCallOutputs), normalizeCount(incoming.toolCallOutputs)),
    reasoningEvents: Math.max(normalizeCount(current.reasoningEvents), normalizeCount(incoming.reasoningEvents)),
    tokenCountEvents: Math.max(normalizeCount(current.tokenCountEvents), normalizeCount(incoming.tokenCountEvents)),
    tokenUsageEventsWithTotals: Math.max(
      normalizeCount(current.tokenUsageEventsWithTotals),
      normalizeCount(incoming.tokenUsageEventsWithTotals)
    ),
    tokenUsageEventsMissingTotals: Math.max(
      normalizeCount(current.tokenUsageEventsMissingTotals),
      normalizeCount(incoming.tokenUsageEventsMissingTotals)
    ),
    totalTokenUsage: mergeTokenUsage(current.totalTokenUsage, incoming.totalTokenUsage)
  };
}

function resolveResumeState(sessions) {
  const normalized = sessions.map((session) => {
    if (!session || typeof session !== 'object') {
      return 'unknown';
    }
    if (session.resumeStatus === 'unknown') {
      return 'unknown';
    }
    if (session.isResumable === false || session.resumeStatus === 'not_resumable') {
      return 'not_resumable';
    }
    return 'resumable';
  });

  if (normalized.includes('resumable')) {
    return 'resumable';
  }
  if (normalized.includes('not_resumable')) {
    return 'not_resumable';
  }
  return 'unknown';
}

function resolveMetricsQuality(session) {
  const metrics = session && session.metrics ? session.metrics : {};
  const hasTokenUsage = Boolean(metrics.totalTokenUsage);
  const hasEventDuration = (session && session.elapsedDurationSource) === 'events';
  const hasAnyStructuredSignals = hasTokenUsage ||
    normalizeCount(metrics.tokenCountEvents) > 0 ||
    normalizeCount(metrics.userMessages) > 0 ||
    normalizeCount(metrics.assistantMessages) > 0 ||
    normalizeCount(metrics.toolCalls) > 0 ||
    normalizeCount(metrics.reasoningEvents) > 0;

  if (hasTokenUsage && hasEventDuration) {
    return 'complete';
  }
  if (hasAnyStructuredSignals || hasEventDuration) {
    return 'partial';
  }
  return 'estimated';
}

function mergeSessions(currentSession, incomingSession) {
  const preferred = isSessionPreferred(currentSession, incomingSession) ? incomingSession : currentSession;
  const secondary = preferred === currentSession ? incomingSession : currentSession;
  const mergedMetrics = mergeSessionMetrics(currentSession.metrics, incomingSession.metrics);

  const mergedStartedAt = chooseEarliestIsoTime(currentSession.startedAt, incomingSession.startedAt);
  const mergedEndedAt = chooseLatestIsoTime(currentSession.endedAt, incomingSession.endedAt);
  const mergedStartTs = parseIsoTime(mergedStartedAt);
  const mergedEndTs = parseIsoTime(mergedEndedAt);
  const mergedElapsedDurationMs = Math.max(
    getSessionElapsedDurationMs(currentSession),
    getSessionElapsedDurationMs(incomingSession),
    mergedStartTs !== null && mergedEndTs !== null && mergedEndTs >= mergedStartTs ? mergedEndTs - mergedStartTs : 0
  );

  const rawMergedActiveDurationMs = Math.max(
    getSessionActiveDurationMs(currentSession),
    getSessionActiveDurationMs(incomingSession)
  );
  const mergedActiveDurationMs = mergedElapsedDurationMs > 0
    ? Math.min(rawMergedActiveDurationMs, mergedElapsedDurationMs)
    : rawMergedActiveDurationMs;

  const resumeState = resolveResumeState([currentSession, incomingSession]);
  const resumableSession = [preferred, secondary]
    .find((session) => session && session.isResumable === true && session.resumeStatus !== 'unknown');
  const nonResumableSession = [preferred, secondary]
    .find((session) => session && (session.isResumable === false || session.resumeStatus === 'not_resumable'));

  const stores = Array.from(new Set([
    ...(Array.isArray(currentSession.storeCodexHomes) ? currentSession.storeCodexHomes : []),
    ...(Array.isArray(incomingSession.storeCodexHomes) ? incomingSession.storeCodexHomes : []),
    currentSession.storeCodexHome,
    incomingSession.storeCodexHome
  ].filter(Boolean)));

  const merged = {
    ...secondary,
    ...preferred,
    startedAt: mergedStartedAt,
    endedAt: mergedEndedAt,
    elapsedDurationMs: mergedElapsedDurationMs,
    activeDurationMs: mergedActiveDurationMs,
    durationMs: mergedElapsedDurationMs,
    elapsedDurationSource: getDurationSourceRank(incomingSession.elapsedDurationSource) >
      getDurationSourceRank(currentSession.elapsedDurationSource)
      ? incomingSession.elapsedDurationSource
      : currentSession.elapsedDurationSource,
    metrics: mergedMetrics,
    historyMessageCount: Math.max(
      normalizeCount(currentSession.historyMessageCount),
      normalizeCount(incomingSession.historyMessageCount)
    ),
    lastPromptAt: chooseLatestIsoTime(currentSession.lastPromptAt, incomingSession.lastPromptAt),
    duplicateCount: Math.max(1, normalizeCount(currentSession.duplicateCount)) +
      Math.max(1, normalizeCount(incomingSession.duplicateCount)),
    storeCodexHomes: stores
  };

  if (resumeState === 'resumable') {
    merged.isResumable = true;
    merged.resumeStatus = 'resumable';
    merged.resumeReason = null;
    if (resumableSession) {
      merged.resumeCommand = resumableSession.resumeCommand || merged.resumeCommand;
      merged.resumeCommandWithCwd = resumableSession.resumeCommandWithCwd || merged.resumeCommandWithCwd;
      merged.storeHistoryPath = resumableSession.storeHistoryPath || merged.storeHistoryPath;
      merged.storeCodexHome = resumableSession.storeCodexHome || merged.storeCodexHome;
      merged.storeSessionsRoot = resumableSession.storeSessionsRoot || merged.storeSessionsRoot;
    }
  } else if (resumeState === 'not_resumable') {
    merged.isResumable = false;
    merged.resumeStatus = 'not_resumable';
    merged.resumeReason = (nonResumableSession && nonResumableSession.resumeReason) ||
      merged.resumeReason ||
      'Not present in local Codex history.jsonl, so codex resume may reject this id.';
  } else {
    merged.isResumable = true;
    merged.resumeStatus = 'unknown';
    merged.resumeReason = merged.resumeReason ||
      'No history.jsonl was found for this Codex store. Resume will be attempted directly.';
  }

  merged.metricsQuality = resolveMetricsQuality(merged);
  return merged;
}

function dedupeSessionsById(sessions) {
  const byId = new Map();
  let duplicateEntries = 0;

  for (const session of sessions) {
    const key = session && typeof session.id === 'string' && session.id
      ? session.id
      : `${session.filePath}:${session.fileName}`;

    if (!byId.has(key)) {
      byId.set(key, {
        ...session,
        storeCodexHomes: [session.storeCodexHome].filter(Boolean),
        duplicateCount: 1
      });
      continue;
    }

    duplicateEntries += 1;
    const merged = mergeSessions(byId.get(key), session);
    byId.set(key, merged);
  }

  return {
    sessions: Array.from(byId.values()),
    duplicateEntries
  };
}

function extractSessionIdFromFilename(filePath) {
  const fileName = path.basename(filePath);
  const match = fileName.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : null;
}

function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildResumeCommand(sessionId) {
  return `codex resume ${sessionId}`;
}

function normalizeCwdForWsl(cwd) {
  if (typeof cwd !== 'string') {
    return null;
  }

  let trimmed = cwd.trim();
  if (!trimmed) {
    return null;
  }

  // Normalize WSL UNC path, e.g. \\wsl.localhost\Ubuntu\home\user\.codex
  // (or legacy \\wsl$\Ubuntu\...) into Linux path.
  const wslUncMatch = trimmed.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.+)$/i);
  if (wslUncMatch && wslUncMatch[1]) {
    return `/${wslUncMatch[1].replace(/\\/g, '/')}`;
  }

  // Normalize Windows extended-length prefix, e.g. \\?\C:\Users\...
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(trimmed)) {
    trimmed = trimmed.slice(4);
  }

  if (trimmed.startsWith('/mnt/')) {
    return trimmed;
  }

  const drivePathMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (drivePathMatch) {
    const drive = drivePathMatch[1].toLowerCase();
    const rest = drivePathMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  return trimmed;
}

function buildResumeShellCommand(sessionId, options = {}) {
  const codexHome = normalizeCwdForWsl(options.codexHome) || '';
  const cwd = normalizeCwdForWsl(options.cwd);
  const envPrefix = codexHome ? `CODEX_HOME=${quoteShellArg(codexHome)} ` : '';
  const baseCommand = `${envPrefix}${buildResumeCommand(sessionId)}`;

  if (cwd) {
    const quotedCwd = quoteShellArg(cwd);
    return `if [ -d ${quotedCwd} ]; then ${baseCommand} -C ${quotedCwd}; else ${baseCommand}; fi`;
  }

  return baseCommand;
}

function walkSessionFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && fullPath.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

async function parseSessionFile(filePath) {
  const stat = fs.statSync(filePath);

  const metrics = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolCallOutputs: 0,
    reasoningEvents: 0,
    tokenCountEvents: 0,
    tokenUsageEventsWithTotals: 0,
    tokenUsageEventsMissingTotals: 0,
    totalTokenUsage: null
  };

  const session = {
    id: extractSessionIdFromFilename(filePath),
    filePath,
    fileName: path.basename(filePath),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    elapsedDurationMs: null,
    activeDurationMs: 0,
    elapsedDurationSource: 'filesystem',
    cwd: null,
    model: null,
    cliVersion: null,
    source: null,
    modelProvider: null,
    isResumable: true,
    resumeReason: null,
    resumeStatus: 'resumable',
    historyMessageCount: 0,
    lastPromptAt: null,
    preferredCwd: null,
    storeCodexHome: null,
    storeSessionsRoot: null,
    storeHistoryPath: null,
    storeCodexHomes: [],
    duplicateCount: 1,
    metricsQuality: 'estimated',
    resumeCommandWithCwd: null,
    metrics
  };

  let minEventTimestamp = null;
  let maxEventTimestamp = null;
  let previousEventTimestamp = null;
  let activeDurationMs = 0;

  const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch (_error) {
      continue;
    }

    const eventTimestamp = parseIsoTime(event.timestamp);
    if (eventTimestamp !== null) {
      if (minEventTimestamp === null || eventTimestamp < minEventTimestamp) {
        minEventTimestamp = eventTimestamp;
      }
      if (maxEventTimestamp === null || eventTimestamp > maxEventTimestamp) {
        maxEventTimestamp = eventTimestamp;
      }
      if (previousEventTimestamp !== null) {
        const gap = eventTimestamp - previousEventTimestamp;
        if (gap > 0) {
          activeDurationMs += Math.min(gap, ACTIVE_EVENT_GAP_CAP_MS);
        }
      }
      previousEventTimestamp = eventTimestamp;
    }

    if (event.type === 'session_meta' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload;
      if (typeof payload.id === 'string' && payload.id.length > 0) {
        session.id = payload.id;
      }
      if (typeof payload.cwd === 'string') {
        session.cwd = payload.cwd;
      }
      if (typeof payload.cli_version === 'string') {
        session.cliVersion = payload.cli_version;
      }
      if (typeof payload.source === 'string') {
        session.source = payload.source;
      }
      if (typeof payload.model_provider === 'string') {
        session.modelProvider = payload.model_provider;
      }
      continue;
    }

    if (event.type === 'turn_context' && event.payload && typeof event.payload === 'object') {
      if (!session.model && typeof event.payload.model === 'string') {
        session.model = event.payload.model;
      }
      continue;
    }

    if (event.type === 'response_item' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload;
      const payloadType = getResponsePayloadValue(payload, 'type');
      const payloadRole = getResponsePayloadValue(payload, 'role');

      if (payloadType === 'message') {
        if (payloadRole === 'user') {
          metrics.userMessages += 1;
        } else if (payloadRole === 'assistant') {
          metrics.assistantMessages += 1;
        }
      } else if (isToolCallType(payloadType)) {
        metrics.toolCalls += 1;
      } else if (isToolCallOutputType(payloadType)) {
        metrics.toolCallOutputs += 1;
      }

      continue;
    }

    if (event.type === 'event_msg' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload;

      if (payload.type === 'agent_reasoning') {
        metrics.reasoningEvents += 1;
      }

      if (payload.type === 'token_count') {
        metrics.tokenCountEvents += 1;

        const totalTokenUsage = extractTokenUsage(payload);

        if (totalTokenUsage) {
          metrics.tokenUsageEventsWithTotals += 1;
          metrics.totalTokenUsage = mergeTokenUsage(metrics.totalTokenUsage, totalTokenUsage);
        } else {
          metrics.tokenUsageEventsMissingTotals += 1;
        }
      }
    }
  }

  const startTs = minEventTimestamp !== null ? minEventTimestamp : stat.birthtimeMs;
  const endTs = maxEventTimestamp !== null ? maxEventTimestamp : stat.mtimeMs;

  session.startedAt = toIsoTime(startTs);
  session.endedAt = toIsoTime(endTs);
  session.elapsedDurationSource = minEventTimestamp !== null && maxEventTimestamp !== null
    ? 'events'
    : (minEventTimestamp !== null || maxEventTimestamp !== null ? 'mixed' : 'filesystem');

  if (Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= startTs) {
    session.durationMs = endTs - startTs;
    session.elapsedDurationMs = session.durationMs;
  } else {
    session.durationMs = 0;
    session.elapsedDurationMs = 0;
  }
  session.activeDurationMs = Math.max(0, Math.min(activeDurationMs, session.elapsedDurationMs || activeDurationMs));

  if (!session.id) {
    session.id = `${path.basename(filePath)}-${Math.trunc(stat.mtimeMs)}`;
  }

  session.preferredCwd = normalizeCwdForWsl(session.cwd);
  session.resumeCommand = buildResumeCommand(session.id);
  session.resumeCommandWithCwd = buildResumeCommand(session.id);
  session.metricsQuality = resolveMetricsQuality(session);

  return session;
}

async function loadHistoryIndex(historyPath) {
  const index = new Map();
  if (!fs.existsSync(historyPath)) {
    return index;
  }

  const readStream = fs.createReadStream(historyPath, { encoding: 'utf8' });
  const lines = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch (_error) {
      continue;
    }

    if (!event || typeof event !== 'object') continue;

    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    if (!sessionId) continue;

    const existing = index.get(sessionId) || {
      messageCount: 0,
      lastPromptAt: null,
      lastPromptTsMs: 0
    };

    existing.messageCount += 1;

    const tsSeconds = Number(event.ts);
    const tsMs = Number.isFinite(tsSeconds) ? (tsSeconds * 1000) : 0;
    if (tsMs > existing.lastPromptTsMs) {
      existing.lastPromptTsMs = tsMs;
      existing.lastPromptAt = new Date(tsMs).toISOString();
    }

    index.set(sessionId, existing);
  }

  return index;
}

function toSummary(sessions, scannedAt, sessionsRoot, sessionsRoots, storeHistoryStats) {
  const storeCount = Array.isArray(sessionsRoots) ? sessionsRoots.length : 0;
  const storesWithHistory = storeHistoryStats && Number.isFinite(storeHistoryStats.withHistory)
    ? storeHistoryStats.withHistory
    : 0;

  const summary = {
    scannedAt,
    sessionsRoot,
    sessionsRoots: Array.isArray(sessionsRoots) ? sessionsRoots.slice() : [],
    storeCount,
    storesWithHistory,
    historyAvailable: storesWithHistory > 0,
    historyPartiallyAvailable: storesWithHistory > 0 && storesWithHistory < storeCount,
    historyPath: null,
    sessionCount: sessions.length,
    resumableSessionCount: 0,
    unknownResumableSessionCount: 0,
    nonResumableSessionCount: 0,
    uniqueDirectories: 0,
    totalUserMessages: 0,
    totalAssistantMessages: 0,
    totalToolCalls: 0,
    totalTokens: 0,
    totalElapsedDurationMs: 0,
    totalActiveDurationMs: 0,
    averageElapsedDurationMs: 0,
    averageActiveDurationMs: 0,
    duplicateSessionEntries: Number(storeHistoryStats && storeHistoryStats.duplicateSessionEntries) || 0,
    completeMetricsSessionCount: 0,
    partialMetricsSessionCount: 0,
    estimatedMetricsSessionCount: 0
  };

  const cwdSet = new Set();

  for (const session of sessions) {
    if (session.cwd) {
      cwdSet.add(session.cwd);
    }

    if (session.resumeStatus === 'unknown') {
      summary.unknownResumableSessionCount += 1;
    } else if (session.isResumable === false) {
      summary.nonResumableSessionCount += 1;
    } else {
      summary.resumableSessionCount += 1;
    }

    summary.totalUserMessages += session.metrics.userMessages;
    summary.totalAssistantMessages += session.metrics.assistantMessages;
    summary.totalToolCalls += session.metrics.toolCalls;
    summary.totalTokens += session.metrics.totalTokenUsage ? session.metrics.totalTokenUsage.totalTokens : 0;
    summary.totalElapsedDurationMs += getSessionElapsedDurationMs(session);
    summary.totalActiveDurationMs += getSessionActiveDurationMs(session);

    if (session.metricsQuality === 'complete') {
      summary.completeMetricsSessionCount += 1;
    } else if (session.metricsQuality === 'partial') {
      summary.partialMetricsSessionCount += 1;
    } else {
      summary.estimatedMetricsSessionCount += 1;
    }
  }

  summary.uniqueDirectories = cwdSet.size;
  if (summary.sessionCount > 0) {
    summary.averageElapsedDurationMs = Math.round(summary.totalElapsedDurationMs / summary.sessionCount);
    summary.averageActiveDurationMs = Math.round(summary.totalActiveDurationMs / summary.sessionCount);
  }
  return summary;
}

class CodexSessionIndex {
  constructor(options = {}) {
    const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

    this.defaultShell = options.defaultShell || process.env.PTY_COMMAND || '';
    this.primaryCodexHome = codexHome;
    this.sessionsRootCandidates = this._buildSessionsRootCandidates(options, codexHome);
    this.sessionsRoots = this._resolveExistingSessionsRoots();
    this.sessionsRoot = this.sessionsRoots[0] || (this.sessionsRootCandidates[0] || path.join(os.homedir(), '.codex', 'sessions'));
    this.historyPathCandidates = this._buildHistoryPathCandidates(options);
    this.historyPath = this._resolveExistingHistoryPath(this.sessionsRoot) || null;
    this.refreshTtlMs = Math.max(Number(options.refreshTtlMs) || 20_000, 2_000);
    this.logger = options.logger;
    this.historyAvailable = Boolean(this.historyPath);

    this.cache = {
      scannedAt: null,
      scannedAtTs: 0,
      sessions: [],
      summary: toSummary([], null, this.sessionsRoot, this.sessionsRoots, { withHistory: this.historyAvailable ? 1 : 0 })
    };
    this.cache.summary.historyPath = this.historyPath;

    this.refreshPromise = null;
  }

  async listSessions(options = {}) {
    await this.refresh({ force: options.force === true });

    let sessions = this.cache.sessions;

    const resumableFilter = typeof options.resumable === 'string'
      ? options.resumable.trim().toLowerCase()
      : null;
    if (resumableFilter === '1' || resumableFilter === 'true') {
      sessions = sessions.filter((session) => session.isResumable !== false);
    } else if (resumableFilter === '0' || resumableFilter === 'false') {
      sessions = sessions.filter((session) => session.isResumable === false);
    }

    const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
    if (search) {
      sessions = sessions.filter((session) => {
        const fields = [
          session.id,
          session.cwd,
          session.model,
          session.cliVersion,
          session.fileName,
          session.storeCodexHome
        ].filter(Boolean).join(' ').toLowerCase();

        return fields.includes(search);
      });
    }

    if (typeof options.cwd === 'string' && options.cwd.trim()) {
      sessions = sessions.filter((session) => session.cwd === options.cwd.trim());
    }

    const limitOption = typeof options.limit === 'string' ? options.limit.trim().toLowerCase() : options.limit;
    const wantsAll = limitOption === 'all' || limitOption === '*';

    let limit = 200;
    if (wantsAll) {
      limit = sessions.length;
    } else {
      const limitRaw = Number.parseInt(options.limit, 10);
      limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;
    }

    return {
      sessions: sessions.slice(0, limit),
      summary: this.cache.summary,
      scannedAt: this.cache.scannedAt,
      sessionsRoot: this.sessionsRoot,
      sessionsRoots: this.sessionsRoots.slice()
    };
  }

  async getSessionById(sessionId, options = {}) {
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }

    await this.refresh({ force: options.force === true });
    return this.cache.sessions.find((session) => session.id === sessionId) || null;
  }

  async refresh(options = {}) {
    const force = options.force === true;
    const now = Date.now();

    if (!force && this.cache.scannedAtTs > 0 && (now - this.cache.scannedAtTs) < this.refreshTtlMs) {
      return;
    }

    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this._refreshInternal();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async _refreshInternal() {
    this.sessionsRoots = this._resolveExistingSessionsRoots();
    this.sessionsRoot = this.sessionsRoots[0] || this.sessionsRoot;
    const scannedAt = new Date().toISOString();
    const sessions = [];
    let storesWithHistory = 0;
    let firstHistoryPath = null;

    for (const sessionsRoot of this.sessionsRoots) {
      const files = walkSessionFiles(sessionsRoot);
      const storeCodexHome = path.dirname(sessionsRoot);
      const historyPath = this._resolveExistingHistoryPath(sessionsRoot);
      const historyAvailable = Boolean(historyPath);
      const historyIndex = historyAvailable ? await loadHistoryIndex(historyPath) : new Map();

      if (historyAvailable) {
        storesWithHistory += 1;
        if (!firstHistoryPath) {
          firstHistoryPath = historyPath;
        }
      }

      for (const filePath of files) {
        try {
          const session = await parseSessionFile(filePath);
          session.storeSessionsRoot = sessionsRoot;
          session.storeCodexHome = storeCodexHome;
          session.storeHistoryPath = historyPath || null;
          session.preferredCwd = normalizeCwdForWsl(session.cwd);

          const historyEntry = historyAvailable ? historyIndex.get(session.id) : null;
          if (!historyAvailable) {
            session.isResumable = true;
            session.resumeStatus = 'unknown';
            session.resumeReason = 'No history.jsonl was found for this Codex store. Resume will be attempted directly.';
            session.historyMessageCount = 0;
            session.lastPromptAt = null;
          } else if (historyEntry) {
            session.isResumable = true;
            session.resumeStatus = 'resumable';
            session.resumeReason = null;
            session.historyMessageCount = historyEntry.messageCount;
            session.lastPromptAt = historyEntry.lastPromptAt;
          } else {
            session.isResumable = false;
            session.resumeStatus = 'not_resumable';
            session.resumeReason = 'Not present in local Codex history.jsonl, so codex resume may reject this id.';
            session.historyMessageCount = 0;
            session.lastPromptAt = null;
          }

          session.resumeCommand = buildResumeShellCommand(session.id, {
            codexHome: session.storeCodexHome,
            cwd: session.preferredCwd
          });
          session.resumeCommandWithCwd = session.resumeCommand;

          sessions.push(session);
        } catch (error) {
          if (this.logger) {
            this.logger.warn('Failed to parse Codex session file', {
              filePath,
              message: error.message
            });
          }
        }
      }
    }

    this.historyPath = firstHistoryPath;
    this.historyAvailable = storesWithHistory > 0;

    const dedupeResult = dedupeSessionsById(sessions);
    const dedupedSessions = dedupeResult.sessions;

    dedupedSessions.sort((a, b) => {
      const aTs = parseIsoTime(a.endedAt) || parseIsoTime(a.startedAt) || 0;
      const bTs = parseIsoTime(b.endedAt) || parseIsoTime(b.startedAt) || 0;
      return bTs - aTs;
    });

    this.cache = {
      scannedAt,
      scannedAtTs: Date.now(),
      sessions: dedupedSessions,
      summary: toSummary(dedupedSessions, scannedAt, this.sessionsRoot, this.sessionsRoots, {
        withHistory: storesWithHistory,
        duplicateSessionEntries: dedupeResult.duplicateEntries
      })
    };
    this.cache.summary.historyPath = this.historyPath || null;
  }

  _buildHistoryPathCandidates(options) {
    const candidates = [];

    const push = (value) => {
      if (typeof value !== 'string') return;
      const normalized = value.trim();
      if (!normalized) return;
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    push(options.historyPath);
    push(process.env.CODEX_HISTORY_FILE);

    return candidates;
  }

  _buildSessionsRootCandidates(options, codexHome) {
    const candidates = [];
    const preferred = [];

    const pushUnique = (list, value) => {
      if (typeof value !== 'string') return;
      const normalized = value.trim();
      if (!normalized) return;
      if (!preferred.includes(normalized) && !candidates.includes(normalized)) {
        list.push(normalized);
      }
    };

    const pushMany = (list, values) => {
      if (!Array.isArray(values)) return;
      for (const value of values) {
        pushUnique(list, value);
      }
    };

    const extraRoots = String(process.env.CODEX_EXTRA_SESSIONS_DIRS || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean);

    pushUnique(preferred, options.sessionsRoot);
    pushUnique(preferred, process.env.CODEX_SESSIONS_DIR);
    pushMany(preferred, extraRoots);

    const shell = String(this.defaultShell || '').toLowerCase();
    const wslRoot = this._detectWslCodexHomeWindows();
    const useWslOnly = process.platform === 'win32' && (shell.includes('wsl') || shell.endsWith('wsl.exe'));
    if (wslRoot && useWslOnly) {
      pushUnique(preferred, path.join(wslRoot, 'sessions'));
      return [...preferred, ...candidates];
    }

    if (wslRoot) {
      pushUnique(candidates, path.join(wslRoot, 'sessions'));
    }

    pushUnique(candidates, path.join(codexHome, 'sessions'));
    pushUnique(candidates, path.join(os.homedir(), '.codex', 'sessions'));

    return [...preferred, ...candidates];
  }

  _detectWslCodexHomeWindows() {
    if (process.platform !== 'win32') {
      return null;
    }

    const attempts = [
      ['-e', 'sh', '-lc', 'wslpath -w "$HOME/.codex"'],
      ['sh', '-lc', 'wslpath -w "$HOME/.codex"']
    ];

    for (const args of attempts) {
      try {
        const output = childProcess.execFileSync('wsl.exe', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });

        const resolved = String(output || '').replace(/\r/g, '').trim();
        if (resolved) {
          return resolved;
        }
      } catch (_error) {
        continue;
      }
    }

    return null;
  }

  _resolveExistingSessionsRoots() {
    const resolved = [];

    for (const sessionsRoot of this.sessionsRootCandidates) {
      if (fs.existsSync(sessionsRoot)) {
        resolved.push(sessionsRoot);
      }
    }

    if (resolved.length > 0) {
      return resolved;
    }

    return [this.sessionsRootCandidates[0] || path.join(os.homedir(), '.codex', 'sessions')];
  }

  _resolveExistingHistoryPath(sessionsRoot) {
    const dynamicCandidates = [];
    if (typeof sessionsRoot === 'string' && sessionsRoot.trim()) {
      dynamicCandidates.push(path.join(path.dirname(sessionsRoot), 'history.jsonl'));
    }

    for (const historyPath of [...dynamicCandidates, ...this.historyPathCandidates]) {
      if (fs.existsSync(historyPath)) {
        return historyPath;
      }
    }

    return null;
  }

}

module.exports = { CodexSessionIndex };
