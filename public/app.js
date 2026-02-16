const terminalElement = document.getElementById('terminal');
const statusElement = document.getElementById('connection');
const hintElement = document.getElementById('hint');
const localAttachLineElement = document.getElementById('local-attach-line');
const copyAttachCommandButton = document.getElementById('copy-attach-command');
const sessionSelectElement = document.getElementById('session-select');
const createSessionButton = document.getElementById('new-session');
const deleteSessionButton = document.getElementById('delete-session');
const viewPillConsoleElement = document.getElementById('view-pill-console');
const viewPillMetricsElement = document.getElementById('view-pill-metrics');
const consoleViewElement = document.getElementById('console-view');
const metricsViewElement = document.getElementById('metrics-view');
const codexSearchElement = document.getElementById('codex-search');
const codexRefreshElement = document.getElementById('codex-refresh');
const codexSummaryElement = document.getElementById('codex-summary');
const codexStatusElement = document.getElementById('codex-status');
const codexListElement = document.getElementById('codex-list');
const metricsDateScopeElement = document.getElementById('metrics-date-scope');
const metricsMonthElement = document.getElementById('metrics-month');
const metricsFromElement = document.getElementById('metrics-from');
const metricsToElement = document.getElementById('metrics-to');
const metricsStatusElement = document.getElementById('metrics-status');
const metricsModelElement = document.getElementById('metrics-model');
const metricsCwdElement = document.getElementById('metrics-cwd');
const metricsSearchElement = document.getElementById('metrics-search');
const metricsClearElement = document.getElementById('metrics-clear');
const metricsStatusTextElement = document.getElementById('metrics-status-text');
const metricSessionsElement = document.getElementById('metric-sessions');
const metricTokensElement = document.getElementById('metric-tokens');
const metricToolsElement = document.getElementById('metric-tools');
const metricDurationElement = document.getElementById('metric-duration');
const metricsCalendarElement = document.getElementById('metrics-calendar');
const calendarLegendElement = document.getElementById('calendar-legend');
const metricsResultsElement = document.getElementById('metrics-results');
const metricsListElement = document.getElementById('metrics-list');
const scrollSliderElement = document.getElementById('scroll-slider');
const scrollSliderThumbElement = document.getElementById('scroll-slider-thumb');
const terminalFullscreenToggleElement = document.getElementById('terminal-fullscreen-toggle');
const terminalPopoutToggleElement = document.getElementById('terminal-popout-toggle');
const terminalPopoutVideoElement = document.getElementById('terminal-popout-video');
const isLikelyIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const calendarWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const maxMetricsListRows = 220;
const terminalScrollback = 200_000;

const state = {
  socket: null,
  socketGeneration: 0,
  reconnectTimer: null,
  resizeTimer: null,
  terminalResizeObserver: null,
  manualDisconnect: false,
  sessions: [],
  activeSessionId: null,
  activeView: 'console',
  codexSessions: [],
  codexSummary: null,
  codexRefreshTimer: null,
  codexSearchTerm: '',
  codexLoading: false,
  terminalFullscreen: false,
  terminalPopoutActive: false,
  localAttachCommand: '',
  singleConsoleMode: false,
  metricsFilters: {
    dateScope: 'all',
    month: '',
    from: '',
    to: '',
    status: '',
    model: '',
    cwd: '',
    search: '',
    selectedDay: ''
  }
};

const terminalSwipeState = {
  pointerId: null,
  activeTouchId: null,
  startY: 0,
  lastY: 0,
  lastTs: 0,
  isSwiping: false,
  lineAccumulator: 0,
  velocityLinesPerSecond: 0,
  momentumRafId: null,
  lastMomentumTs: 0
};

const serverScrollState = {
  pendingLines: 0,
  flushTimer: null,
  inFlight: false,
  sessionId: null
};

const scrollSliderState = {
  activePointerId: null,
  activeTouchId: null,
  centerX: 0,
  maxOffsetPx: 24,
  offsetPx: 0,
  lineAccumulator: 0,
  lastTickTs: 0,
  tickRafId: null,
  returnRafId: null
};

const viewportResizeState = {
  width: window.visualViewport ? Math.round(window.visualViewport.width) : window.innerWidth,
  height: window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight
};

const terminalPopoutState = {
  canvas: null,
  context: null,
  stream: null,
  renderTimer: null,
  tailLines: [],
  tailPartial: ''
};

const wsTextDecoder = new TextDecoder();
let redirectingToLogin = false;

const term = new Terminal({
  cursorBlink: true,
  scrollback: terminalScrollback,
  fontFamily: '"JetBrains Mono", "Fira Code", "IBM Plex Mono", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 14,
  smoothScrollDuration: 120,
  theme: {
    background: '#0b0d11',
    foreground: '#e6e6e6',
    cursor: '#d97a41',
    selection: 'rgba(217, 122, 65, 0.3)'
  }
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(terminalElement);
fitAddon.fit();

setupTerminalTouchLock();
const scrollSliderController = setupScrollSliderControl();
terminalElement.addEventListener('click', () => {
  term.focus();
});

function updateFullscreenToggleButton() {
  if (!terminalFullscreenToggleElement) {
    return;
  }

  const isFullscreen = state.terminalFullscreen === true;
  terminalFullscreenToggleElement.textContent = isFullscreen ? 'Exit' : 'Fullscreen';
  terminalFullscreenToggleElement.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
  terminalFullscreenToggleElement.setAttribute(
    'aria-label',
    isFullscreen ? 'Exit terminal fullscreen' : 'Enter terminal fullscreen'
  );
}

function updateFullscreenViewportHeight() {
  const viewportHeight = window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight;
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    document.documentElement.style.setProperty('--terminal-fullscreen-height', `${viewportHeight}px`);
  }
}

function setTerminalFullscreen(enabled) {
  const shouldEnable = enabled === true && state.activeView === 'console';
  if (state.terminalFullscreen === shouldEnable) {
    updateFullscreenToggleButton();
    return;
  }

  state.terminalFullscreen = shouldEnable;
  document.body.classList.toggle('terminal-fullscreen-active', shouldEnable);
  if (shouldEnable) {
    updateFullscreenViewportHeight();
  }
  updateFullscreenToggleButton();
  scheduleTerminalLayoutSync(0);
}

function updatePopoutToggleButton() {
  if (!terminalPopoutToggleElement) {
    return;
  }

  const isActive = state.terminalPopoutActive === true;
  terminalPopoutToggleElement.textContent = isActive ? 'Exit PiP' : 'Popout';
  terminalPopoutToggleElement.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  terminalPopoutToggleElement.setAttribute(
    'aria-label',
    isActive ? 'Exit terminal popout' : 'Start terminal popout'
  );
}

function getActiveSessionName() {
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  return activeSession && activeSession.name ? activeSession.name : 'Terminal';
}

function normalizeTerminalPopoutText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  // Remove common ANSI CSI + OSC escapes before painting to the preview canvas.
  let cleaned = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');

  cleaned = cleaned
    .replace(/\r/g, '')
    .replace(/[^\n\t\x20-\x7E]/g, '');

  return cleaned;
}

function appendTerminalPopoutText(text) {
  const cleaned = normalizeTerminalPopoutText(text);
  if (!cleaned) {
    return;
  }

  const combined = `${terminalPopoutState.tailPartial}${cleaned}`;
  const split = combined.split('\n');
  terminalPopoutState.tailPartial = split.pop() || '';

  for (const line of split) {
    const trimmedLine = line.replace(/\t/g, '  ');
    if (trimmedLine.length > 0 || terminalPopoutState.tailLines.length > 0) {
      terminalPopoutState.tailLines.push(trimmedLine);
    }
  }

  if (terminalPopoutState.tailPartial.length > 0) {
    const lastIndex = terminalPopoutState.tailLines.length - 1;
    if (lastIndex >= 0 && terminalPopoutState.tailLines[lastIndex] === '') {
      terminalPopoutState.tailLines[lastIndex] = terminalPopoutState.tailPartial;
    }
  }

  if (terminalPopoutState.tailLines.length > 320) {
    terminalPopoutState.tailLines.splice(0, terminalPopoutState.tailLines.length - 320);
  }
}

function getTerminalSnapshotLines(maxLines) {
  const activeBuffer = term.buffer && term.buffer.active ? term.buffer.active : null;
  const lineCount = Math.max(8, Math.min(72, maxLines || 28));
  if (!activeBuffer || typeof activeBuffer.getLine !== 'function') {
    return terminalPopoutState.tailLines.slice(-lineCount);
  }

  const rows = Math.max(1, Number(term.rows) || 24);
  const bottom = Math.max(
    (activeBuffer.baseY || 0) + (activeBuffer.cursorY || 0),
    (activeBuffer.viewportY || 0) + rows - 1
  );
  const first = Math.max(0, bottom - lineCount + 1);
  const lines = [];

  for (let lineIndex = first; lineIndex <= bottom; lineIndex += 1) {
    const line = activeBuffer.getLine(lineIndex);
    const translated = line ? line.translateToString(true) : '';
    lines.push(translated.replace(/\t/g, '  '));
  }

  const fromBuffer = lines.slice(-lineCount);
  const hasContent = fromBuffer.some((line) => line && line.trim().length > 0);
  if (hasContent || terminalPopoutState.tailLines.length === 0) {
    return fromBuffer;
  }

  return terminalPopoutState.tailLines.slice(-lineCount);
}

function renderTerminalPopoutFrame() {
  if (!terminalPopoutState.context || !terminalPopoutState.canvas) {
    return;
  }

  const { canvas, context } = terminalPopoutState;
  const width = canvas.width;
  const height = canvas.height;
  const headerHeight = Math.max(54, Math.round(height * 0.08));
  const paddingX = Math.max(14, Math.round(width * 0.03));
  const paddingBottom = Math.max(12, Math.round(height * 0.02));
  const maxLines = Math.max(14, Math.min(56, Number(term.rows) || 30));
  const lines = getTerminalSnapshotLines(maxLines);

  context.fillStyle = '#0a1220';
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#142239';
  context.fillRect(0, 0, width, headerHeight);

  context.fillStyle = '#d97a41';
  context.fillRect(0, headerHeight - 2, width, 2);

  // Visible activity beacon so the stream doesn't look blank in PiP.
  const pulseOn = (Math.floor(Date.now() / 600) % 2) === 0;
  context.fillStyle = pulseOn ? '#50dd92' : '#2f6b4d';
  context.beginPath();
  context.arc(paddingX + 8, Math.round(headerHeight / 2), 5, 0, Math.PI * 2);
  context.fill();

  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillStyle = '#f0f4ff';
  context.font = `600 ${Math.max(15, Math.round(width * 0.03))}px "JetBrains Mono", "Fira Code", Menlo, monospace`;
  context.fillText(`  Console • ${getActiveSessionName()}`, paddingX + 12, headerHeight / 2);

  const timestampLabel = new Date().toLocaleTimeString();
  context.textAlign = 'right';
  context.fillStyle = '#9ca4b3';
  context.font = `500 ${Math.max(11, Math.round(width * 0.019))}px "JetBrains Mono", "Fira Code", Menlo, monospace`;
  context.fillText(timestampLabel, width - paddingX, headerHeight / 2);

  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';

  const availableHeight = height - headerHeight - paddingBottom;
  const lineHeight = Math.max(15, Math.floor(availableHeight / maxLines));
  const fontSize = Math.max(12, Math.min(20, lineHeight - 3));
  const maxChars = Math.max(26, Math.floor((width - (paddingX * 2)) / (fontSize * 0.62)));

  context.fillStyle = '#d9e0ec';
  context.font = `${fontSize}px "JetBrains Mono", "Fira Code", Menlo, monospace`;

  let y = headerHeight + fontSize + 4;
  const visibleLines = lines.length > 0 ? lines : ['(waiting for terminal output...)'];

  for (const rawLine of visibleLines.slice(-maxLines)) {
    let lineText = rawLine || '';
    if (lineText.length > maxChars) {
      lineText = `${lineText.slice(0, Math.max(0, maxChars - 1))}\u2026`;
    }
    context.fillText(lineText, paddingX, y);
    y += lineHeight;
    if (y > height - 4) {
      break;
    }
  }
}

function ensureTerminalPopoutMedia() {
  if (!terminalPopoutVideoElement) {
    throw new Error('Popout host is not available on this page.');
  }

  if (!terminalPopoutState.canvas) {
    const canvas = document.createElement('canvas');
    // Portrait feed so iOS PiP opens as a tall window.
    canvas.width = 720;
    canvas.height = 1280;
    terminalPopoutState.canvas = canvas;
    terminalPopoutState.context = canvas.getContext('2d', { alpha: false });
  }

  if (!terminalPopoutState.context || !terminalPopoutState.canvas) {
    throw new Error('Could not initialize popout video rendering.');
  }

  if (!terminalPopoutState.stream) {
    if (typeof terminalPopoutState.canvas.captureStream !== 'function') {
      throw new Error('Canvas streaming is not supported in this browser.');
    }
    terminalPopoutState.stream = terminalPopoutState.canvas.captureStream(8);
    terminalPopoutVideoElement.srcObject = terminalPopoutState.stream;
    terminalPopoutVideoElement.width = terminalPopoutState.canvas.width;
    terminalPopoutVideoElement.height = terminalPopoutState.canvas.height;
  }
}

function stopTerminalPopoutRenderLoop() {
  if (terminalPopoutState.renderTimer !== null) {
    clearInterval(terminalPopoutState.renderTimer);
    terminalPopoutState.renderTimer = null;
  }
}

function releaseTerminalPopoutMedia() {
  stopTerminalPopoutRenderLoop();
  if (terminalPopoutState.stream) {
    for (const track of terminalPopoutState.stream.getTracks()) {
      track.stop();
    }
    terminalPopoutState.stream = null;
  }

  if (terminalPopoutVideoElement) {
    terminalPopoutVideoElement.pause();
    terminalPopoutVideoElement.srcObject = null;
  }
}

function ensureTerminalPopoutRenderLoop() {
  if (terminalPopoutState.renderTimer !== null) {
    return;
  }
  terminalPopoutState.renderTimer = setInterval(() => {
    if (state.terminalPopoutActive || terminalPopoutState.stream) {
      renderTerminalPopoutFrame();
    }
  }, 180);
}

function primeTerminalPopoutMedia() {
  if (!terminalPopoutVideoElement) {
    return;
  }

  try {
    ensureTerminalPopoutMedia();
    ensureTerminalPopoutRenderLoop();
    renderTerminalPopoutFrame();
    const playResult = terminalPopoutVideoElement.play();
    if (playResult && typeof playResult.then === 'function') {
      playResult.catch(() => {
        // Ignored: autoplay priming can be blocked until a gesture on some devices.
      });
    }
  } catch (_error) {
    // Best effort only; regular popout flow handles hard failures.
  }
}

function isTerminalPopoutModeActive() {
  if (!terminalPopoutVideoElement) {
    return false;
  }

  if (document.pictureInPictureElement === terminalPopoutVideoElement) {
    return true;
  }

  if (typeof terminalPopoutVideoElement.webkitPresentationMode === 'string') {
    return terminalPopoutVideoElement.webkitPresentationMode === 'picture-in-picture';
  }

  return false;
}

function applyTerminalPopoutClosedState(options = {}) {
  const suppressHint = options.suppressHint === true;
  const preserveMedia = options.preserveMedia === true;
  state.terminalPopoutActive = false;
  stopTerminalPopoutRenderLoop();
  if (preserveMedia) {
    ensureTerminalPopoutRenderLoop();
    primeTerminalPopoutMedia();
  } else {
    releaseTerminalPopoutMedia();
  }
  updatePopoutToggleButton();
  if (!suppressHint) {
    setHint('Terminal popout closed.');
  }
}

async function startTerminalPopout() {
  ensureTerminalPopoutMedia();
  renderTerminalPopoutFrame();
  ensureTerminalPopoutRenderLoop();

  const playResult = terminalPopoutVideoElement.play();
  let pipRequest = null;
  let entered = false;

  // Important: request PiP in the same user-activation task (before any await).
  if (
    document.pictureInPictureEnabled
    && typeof terminalPopoutVideoElement.requestPictureInPicture === 'function'
  ) {
    pipRequest = terminalPopoutVideoElement.requestPictureInPicture();
  } else if (
    typeof terminalPopoutVideoElement.webkitSupportsPresentationMode === 'function'
    && typeof terminalPopoutVideoElement.webkitSetPresentationMode === 'function'
    && terminalPopoutVideoElement.webkitSupportsPresentationMode('picture-in-picture')
  ) {
    terminalPopoutVideoElement.webkitSetPresentationMode('picture-in-picture');
    entered = terminalPopoutVideoElement.webkitPresentationMode === 'picture-in-picture';
  }

  if (pipRequest && typeof pipRequest.then === 'function') {
    await pipRequest;
    entered = true;
  }

  if (playResult && typeof playResult.then === 'function') {
    try {
      await playResult;
    } catch (_error) {
      // PiP may still succeed even if play() resolves later/with restrictions.
    }
  }

  if (!entered && !isTerminalPopoutModeActive()) {
    throw new Error('Picture-in-Picture is not supported here.');
  }

  state.terminalPopoutActive = true;
  updatePopoutToggleButton();
  setHint('Terminal popout started in Picture-in-Picture (read-only).');
}

async function stopTerminalPopout(options = {}) {
  const suppressHint = options.suppressHint === true;
  if (!terminalPopoutVideoElement) {
    applyTerminalPopoutClosedState({ suppressHint });
    return;
  }

  if (document.pictureInPictureElement === terminalPopoutVideoElement && typeof document.exitPictureInPicture === 'function') {
    await document.exitPictureInPicture();
    if (!isTerminalPopoutModeActive()) {
      applyTerminalPopoutClosedState({ suppressHint, preserveMedia: true });
    }
    return;
  }

  if (
    typeof terminalPopoutVideoElement.webkitPresentationMode === 'string'
    && terminalPopoutVideoElement.webkitPresentationMode === 'picture-in-picture'
    && typeof terminalPopoutVideoElement.webkitSetPresentationMode === 'function'
  ) {
    terminalPopoutVideoElement.webkitSetPresentationMode('inline');
    if (!isTerminalPopoutModeActive()) {
      applyTerminalPopoutClosedState({ suppressHint, preserveMedia: true });
    }
    return;
  }

  applyTerminalPopoutClosedState({ suppressHint, preserveMedia: true });
}

async function toggleTerminalPopout() {
  try {
    if (state.terminalPopoutActive || isTerminalPopoutModeActive()) {
      await stopTerminalPopout();
      return;
    }

    await startTerminalPopout();
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown error';
    const notReady = /not ready to enter the picture-in-picture mode/i.test(message);
    if (notReady) {
      primeTerminalPopoutMedia();
      applyTerminalPopoutClosedState({ suppressHint: true, preserveMedia: true });
      setHint('Popout is warming up. Tap Popout again in a second.');
      return;
    }

    applyTerminalPopoutClosedState({ suppressHint: true, preserveMedia: true });
    setHint(`Could not start terminal popout: ${message}`);
  }
}

function syncTerminalLayout() {
  if (state.activeView !== 'console') {
    return;
  }

  fitAddon.fit();
  scrollSliderController.recalculate();

  // A second fit in the next frame stabilizes iOS viewport transitions.
  requestAnimationFrame(() => {
    if (state.activeView !== 'console') {
      return;
    }
    fitAddon.fit();
    scrollSliderController.recalculate();
    sendResize();
  });
}

function scheduleTerminalLayoutSync(delayMs = 90) {
  if (state.resizeTimer) {
    clearTimeout(state.resizeTimer);
  }
  state.resizeTimer = setTimeout(() => {
    syncTerminalLayout();
  }, delayMs);
}

function resetTerminalViewport() {
  term.clear();
  term.reset();
  terminalPopoutState.tailLines = [];
  terminalPopoutState.tailPartial = '';
  if (state.terminalPopoutActive) {
    renderTerminalPopoutFrame();
  }
}

updateFullscreenViewportHeight();
updateFullscreenToggleButton();
updatePopoutToggleButton();
primeTerminalPopoutMedia();

function decodeSocketFrame(frameData) {
  if (typeof frameData === 'string') {
    return frameData;
  }
  if (frameData instanceof ArrayBuffer || ArrayBuffer.isView(frameData)) {
    return wsTextDecoder.decode(frameData);
  }
  return null;
}

function tryParseControlMessage(messageText) {
  if (
    typeof messageText !== 'string'
    || messageText.length === 0
    || messageText.charCodeAt(0) !== 123
    || !messageText.includes('__onlineCliControl')
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.__onlineCliControl === true) {
      return parsed;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function setStatus(text, stateClass) {
  statusElement.textContent = text;
  statusElement.classList.remove('connected', 'disconnected');
  if (stateClass) {
    statusElement.classList.add(stateClass);
  }
}

function setHint(text) {
  hintElement.textContent = text;
}

function setCodexStatus(text) {
  codexStatusElement.textContent = text || '';
}

function redirectToLogin() {
  if (redirectingToLogin) {
    return;
  }
  redirectingToLogin = true;
  window.location.replace('/login');
}

function updateActiveSessionHint() {
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  if (!activeSession) {
    setHint('No active session selected.');
    state.localAttachCommand = '';
    if (localAttachLineElement) {
      localAttachLineElement.textContent = '';
    }
    if (copyAttachCommandButton) {
      copyAttachCommandButton.disabled = true;
    }
    return;
  }

  const attachCommand = typeof activeSession.localAttachCommand === 'string'
    ? activeSession.localAttachCommand.trim()
    : '';

  setHint(`Connected to ${activeSession.name}. Swipe the terminal or drag the slider below to scroll history.`);

  if (localAttachLineElement) {
    if (attachCommand) {
      localAttachLineElement.textContent = `Local mirror attach command: ${attachCommand}`;
    } else {
      localAttachLineElement.textContent = '';
    }
  }
  state.localAttachCommand = attachCommand;
  if (copyAttachCommandButton) {
    copyAttachCommandButton.disabled = !attachCommand;
  }
}

function formatCompactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1)}M`;
  }
  if (number >= 1_000) {
    return `${(number / 1_000).toFixed(1)}k`;
  }
  return String(number);
}

function formatDuration(ms) {
  const totalMs = Number(ms);
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return '0m';
  }

  const totalSec = Math.round(totalMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatDateTime(value) {
  if (!value) {
    return 'Unknown';
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return 'Unknown';
  }
  return timestamp.toLocaleString();
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function padTwoDigits(value) {
  return String(value).padStart(2, '0');
}

function toLocalDateKey(dateValue) {
  const year = dateValue.getFullYear();
  const month = padTwoDigits(dateValue.getMonth() + 1);
  const day = padTwoDigits(dateValue.getDate());
  return `${year}-${month}-${day}`;
}

function toLocalMonthKey(dateValue) {
  return toLocalDateKey(dateValue).slice(0, 7);
}

function getSessionTimestampMs(session) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const candidates = [session.lastPromptAt, session.endedAt, session.startedAt];
  for (const candidate of candidates) {
    const ts = parseTimestamp(candidate);
    if (ts !== null) {
      return ts;
    }
  }

  return null;
}

function getSessionDateKey(session) {
  const ts = getSessionTimestampMs(session);
  if (ts === null) {
    return '';
  }
  return toLocalDateKey(new Date(ts));
}

function getSessionMonthKey(session) {
  const dayKey = getSessionDateKey(session);
  return dayKey ? dayKey.slice(0, 7) : '';
}

function getSessionTokenCount(session) {
  if (!session || !session.metrics || !session.metrics.totalTokenUsage) {
    return 0;
  }
  return Number(session.metrics.totalTokenUsage.totalTokens) || 0;
}

function getSessionToolCalls(session) {
  return Number(session && session.metrics ? session.metrics.toolCalls : 0) || 0;
}

function getSessionElapsedDurationMs(session) {
  const elapsedDurationMs = Number(session ? session.elapsedDurationMs : 0);
  if (Number.isFinite(elapsedDurationMs) && elapsedDurationMs > 0) {
    return elapsedDurationMs;
  }

  const durationMs = Number(session ? session.durationMs : 0);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

function getSessionActiveDurationMs(session) {
  const activeDurationMs = Number(session ? session.activeDurationMs : 0);
  if (Number.isFinite(activeDurationMs) && activeDurationMs > 0) {
    return activeDurationMs;
  }

  return getSessionElapsedDurationMs(session);
}

function getSessionDurationMs(session) {
  return getSessionActiveDurationMs(session);
}

function getSessionMetricsQuality(session) {
  const quality = session && typeof session.metricsQuality === 'string'
    ? session.metricsQuality.toLowerCase()
    : '';

  if (quality === 'complete' || quality === 'partial' || quality === 'estimated') {
    return quality;
  }

  if (getSessionTokenCount(session) > 0 && getSessionElapsedDurationMs(session) > 0) {
    return 'complete';
  }

  if (session && session.metrics) {
    return 'partial';
  }

  return 'estimated';
}

function getSessionResumeStatus(session) {
  if (!session || typeof session !== 'object') {
    return 'unknown';
  }

  if (session.resumeStatus === 'unknown') {
    return 'unknown';
  }

  if (session.resumeStatus === 'not_resumable' || session.isResumable === false) {
    return 'not_resumable';
  }

  return 'resumable';
}

function getSessionResumeStatusLabel(session) {
  const status = getSessionResumeStatus(session);
  if (status === 'unknown') {
    return 'unknown';
  }
  if (status === 'not_resumable') {
    return 'non-resumable';
  }
  return 'resumable';
}

function getDefaultMetricsMonth() {
  const newestSession = state.codexSessions[0];
  const newestMonth = newestSession ? getSessionMonthKey(newestSession) : '';
  return newestMonth || toLocalMonthKey(new Date());
}

function syncMetricsFilterInputs() {
  metricsDateScopeElement.value = state.metricsFilters.dateScope || 'all';
  metricsMonthElement.value = state.metricsFilters.month || '';
  metricsFromElement.value = state.metricsFilters.from || '';
  metricsToElement.value = state.metricsFilters.to || '';
  metricsStatusElement.value = state.metricsFilters.status || '';
  metricsModelElement.value = state.metricsFilters.model || '';
  metricsCwdElement.value = state.metricsFilters.cwd || '';
  metricsSearchElement.value = state.metricsFilters.search || '';
  updateDateRangeInputState();
}

function updateDateRangeInputState() {
  const useRange = state.metricsFilters.dateScope === 'range';
  metricsFromElement.disabled = !useRange;
  metricsToElement.disabled = !useRange;
}

function setView(view) {
  const normalizedView = view === 'metrics' ? 'metrics' : 'console';
  state.activeView = normalizedView;

  const isConsole = normalizedView === 'console';
  viewPillConsoleElement.classList.toggle('active', isConsole);
  viewPillMetricsElement.classList.toggle('active', !isConsole);
  viewPillConsoleElement.setAttribute('aria-selected', isConsole ? 'true' : 'false');
  viewPillMetricsElement.setAttribute('aria-selected', !isConsole ? 'true' : 'false');

  consoleViewElement.classList.toggle('active', isConsole);
  metricsViewElement.classList.toggle('active', !isConsole);

  if (isConsole) {
    scheduleTerminalLayoutSync(0);
  } else {
    if (state.terminalFullscreen) {
      setTerminalFullscreen(false);
    }
    renderMetricsDashboard();
  }
}

function replaceSelectOptions(selectElement, options, selectedValue) {
  selectElement.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All';
  selectElement.appendChild(allOption);

  for (const optionData of options) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = `${optionData.value} (${formatCompactNumber(optionData.count)})`;
    selectElement.appendChild(option);
  }

  if (selectedValue && options.some((item) => item.value === selectedValue)) {
    selectElement.value = selectedValue;
  } else {
    selectElement.value = '';
  }
}

function populateMetricsFilterOptions() {
  const modelCounts = new Map();
  const cwdCounts = new Map();

  for (const session of state.codexSessions) {
    if (session.model) {
      modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1);
    }
    if (session.cwd) {
      cwdCounts.set(session.cwd, (cwdCounts.get(session.cwd) || 0) + 1);
    }
  }

  const toSortedEntries = (countsMap) => Array.from(countsMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.value.localeCompare(b.value);
    });

  const modelOptions = toSortedEntries(modelCounts);
  const cwdOptions = toSortedEntries(cwdCounts);

  replaceSelectOptions(metricsModelElement, modelOptions, state.metricsFilters.model);
  replaceSelectOptions(metricsCwdElement, cwdOptions, state.metricsFilters.cwd);

  state.metricsFilters.model = metricsModelElement.value || '';
  state.metricsFilters.cwd = metricsCwdElement.value || '';
}

function normalizeMetricsDateRange() {
  if (state.metricsFilters.dateScope !== 'range') {
    return;
  }

  const from = state.metricsFilters.from;
  const to = state.metricsFilters.to;
  if (!from || !to) {
    return;
  }

  if (from > to) {
    state.metricsFilters.from = to;
    state.metricsFilters.to = from;
    metricsFromElement.value = state.metricsFilters.from;
    metricsToElement.value = state.metricsFilters.to;
  }
}

function getMetricsSessions(options = {}) {
  const excludeSelectedDay = options.excludeSelectedDay === true;
  const forcedMonth = typeof options.forcedMonth === 'string' ? options.forcedMonth : '';
  const useDateRange = state.metricsFilters.dateScope === 'range';
  const search = state.metricsFilters.search.trim().toLowerCase();

  return state.codexSessions.filter((session) => {
    const sessionDateKey = getSessionDateKey(session);
    const sessionStatus = getSessionResumeStatus(session);

    const monthFilter = forcedMonth;
    if (monthFilter) {
      if (!sessionDateKey || !sessionDateKey.startsWith(monthFilter)) {
        return false;
      }
    }

    if (useDateRange) {
      if (state.metricsFilters.from) {
        if (!sessionDateKey || sessionDateKey < state.metricsFilters.from) {
          return false;
        }
      }

      if (state.metricsFilters.to) {
        if (!sessionDateKey || sessionDateKey > state.metricsFilters.to) {
          return false;
        }
      }
    }

    if (state.metricsFilters.status && sessionStatus !== state.metricsFilters.status) {
      return false;
    }

    if (state.metricsFilters.model && session.model !== state.metricsFilters.model) {
      return false;
    }

    if (state.metricsFilters.cwd && session.cwd !== state.metricsFilters.cwd) {
      return false;
    }

    if (!excludeSelectedDay && state.metricsFilters.selectedDay) {
      if (sessionDateKey !== state.metricsFilters.selectedDay) {
        return false;
      }
    }

    if (search) {
      const haystack = [
        session.id,
        session.cwd,
        session.model,
        session.cliVersion,
        session.fileName,
        session.storeCodexHome,
        sessionStatus
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }

    return true;
  });
}

function renderMetricsSummaryCards(sessions) {
  let totalTokens = 0;
  let totalTools = 0;
  let activeDurationTotal = 0;
  let elapsedDurationTotal = 0;

  for (const session of sessions) {
    totalTokens += getSessionTokenCount(session);
    totalTools += getSessionToolCalls(session);
    activeDurationTotal += getSessionActiveDurationMs(session);
    elapsedDurationTotal += getSessionElapsedDurationMs(session);
  }

  const averageActiveDurationMs = sessions.length > 0 ? activeDurationTotal / sessions.length : 0;
  const averageElapsedDurationMs = sessions.length > 0 ? elapsedDurationTotal / sessions.length : 0;

  metricSessionsElement.textContent = formatCompactNumber(sessions.length);
  metricTokensElement.textContent = formatCompactNumber(totalTokens);
  metricToolsElement.textContent = formatCompactNumber(totalTools);
  metricDurationElement.textContent = `${formatDuration(averageActiveDurationMs)} active / ${formatDuration(averageElapsedDurationMs)} elapsed`;
}

function renderMetricsSessionList(sessions) {
  metricsListElement.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'metrics-status';
    empty.textContent = 'No sessions match these filters.';
    metricsListElement.appendChild(empty);
    metricsResultsElement.textContent = '0 results';
    return;
  }

  const visibleSessions = sessions.slice(0, maxMetricsListRows);

  for (const session of visibleSessions) {
    const item = document.createElement('article');
    item.className = 'metrics-item';

    const id = document.createElement('div');
    id.className = 'metrics-item-id';
    id.textContent = session.id;
    item.appendChild(id);

    const chips = document.createElement('div');
    chips.className = 'codex-metrics';
    const quality = getSessionMetricsQuality(session);
    const qualityLabel = quality === 'complete'
      ? 'metrics complete'
      : (quality === 'partial' ? 'metrics partial' : 'metrics estimated');
    const activeDurationMs = getSessionActiveDurationMs(session);
    const elapsedDurationMs = getSessionElapsedDurationMs(session);

    const chipValues = [
      getSessionResumeStatusLabel(session),
      qualityLabel,
      `${formatCompactNumber(getSessionTokenCount(session))} tokens`,
      `${formatCompactNumber(getSessionToolCalls(session))} tool calls`,
      `${formatDuration(activeDurationMs)} active / ${formatDuration(elapsedDurationMs)} elapsed`
    ];

    for (const chipText of chipValues) {
      const chip = document.createElement('span');
      chip.className = 'codex-chip';
      chip.textContent = chipText;
      chips.appendChild(chip);
    }
    item.appendChild(chips);

    const meta = document.createElement('div');
    meta.className = 'metrics-item-meta';
    meta.textContent = [
      `cwd: ${session.cwd || 'Unknown'}`,
      `model: ${session.model || 'Unknown'}`,
      `time: ${formatDateTime(session.lastPromptAt || session.endedAt || session.startedAt)}`
    ].join(' | ');
    item.appendChild(meta);

    metricsListElement.appendChild(item);
  }

  if (sessions.length > visibleSessions.length) {
    metricsResultsElement.textContent = `${formatCompactNumber(sessions.length)} results (showing first ${formatCompactNumber(visibleSessions.length)})`;
  } else {
    metricsResultsElement.textContent = `${formatCompactNumber(sessions.length)} results`;
  }
}

function renderMetricsCalendar() {
  let monthKey = state.metricsFilters.month;
  if (!monthKey) {
    monthKey = getDefaultMetricsMonth();
    state.metricsFilters.month = monthKey;
    metricsMonthElement.value = monthKey;
  }

  const monthMatch = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!monthMatch) {
    metricsCalendarElement.innerHTML = '';
    calendarLegendElement.textContent = 'Invalid month filter';
    return;
  }

  const year = Number(monthMatch[1]);
  const monthIndex = Number(monthMatch[2]) - 1;
  const firstDay = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const firstWeekday = firstDay.getDay();

  const sessions = getMetricsSessions({ excludeSelectedDay: true, forcedMonth: monthKey });
  const dayStats = new Map();

  for (const session of sessions) {
    const dayKey = getSessionDateKey(session);
    if (!dayKey || !dayKey.startsWith(monthKey)) {
      continue;
    }

    const existing = dayStats.get(dayKey) || { count: 0, tokens: 0 };
    existing.count += 1;
    existing.tokens += getSessionTokenCount(session);
    dayStats.set(dayKey, existing);
  }

  let maxCount = 0;
  for (const stats of dayStats.values()) {
    if (stats.count > maxCount) {
      maxCount = stats.count;
    }
  }

  metricsCalendarElement.innerHTML = '';

  for (const weekday of calendarWeekdays) {
    const header = document.createElement('div');
    header.className = 'calendar-weekday';
    header.textContent = weekday;
    metricsCalendarElement.appendChild(header);
  }

  for (let i = 0; i < firstWeekday; i += 1) {
    const spacer = document.createElement('div');
    spacer.className = 'calendar-day empty';
    spacer.setAttribute('aria-hidden', 'true');
    metricsCalendarElement.appendChild(spacer);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${monthKey}-${padTwoDigits(day)}`;
    const stats = dayStats.get(dateKey) || { count: 0, tokens: 0 };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-day';
    if (stats.count === 0) {
      button.classList.add('empty');
    }
    if (state.metricsFilters.selectedDay === dateKey) {
      button.classList.add('active');
    }

    if (stats.count > 0 && maxCount > 0) {
      const intensity = stats.count / maxCount;
      const backgroundAlpha = 0.17 + (intensity * 0.58);
      const borderAlpha = 0.25 + (intensity * 0.55);
      button.style.background = `rgba(217, 122, 65, ${backgroundAlpha.toFixed(3)})`;
      button.style.borderColor = `rgba(217, 122, 65, ${borderAlpha.toFixed(3)})`;
    }

    button.title = stats.count > 0
      ? `${dateKey}: ${stats.count} sessions, ${formatCompactNumber(stats.tokens)} tokens`
      : `${dateKey}: no sessions`;

    const num = document.createElement('div');
    num.className = 'calendar-day-num';
    num.textContent = String(day);
    button.appendChild(num);

    const meta = document.createElement('div');
    meta.className = 'calendar-day-meta';
    meta.textContent = stats.count > 0
      ? `${formatCompactNumber(stats.count)} ses • ${formatCompactNumber(stats.tokens)} tok`
      : '0';
    button.appendChild(meta);

    button.addEventListener('click', () => {
      if (stats.count === 0) {
        return;
      }
      if (state.metricsFilters.selectedDay === dateKey) {
        state.metricsFilters.selectedDay = '';
      } else {
        state.metricsFilters.selectedDay = dateKey;
      }
      renderMetricsDashboard();
    });

    metricsCalendarElement.appendChild(button);
  }

  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  });
  calendarLegendElement.textContent = [
    monthLabel,
    `${formatCompactNumber(sessions.length)} sessions`,
    state.metricsFilters.selectedDay ? `day ${state.metricsFilters.selectedDay}` : 'tap day to filter'
  ].join(' • ');
}

function renderMetricsDashboard() {
  if (!state.codexSessions.length) {
    metricSessionsElement.textContent = '0';
    metricTokensElement.textContent = '0';
    metricToolsElement.textContent = '0';
    metricDurationElement.textContent = '0m';
    metricsCalendarElement.innerHTML = '';
    metricsListElement.innerHTML = '';
    metricsStatusTextElement.textContent = 'No session data indexed yet.';
    metricsResultsElement.textContent = '0 results';
    calendarLegendElement.textContent = '';
    return;
  }

  if (!state.metricsFilters.month) {
    state.metricsFilters.month = getDefaultMetricsMonth();
  }

  normalizeMetricsDateRange();
  syncMetricsFilterInputs();
  renderMetricsCalendar();

  const candidateSessions = getMetricsSessions({ excludeSelectedDay: true });
  let rerenderCalendar = false;
  if (state.metricsFilters.selectedDay) {
    const selectedDayStillValid = candidateSessions.some(
      (session) => getSessionDateKey(session) === state.metricsFilters.selectedDay
    );
    if (!selectedDayStillValid) {
      state.metricsFilters.selectedDay = '';
      rerenderCalendar = true;
      syncMetricsFilterInputs();
    }
  }
  if (rerenderCalendar) {
    renderMetricsCalendar();
  }

  const filteredSessions = getMetricsSessions();
  renderMetricsSummaryCards(filteredSessions);
  renderMetricsSessionList(filteredSessions);

  const activeFilters = [];
  if (state.metricsFilters.dateScope === 'range') {
    activeFilters.push('date range');
  } else {
    activeFilters.push('all data');
  }
  if (state.metricsFilters.search) activeFilters.push(`search "${state.metricsFilters.search}"`);
  if (state.metricsFilters.status) activeFilters.push(`status ${state.metricsFilters.status}`);
  if (state.metricsFilters.model) activeFilters.push(`model ${state.metricsFilters.model}`);
  if (state.metricsFilters.cwd) activeFilters.push(`cwd ${state.metricsFilters.cwd}`);
  if (state.metricsFilters.dateScope === 'range') {
    if (state.metricsFilters.from) activeFilters.push(`from ${state.metricsFilters.from}`);
    if (state.metricsFilters.to) activeFilters.push(`to ${state.metricsFilters.to}`);
  }
  if (state.metricsFilters.selectedDay) activeFilters.push(`day ${state.metricsFilters.selectedDay}`);

  if (activeFilters.length > 0) {
    metricsStatusTextElement.textContent = `Filters: ${activeFilters.join(' • ')}`;
  } else {
    metricsStatusTextElement.textContent = 'Filters: none';
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      payload = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      redirectToLogin();
    }
    throw new Error(payload && payload.error ? payload.error : `Request failed (${response.status})`);
  }

  return payload;
}

function renderSessionOptions() {
  const currentValue = sessionSelectElement.value;
  sessionSelectElement.innerHTML = '';

  for (const session of state.sessions) {
    const option = document.createElement('option');
    const shortId = session.id.slice(0, 8);
    option.value = session.id;
    option.textContent = `${session.name} (${shortId})`;
    sessionSelectElement.appendChild(option);
  }

  if (state.activeSessionId) {
    sessionSelectElement.value = state.activeSessionId;
  }

  if (!sessionSelectElement.value && currentValue) {
    sessionSelectElement.value = currentValue;
  }

  deleteSessionButton.disabled = state.sessions.length <= 1;
  sessionSelectElement.disabled = state.sessions.length === 0;
  if (state.singleConsoleMode) {
    createSessionButton.disabled = true;
    deleteSessionButton.disabled = true;
  } else {
    createSessionButton.disabled = false;
    if (state.sessions.length <= 1) {
      deleteSessionButton.disabled = true;
    }
  }
}

async function refreshSessions(options = {}) {
  const preserveSelection = options.preserveSelection !== false;
  const preferredSessionId = options.preferredSessionId || null;
  const data = await requestJson('/api/sessions');

  state.sessions = data.sessions;
  state.singleConsoleMode = data.singleConsoleMode === true;

  let nextSessionId = preferredSessionId;
  if (!nextSessionId && preserveSelection) {
    const stillExists = state.sessions.some((session) => session.id === state.activeSessionId);
    if (stillExists) {
      nextSessionId = state.activeSessionId;
    }
  }

  if (!nextSessionId) {
    nextSessionId = data.defaultSessionId || (state.sessions[0] && state.sessions[0].id) || null;
  }

  state.activeSessionId = nextSessionId;
  renderSessionOptions();
  updateActiveSessionHint();
}

function sendResize() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.activeSessionId) return;
  state.socket.send(JSON.stringify({
    type: 'resize',
    cols: term.cols,
    rows: term.rows
  }));
}

function disconnectSocket() {
  state.manualDisconnect = true;
  state.socketGeneration += 1;
  clearServerScrollQueue();

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    state.socket.close();
  }

  state.socket = null;
}

function connectSocket() {
  if (!state.activeSessionId) {
    setStatus('No session selected', 'disconnected');
    return;
  }

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.manualDisconnect = false;
  state.socketGeneration += 1;
  const socketGeneration = state.socketGeneration;
  setStatus('Connecting...', null);

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(state.activeSessionId)}`;
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.addEventListener('open', () => {
    if (state.socket !== socket || socketGeneration !== state.socketGeneration) return;
    resetTerminalViewport();
    setStatus('Connected', 'connected');
    scheduleTerminalLayoutSync(0);
  });

  socket.addEventListener('message', (event) => {
    if (state.socket !== socket || socketGeneration !== state.socketGeneration) {
      return;
    }

    const text = decodeSocketFrame(event.data);
    if (typeof text !== 'string' || text.length === 0) {
      return;
    }

    const controlMessage = tryParseControlMessage(text);
    if (controlMessage && controlMessage.type === 'session-ready') {
      return;
    }

    appendTerminalPopoutText(text);
    term.write(text);
    if (state.terminalPopoutActive) {
      renderTerminalPopoutFrame();
    }
  });

  socket.addEventListener('close', (event) => {
    if (state.socket !== socket || socketGeneration !== state.socketGeneration) return;
    state.socket = null;

    if (event && event.code === 1008) {
      redirectToLogin();
      return;
    }

    if (state.manualDisconnect) {
      return;
    }

    setStatus('Disconnected (reconnecting...)', 'disconnected');
    state.reconnectTimer = setTimeout(() => {
      connectSocket();
    }, 1200);
  });

  socket.addEventListener('error', () => {
    if (socketGeneration !== state.socketGeneration) {
      return;
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
}

async function switchSession(nextSessionId) {
  if (!nextSessionId || nextSessionId === state.activeSessionId) {
    return;
  }

  clearServerScrollQueue();
  disconnectSocket();
  state.activeSessionId = nextSessionId;
  renderSessionOptions();
  updateActiveSessionHint();

  resetTerminalViewport();
  connectSocket();
}

async function createSession() {
  createSessionButton.disabled = true;
  try {
    const payload = await requestJson('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({})
    });

    const createdSessionId = payload.session.id;
    await refreshSessions({ preserveSelection: false, preferredSessionId: createdSessionId });

    disconnectSocket();
    resetTerminalViewport();
    connectSocket();
  } finally {
    renderSessionOptions();
  }
}

async function deleteActiveSession() {
  if (!state.activeSessionId || state.sessions.length <= 1) {
    return;
  }

  const currentSession = state.sessions.find((session) => session.id === state.activeSessionId);
  const confirmed = window.confirm(`End session "${currentSession ? currentSession.name : 'selected'}"?`);
  if (!confirmed) {
    return;
  }

  deleteSessionButton.disabled = true;

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload && payload.error ? payload.error : 'Failed to delete session');
    }

    disconnectSocket();
    resetTerminalViewport();

    await refreshSessions({ preserveSelection: false });
    connectSocket();
  } finally {
    renderSessionOptions();
  }
}

function renderCodexSummary() {
  if (!state.codexSummary) {
    codexSummaryElement.textContent = 'No Codex session data available.';
    return;
  }

  const summary = state.codexSummary;
  const scannedAt = formatDateTime(summary.scannedAt);
  const unknownCount = Number(summary.unknownResumableSessionCount) || 0;
  let resumeSummary = 'resume availability unknown';
  if (summary.historyAvailable !== false) {
    resumeSummary = `${formatCompactNumber(summary.resumableSessionCount)} resumable / ${formatCompactNumber(summary.nonResumableSessionCount)} non-resumable`;
    if (unknownCount > 0) {
      resumeSummary += ` / ${formatCompactNumber(unknownCount)} unknown`;
    }
  }

  const qualitySummary = [
    `${formatCompactNumber(summary.completeMetricsSessionCount || 0)} complete`,
    `${formatCompactNumber(summary.partialMetricsSessionCount || 0)} partial`,
    `${formatCompactNumber(summary.estimatedMetricsSessionCount || 0)} estimated`
  ].join(' / ');
  const duplicateSummary = Number(summary.duplicateSessionEntries) > 0
    ? `${formatCompactNumber(summary.duplicateSessionEntries)} duplicate entries collapsed`
    : 'no duplicate entries';

  codexSummaryElement.textContent = [
    `${summary.sessionCount} sessions`,
    `${formatCompactNumber(summary.storeCount || 1)} stores`,
    resumeSummary,
    `${summary.uniqueDirectories} directories`,
    `${formatCompactNumber(summary.totalToolCalls)} tool calls`,
    `${formatCompactNumber(summary.totalTokens)} tokens`,
    qualitySummary,
    duplicateSummary,
    `indexed ${scannedAt}`
  ].join(' • ');
}

function getVisibleCodexSessions() {
  const search = state.codexSearchTerm.trim().toLowerCase();
  if (!search) {
    return state.codexSessions;
  }

  return state.codexSessions.filter((session) => {
    const haystack = [
      session.id,
      session.cwd,
      session.model,
      session.cliVersion,
      session.fileName,
      session.storeCodexHome,
      session.resumeStatus
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(search);
  });
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand('copy');
  textArea.remove();
}

async function resumeCodexSession(session) {
  if (!state.activeSessionId) {
    throw new Error('No active terminal session selected');
  }

  const payload = await requestJson(`/api/codex/sessions/${encodeURIComponent(session.id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({
      terminalSessionId: state.activeSessionId
    })
  });

  setCodexStatus(`Queued: ${payload.command}`);
}

function renderCodexSessionList() {
  const sessions = getVisibleCodexSessions();
  codexListElement.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'codex-status';
    empty.textContent = state.codexLoading
      ? 'Loading sessions...'
      : 'No matching Codex sessions found.';
    codexListElement.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement('article');
    item.className = 'codex-item';

    const top = document.createElement('div');
    top.className = 'codex-item-top';

    const id = document.createElement('div');
    id.className = 'codex-id';
    id.textContent = session.id;
    top.appendChild(id);

    const chips = document.createElement('div');
    chips.className = 'codex-metrics';
    const tokens = getSessionTokenCount(session);
    const quality = getSessionMetricsQuality(session);
    const qualityLabel = quality === 'complete'
      ? 'metrics complete'
      : (quality === 'partial' ? 'metrics partial' : 'metrics estimated');
    const activeDurationMs = getSessionActiveDurationMs(session);
    const elapsedDurationMs = getSessionElapsedDurationMs(session);

    const resumeLabel = session.resumeStatus === 'unknown'
      ? 'resume unknown'
      : (session.isResumable === false ? 'not resumable' : 'resumable');

    const chipValues = [
      resumeLabel,
      qualityLabel,
      `${formatCompactNumber(tokens)} tokens`,
      `${formatCompactNumber(session.metrics ? session.metrics.userMessages : 0)} user msgs`,
      `${formatCompactNumber(session.metrics ? session.metrics.assistantMessages : 0)} assistant msgs`,
      `${formatCompactNumber(session.metrics ? session.metrics.toolCalls : 0)} tool calls`,
      `${formatDuration(activeDurationMs)} active / ${formatDuration(elapsedDurationMs)} elapsed`
    ];

    for (const chipText of chipValues) {
      const chip = document.createElement('span');
      chip.className = 'codex-chip';
      chip.textContent = chipText;
      chips.appendChild(chip);
    }

    top.appendChild(chips);
    item.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'codex-meta';
    const parts = [
      `cwd: ${session.cwd || 'Unknown'}`,
      `model: ${session.model || 'Unknown'}`,
      `ended: ${formatDateTime(session.endedAt)}`
    ];
    if (session.storeCodexHome) {
      parts.push(`store: ${session.storeCodexHome}`);
    }
    if (session.lastPromptAt) {
      parts.push(`last prompt: ${formatDateTime(session.lastPromptAt)}`);
    }
    if (session.isResumable === false && session.resumeReason) {
      parts.push(`resume: ${session.resumeReason}`);
    }
    meta.textContent = parts.join(' | ');
    item.appendChild(meta);

    const buttons = document.createElement('div');
    buttons.className = 'codex-buttons';

    const resumeButton = document.createElement('button');
    resumeButton.className = 'codex-btn';
    resumeButton.type = 'button';
    resumeButton.textContent = 'Resume Here';
    if (session.isResumable === false) {
      resumeButton.disabled = true;
      resumeButton.textContent = 'Not Resumable';
      resumeButton.title = session.resumeReason || 'This session is not currently resumable by codex resume.';
    }
    resumeButton.addEventListener('click', async () => {
      resumeButton.disabled = true;
      try {
        await resumeCodexSession(session);
      } catch (error) {
        setCodexStatus(`Resume failed: ${error.message}`);
      } finally {
        resumeButton.disabled = false;
      }
    });
    buttons.appendChild(resumeButton);

    const copyButton = document.createElement('button');
    copyButton.className = 'codex-btn';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy Command';
    if (session.isResumable === false) {
      copyButton.disabled = true;
      copyButton.title = session.resumeReason || 'This session is not currently resumable by codex resume.';
    }
    copyButton.addEventListener('click', async () => {
      copyButton.disabled = true;
      try {
        await copyTextToClipboard(session.resumeCommand);
        setCodexStatus(`Copied: ${session.resumeCommand}`);
      } catch (error) {
        setCodexStatus(`Copy failed: ${error.message}`);
      } finally {
        copyButton.disabled = false;
      }
    });
    buttons.appendChild(copyButton);

    item.appendChild(buttons);
    codexListElement.appendChild(item);
  }
}

async function refreshCodexSessions(options = {}) {
  const force = options.force === true;
  state.codexLoading = true;
  renderCodexSessionList();

  const query = new URLSearchParams();
  query.set('limit', 'all');
  if (force) {
    query.set('refresh', '1');
  }

  const payload = await requestJson(`/api/codex/sessions?${query.toString()}`);
  state.codexSessions = payload.sessions || [];
  state.codexSummary = payload.summary || null;
  state.codexLoading = false;

  renderCodexSummary();
  renderCodexSessionList();
  populateMetricsFilterOptions();
  if (!state.metricsFilters.month) {
    state.metricsFilters.month = getDefaultMetricsMonth();
  }
  renderMetricsDashboard();
  if (payload.scannedAt) {
    const indexedLabel = `Indexed at ${formatDateTime(payload.scannedAt)}`;
    if (payload.summary && payload.summary.historyAvailable === false) {
      setCodexStatus(`${indexedLabel}. Resume availability unknown (history file not found).`);
    } else if (payload.summary && payload.summary.historyPartiallyAvailable) {
      setCodexStatus(`${indexedLabel}. Some Codex stores are missing history.jsonl, resume status may be partial.`);
    } else {
      setCodexStatus(indexedLabel);
    }
  }
}

function scheduleCodexAutoRefresh() {
  if (state.codexRefreshTimer) {
    clearInterval(state.codexRefreshTimer);
    state.codexRefreshTimer = null;
  }

  state.codexRefreshTimer = setInterval(async () => {
    try {
      await refreshCodexSessions({ force: false });
    } catch (error) {
      setCodexStatus(`Index refresh failed: ${error.message}`);
    }
  }, 20_000);
}

function sendTerminalInput(data) {
  if (typeof data !== 'string' || data.length === 0) {
    return false;
  }

  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  state.socket.send(JSON.stringify({ type: 'input', data }));
  return true;
}

function scrollTerminalHistory(linesToScroll) {
  if (!Number.isFinite(linesToScroll) || linesToScroll === 0) {
    return false;
  }

  if (isLikelyIOS) {
    return queueServerHistoryScroll(linesToScroll);
  }

  const viewport = terminalElement.querySelector('.xterm-viewport');
  if (viewport) {
    const beforeTop = viewport.scrollTop;
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const lineHeightPx = Math.max(8, Math.round((Number(term.options?.fontSize) || 14) * 1.45));
    const nextTop = Math.max(0, Math.min(maxTop, beforeTop + (linesToScroll * lineHeightPx)));
    if (nextTop !== beforeTop) {
      viewport.scrollTop = nextTop;
      return true;
    }
  }

  const activeBuffer = term.buffer && term.buffer.active ? term.buffer.active : null;
  const beforeViewportY = activeBuffer ? activeBuffer.viewportY : 0;
  term.scrollLines(linesToScroll);
  const afterViewportY = activeBuffer ? activeBuffer.viewportY : beforeViewportY;

  if (afterViewportY !== beforeViewportY) {
    return true;
  }

  // Fallback for tmux/curses-style apps where local xterm scrollback can't move.
  const pageKey = linesToScroll < 0 ? '\u001b[5~' : '\u001b[6~';
  const repeatCount = Math.min(8, Math.max(1, Math.round(Math.abs(linesToScroll) / 6)));
  return sendTerminalInput(pageKey.repeat(repeatCount));
}

function setupScrollSliderControl() {
  if (!scrollSliderElement || !scrollSliderThumbElement) {
    return {
      recalculate: () => {}
    };
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const setOffset = (offsetPx) => {
    scrollSliderState.offsetPx = clamp(offsetPx, -scrollSliderState.maxOffsetPx, scrollSliderState.maxOffsetPx);
    scrollSliderThumbElement.style.setProperty('--thumb-offset-x', `${scrollSliderState.offsetPx}px`);

    const normalized = scrollSliderState.maxOffsetPx === 0
      ? 0
      : (scrollSliderState.offsetPx / scrollSliderState.maxOffsetPx);
    scrollSliderElement.setAttribute('aria-valuenow', String(Math.round(normalized * 100)));
  };

  const stopReturnAnimation = () => {
    if (scrollSliderState.returnRafId !== null) {
      cancelAnimationFrame(scrollSliderState.returnRafId);
      scrollSliderState.returnRafId = null;
    }
  };

  const recalculate = () => {
    const sliderRect = scrollSliderElement.getBoundingClientRect();
    const thumbRect = scrollSliderThumbElement.getBoundingClientRect();
    scrollSliderState.centerX = sliderRect.left + (sliderRect.width / 2);
    scrollSliderState.maxOffsetPx = Math.max(((sliderRect.width - thumbRect.width) / 2) - 14, 18);
    setOffset(scrollSliderState.offsetPx);
  };

  const applyScrollFromOffset = (elapsedMs) => {
    const normalized = scrollSliderState.maxOffsetPx === 0
      ? 0
      : (scrollSliderState.offsetPx / scrollSliderState.maxOffsetPx);
    if (Math.abs(normalized) < 0.025) {
      scrollSliderState.lineAccumulator = 0;
      return;
    }

    const curve = Math.sign(normalized) * Math.pow(Math.abs(normalized), 1.35);
    const linesPerSecond = curve * 240;
    scrollSliderState.lineAccumulator += (linesPerSecond * elapsedMs) / 1000;

    const linesToScroll = scrollSliderState.lineAccumulator > 0
      ? Math.floor(scrollSliderState.lineAccumulator)
      : Math.ceil(scrollSliderState.lineAccumulator);

    if (linesToScroll === 0) {
      return;
    }

    const moved = scrollTerminalHistory(linesToScroll);
    if (moved) {
      scrollSliderState.lineAccumulator -= linesToScroll;
    } else {
      scrollSliderState.lineAccumulator = 0;
    }
  };

  const tick = (ts) => {
    if (scrollSliderState.activePointerId === null && scrollSliderState.activeTouchId === null) {
      scrollSliderState.tickRafId = null;
      scrollSliderState.lineAccumulator = 0;
      return;
    }

    if (!scrollSliderState.lastTickTs) {
      scrollSliderState.lastTickTs = ts;
    }

    const elapsedMs = Math.min(40, Math.max(0, ts - scrollSliderState.lastTickTs));
    scrollSliderState.lastTickTs = ts;
    applyScrollFromOffset(elapsedMs);
    scrollSliderState.tickRafId = requestAnimationFrame(tick);
  };

  const startTickLoop = () => {
    if (scrollSliderState.tickRafId !== null) {
      return;
    }
    scrollSliderState.lastTickTs = 0;
    scrollSliderState.tickRafId = requestAnimationFrame(tick);
  };

  const startReturnAnimation = () => {
    stopReturnAnimation();

    const animate = () => {
      const nextOffset = scrollSliderState.offsetPx * 0.72;
      if (Math.abs(nextOffset) < 0.5) {
        setOffset(0);
        scrollSliderElement.classList.remove('active');
        return;
      }

      setOffset(nextOffset);
      scrollSliderState.returnRafId = requestAnimationFrame(animate);
    };

    scrollSliderState.returnRafId = requestAnimationFrame(animate);
  };

  const updateFromPointer = (clientX) => {
    const offset = clientX - scrollSliderState.centerX;
    setOffset(offset);
  };

  const onPointerDown = (event) => {
    const isTouchLikePointer = event.pointerType === 'touch' || event.pointerType === 'pen';
    const isPrimaryButton = event.button === 0 || event.button === -1 || event.buttons === 1;
    if (!isTouchLikePointer && !isPrimaryButton) {
      return;
    }

    stopReturnAnimation();
    recalculate();

    scrollSliderState.activePointerId = event.pointerId;
    scrollSliderElement.classList.add('active');
    if (typeof scrollSliderElement.setPointerCapture === 'function') {
      try {
        scrollSliderElement.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore pointer-capture failures on mobile viewport shifts.
      }
    }

    updateFromPointer(event.clientX);
    startTickLoop();
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (scrollSliderState.activePointerId !== event.pointerId) {
      return;
    }

    updateFromPointer(event.clientX);
    event.preventDefault();
  };

  const releasePointer = (event) => {
    if (scrollSliderState.activePointerId !== event.pointerId) {
      return;
    }
    scrollSliderState.activePointerId = null;
    scrollSliderState.lastTickTs = 0;
    startReturnAnimation();
  };

  const onTouchStart = (event) => {
    if (window.PointerEvent || event.touches.length === 0) {
      return;
    }
    if (scrollSliderState.activeTouchId !== null) {
      return;
    }

    stopReturnAnimation();
    recalculate();
    const touch = event.touches[0];
    scrollSliderState.activeTouchId = touch.identifier;
    scrollSliderElement.classList.add('active');
    updateFromPointer(touch.clientX);
    startTickLoop();
    event.preventDefault();
  };

  const onTouchMove = (event) => {
    if (window.PointerEvent || scrollSliderState.activeTouchId === null) {
      return;
    }
    const touch = Array.from(event.touches).find((item) => item.identifier === scrollSliderState.activeTouchId);
    if (!touch) {
      return;
    }
    updateFromPointer(touch.clientX);
    event.preventDefault();
  };

  const releaseTouch = (event) => {
    if (window.PointerEvent || scrollSliderState.activeTouchId === null) {
      return;
    }
    const ended = Array.from(event.changedTouches || []).some((item) => item.identifier === scrollSliderState.activeTouchId);
    if (!ended) {
      return;
    }
    scrollSliderState.activeTouchId = null;
    scrollSliderState.lastTickTs = 0;
    startReturnAnimation();
  };

  scrollSliderElement.addEventListener('pointerdown', onPointerDown, { passive: false });
  scrollSliderElement.addEventListener('pointermove', onPointerMove, { passive: false });
  scrollSliderElement.addEventListener('pointerup', releasePointer);
  scrollSliderElement.addEventListener('pointercancel', releasePointer);
  scrollSliderElement.addEventListener('lostpointercapture', releasePointer);
  scrollSliderElement.addEventListener('touchstart', onTouchStart, { passive: false });
  scrollSliderElement.addEventListener('touchmove', onTouchMove, { passive: false });
  scrollSliderElement.addEventListener('touchend', releaseTouch, { passive: true });
  scrollSliderElement.addEventListener('touchcancel', releaseTouch, { passive: true });

  scrollSliderElement.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) < 0.5) {
      return;
    }
    const lines = Math.round(event.deltaY / 3);
    if (lines !== 0) {
      scrollTerminalHistory(lines);
      event.preventDefault();
    }
  }, { passive: false });

  scrollSliderElement.addEventListener('keydown', (event) => {
    let lines = 0;
    if (event.key === 'ArrowLeft') lines = -3;
    if (event.key === 'ArrowRight') lines = 3;
    if (event.key === 'PageUp') lines = -36;
    if (event.key === 'PageDown') lines = 36;
    if (lines === 0) return;

    const moved = scrollTerminalHistory(lines);
    if (moved) {
      const direction = Math.sign(lines);
      setOffset(direction * Math.min(20, scrollSliderState.maxOffsetPx * 0.45));
      startReturnAnimation();
      event.preventDefault();
    }
  });

  recalculate();
  return { recalculate };
}

function clearServerScrollQueue() {
  serverScrollState.pendingLines = 0;
  serverScrollState.sessionId = null;

  if (serverScrollState.flushTimer) {
    clearTimeout(serverScrollState.flushTimer);
    serverScrollState.flushTimer = null;
  }
}

function queueServerHistoryScroll(linesToScroll) {
  if (!state.activeSessionId) {
    return false;
  }

  const lines = Math.trunc(linesToScroll);
  if (!Number.isFinite(lines) || lines === 0) {
    return false;
  }

  if (serverScrollState.sessionId && serverScrollState.sessionId !== state.activeSessionId) {
    clearServerScrollQueue();
  }

  serverScrollState.sessionId = state.activeSessionId;
  serverScrollState.pendingLines = Math.max(
    -1200,
    Math.min(1200, serverScrollState.pendingLines + lines)
  );

  if (!serverScrollState.flushTimer) {
    serverScrollState.flushTimer = setTimeout(() => {
      flushServerHistoryScroll().catch(() => {});
    }, 18);
  }

  return true;
}

async function flushServerHistoryScroll() {
  serverScrollState.flushTimer = null;
  if (serverScrollState.inFlight) {
    return;
  }

  const lines = serverScrollState.pendingLines > 0
    ? Math.floor(serverScrollState.pendingLines)
    : Math.ceil(serverScrollState.pendingLines);
  if (!lines) {
    return;
  }

  const sessionId = serverScrollState.sessionId || state.activeSessionId;
  if (!sessionId) {
    serverScrollState.pendingLines = 0;
    return;
  }

  serverScrollState.pendingLines -= lines;
  serverScrollState.inFlight = true;

  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines })
    });
  } finally {
    serverScrollState.inFlight = false;
    if (serverScrollState.pendingLines !== 0 && state.activeSessionId === sessionId) {
      serverScrollState.flushTimer = setTimeout(() => {
        flushServerHistoryScroll().catch(() => {});
      }, 18);
    }
  }
}

function setupTerminalTouchLock() {
  const viewport = terminalElement.querySelector('.xterm-viewport');
  const touchLayer = term.element || terminalElement;
  if (!viewport || !touchLayer) {
    return;
  }

  viewport.style.webkitOverflowScrolling = 'touch';
  viewport.style.overflowY = 'auto';
  viewport.style.overflowX = 'hidden';
  viewport.style.touchAction = 'pan-y';
  viewport.style.overscrollBehaviorY = 'contain';
  touchLayer.style.overscrollBehaviorY = 'contain';
  touchLayer.style.touchAction = 'pan-y';

  const swipe = terminalSwipeState;

  const stopMomentum = () => {
    if (swipe.momentumRafId !== null) {
      cancelAnimationFrame(swipe.momentumRafId);
      swipe.momentumRafId = null;
    }
    swipe.lastMomentumTs = 0;
  };

  const consumeLineDelta = (lineDelta) => {
    if (!Number.isFinite(lineDelta) || lineDelta === 0) {
      return false;
    }

    swipe.lineAccumulator += lineDelta;
    const lines = swipe.lineAccumulator > 0
      ? Math.floor(swipe.lineAccumulator)
      : Math.ceil(swipe.lineAccumulator);

    if (lines === 0) {
      return false;
    }

    const moved = scrollTerminalHistory(lines);
    if (moved) {
      swipe.lineAccumulator -= lines;
    } else {
      swipe.lineAccumulator = 0;
    }
    return moved;
  };

  const startGesture = (clientY, ts) => {
    stopMomentum();
    swipe.startY = clientY;
    swipe.lastY = clientY;
    swipe.lastTs = Number.isFinite(ts) ? ts : performance.now();
    swipe.isSwiping = false;
    swipe.lineAccumulator = 0;
    swipe.velocityLinesPerSecond = 0;
  };

  const updateGesture = (clientY, ts) => {
    const nowTs = Number.isFinite(ts) ? ts : performance.now();
    const elapsedMs = Math.max(1, Math.min(48, nowTs - swipe.lastTs));
    const deltaY = clientY - swipe.lastY;
    const distanceFromStart = Math.abs(clientY - swipe.startY);

    swipe.lastY = clientY;
    swipe.lastTs = nowTs;

    if (!swipe.isSwiping && distanceFromStart < 8) {
      return false;
    }
    swipe.isSwiping = true;

    // Natural touch direction: finger up scrolls terminal up into older output.
    const lineDelta = -deltaY / 4.2;
    const moved = consumeLineDelta(lineDelta);

    const instantVelocity = lineDelta / (elapsedMs / 1000);
    if (moved) {
      swipe.velocityLinesPerSecond = (swipe.velocityLinesPerSecond * 0.72) + (instantVelocity * 0.28);
    }
    return moved;
  };

  const startMomentum = () => {
    if (Math.abs(swipe.velocityLinesPerSecond) < 8) {
      swipe.velocityLinesPerSecond = 0;
      swipe.lineAccumulator = 0;
      return;
    }

    stopMomentum();

    const tick = (ts) => {
      if (swipe.pointerId !== null || swipe.activeTouchId !== null) {
        stopMomentum();
        return;
      }

      if (!swipe.lastMomentumTs) {
        swipe.lastMomentumTs = ts;
      }

      const elapsedMs = Math.max(1, Math.min(34, ts - swipe.lastMomentumTs));
      swipe.lastMomentumTs = ts;

      const moved = consumeLineDelta((swipe.velocityLinesPerSecond * elapsedMs) / 1000);
      if (!moved) {
        swipe.velocityLinesPerSecond = 0;
        swipe.lineAccumulator = 0;
        stopMomentum();
        return;
      }

      const decay = Math.pow(0.88, elapsedMs / 16);
      swipe.velocityLinesPerSecond *= decay;

      if (Math.abs(swipe.velocityLinesPerSecond) < 2) {
        swipe.velocityLinesPerSecond = 0;
        swipe.lineAccumulator = 0;
        stopMomentum();
        return;
      }

      swipe.momentumRafId = requestAnimationFrame(tick);
    };

    swipe.momentumRafId = requestAnimationFrame(tick);
  };

  const endGesture = () => {
    const wasSwiping = swipe.isSwiping;
    swipe.pointerId = null;
    swipe.activeTouchId = null;
    swipe.startY = 0;
    swipe.lastY = 0;
    swipe.lastTs = 0;
    swipe.isSwiping = false;
    if (wasSwiping) {
      startMomentum();
    }
  };

  if (!isLikelyIOS && window.PointerEvent) {
    touchLayer.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
      }
      if (swipe.pointerId !== null) {
        return;
      }
      swipe.pointerId = event.pointerId;
      startGesture(event.clientY, event.timeStamp);
      if (typeof touchLayer.setPointerCapture === 'function') {
        try {
          touchLayer.setPointerCapture(event.pointerId);
        } catch (_error) {
          // Safari may intermittently reject pointer capture after viewport shifts.
        }
      }
    }, { passive: false });

    touchLayer.addEventListener('pointermove', (event) => {
      if (event.pointerId !== swipe.pointerId) {
        return;
      }
      const moved = updateGesture(event.clientY, event.timeStamp);
      if (moved || swipe.isSwiping) {
        event.preventDefault();
      }
    }, { passive: false });

    const releasePointer = (event) => {
      if (event.pointerId !== swipe.pointerId) {
        return;
      }
      const wasSwiping = swipe.isSwiping;
      endGesture();
      if (!wasSwiping) {
        term.focus();
      }
    };

    touchLayer.addEventListener('pointerup', releasePointer);
    touchLayer.addEventListener('pointercancel', releasePointer);
    touchLayer.addEventListener('lostpointercapture', releasePointer);
  } else {
    touchLayer.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1 || swipe.activeTouchId !== null) {
        return;
      }
      const touch = event.touches[0];
      swipe.activeTouchId = touch.identifier;
      startGesture(touch.clientY, event.timeStamp);
    }, { passive: false, capture: true });

    touchLayer.addEventListener('touchmove', (event) => {
      if (swipe.activeTouchId === null) {
        return;
      }
      const touch = Array.from(event.touches).find((item) => item.identifier === swipe.activeTouchId);
      if (!touch) {
        return;
      }
      const moved = updateGesture(touch.clientY, event.timeStamp);
      if (moved || swipe.isSwiping) {
        event.preventDefault();
      }
    }, { passive: false, capture: true });

    const releaseTouch = (event) => {
      if (swipe.activeTouchId === null) {
        return;
      }
      const ended = Array.from(event.changedTouches || []).some((item) => item.identifier === swipe.activeTouchId);
      if (!ended) {
        return;
      }
      const wasSwiping = swipe.isSwiping;
      endGesture();
      if (!wasSwiping) {
        term.focus();
      }
    };

    touchLayer.addEventListener('touchend', releaseTouch, { passive: true, capture: true });
    touchLayer.addEventListener('touchcancel', releaseTouch, { passive: true, capture: true });
  }

  touchLayer.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) < 0.5) {
      return;
    }
    stopMomentum();
    scrollTerminalHistory(Math.round(event.deltaY / 3));
    event.preventDefault();
  }, { passive: false });
}

term.onData((data) => {
  sendTerminalInput(data);
});

if (terminalPopoutVideoElement) {
  terminalPopoutVideoElement.addEventListener('enterpictureinpicture', () => {
    state.terminalPopoutActive = true;
    ensureTerminalPopoutRenderLoop();
    renderTerminalPopoutFrame();
    updatePopoutToggleButton();
  });

  terminalPopoutVideoElement.addEventListener('leavepictureinpicture', () => {
    applyTerminalPopoutClosedState({ preserveMedia: true });
  });

  terminalPopoutVideoElement.addEventListener('webkitpresentationmodechanged', () => {
    if (terminalPopoutVideoElement.webkitPresentationMode === 'picture-in-picture') {
      state.terminalPopoutActive = true;
      ensureTerminalPopoutRenderLoop();
      renderTerminalPopoutFrame();
      updatePopoutToggleButton();
      return;
    }

    applyTerminalPopoutClosedState({ preserveMedia: true });
  });
}

window.addEventListener('resize', () => {
  const nextWidth = window.innerWidth;
  const nextHeight = window.innerHeight;
  const deltaWidth = Math.abs(nextWidth - viewportResizeState.width);
  const deltaHeight = Math.abs(nextHeight - viewportResizeState.height);

  viewportResizeState.width = nextWidth;
  viewportResizeState.height = nextHeight;

  if (state.terminalFullscreen) {
    updateFullscreenViewportHeight();
  }
  if (state.terminalPopoutActive) {
    renderTerminalPopoutFrame();
  }

  if (isLikelyIOS && deltaWidth < 2 && deltaHeight < 2 && !state.terminalFullscreen) {
    return;
  }

  scheduleTerminalLayoutSync(70);
});

if (window.visualViewport) {
  const onVisualViewportChanged = () => {
    const nextWidth = Math.round(window.visualViewport.width);
    const nextHeight = Math.round(window.visualViewport.height);
    const deltaWidth = Math.abs(nextWidth - viewportResizeState.width);
    const deltaHeight = Math.abs(nextHeight - viewportResizeState.height);

    if (deltaWidth < 1 && deltaHeight < 1) {
      if (state.terminalFullscreen) {
        updateFullscreenViewportHeight();
      }
      if (state.terminalPopoutActive) {
        renderTerminalPopoutFrame();
      }
      return;
    }

    viewportResizeState.width = nextWidth;
    viewportResizeState.height = nextHeight;
    if (state.terminalFullscreen) {
      updateFullscreenViewportHeight();
    }
    if (state.terminalPopoutActive) {
      renderTerminalPopoutFrame();
    }
    scheduleTerminalLayoutSync(45);
  };

  window.visualViewport.addEventListener('resize', onVisualViewportChanged);
  window.visualViewport.addEventListener('scroll', onVisualViewportChanged);
}

if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => {
    scheduleTerminalLayoutSync(35);
  });
  observer.observe(terminalElement);
  state.terminalResizeObserver = observer;
}

sessionSelectElement.addEventListener('change', async (event) => {
  const nextSessionId = event.target.value;
  await switchSession(nextSessionId);
});

createSessionButton.addEventListener('click', async () => {
  try {
    await createSession();
  } catch (error) {
    setHint(`Could not create session: ${error.message}`);
  }
});

if (copyAttachCommandButton) {
  copyAttachCommandButton.addEventListener('click', async () => {
    if (!state.localAttachCommand) {
      return;
    }
    try {
      await copyTextToClipboard(state.localAttachCommand);
      setHint('Copied local attach command to clipboard.');
    } catch (error) {
      setHint(`Could not copy attach command: ${error.message}`);
    }
  });
}

deleteSessionButton.addEventListener('click', async () => {
  try {
    await deleteActiveSession();
  } catch (error) {
    setHint(`Could not delete session: ${error.message}`);
  }
});

viewPillConsoleElement.addEventListener('click', () => {
  setView('console');
});

viewPillMetricsElement.addEventListener('click', () => {
  setView('metrics');
});

if (terminalFullscreenToggleElement) {
  terminalFullscreenToggleElement.addEventListener('click', () => {
    setTerminalFullscreen(!state.terminalFullscreen);
  });
}

if (terminalPopoutToggleElement) {
  terminalPopoutToggleElement.addEventListener('click', async () => {
    await toggleTerminalPopout();
  });
}

codexSearchElement.addEventListener('input', (event) => {
  state.codexSearchTerm = event.target.value || '';
  renderCodexSessionList();
});

codexRefreshElement.addEventListener('click', async () => {
  codexRefreshElement.disabled = true;
  try {
    await refreshCodexSessions({ force: true });
  } catch (error) {
    setCodexStatus(`Index refresh failed: ${error.message}`);
  } finally {
    codexRefreshElement.disabled = false;
  }
});

metricsMonthElement.addEventListener('change', () => {
  state.metricsFilters.month = metricsMonthElement.value || getDefaultMetricsMonth();
  if (state.metricsFilters.selectedDay && !state.metricsFilters.selectedDay.startsWith(state.metricsFilters.month)) {
    state.metricsFilters.selectedDay = '';
  }
  renderMetricsDashboard();
});

metricsDateScopeElement.addEventListener('change', () => {
  state.metricsFilters.dateScope = metricsDateScopeElement.value === 'range' ? 'range' : 'all';
  if (state.metricsFilters.dateScope !== 'range') {
    state.metricsFilters.from = '';
    state.metricsFilters.to = '';
    if (state.metricsFilters.selectedDay) {
      state.metricsFilters.selectedDay = '';
    }
  }
  syncMetricsFilterInputs();
  renderMetricsDashboard();
});

metricsFromElement.addEventListener('change', () => {
  state.metricsFilters.from = metricsFromElement.value || '';
  if (state.metricsFilters.selectedDay && state.metricsFilters.from && state.metricsFilters.selectedDay < state.metricsFilters.from) {
    state.metricsFilters.selectedDay = '';
  }
  renderMetricsDashboard();
});

metricsToElement.addEventListener('change', () => {
  state.metricsFilters.to = metricsToElement.value || '';
  if (state.metricsFilters.selectedDay && state.metricsFilters.to && state.metricsFilters.selectedDay > state.metricsFilters.to) {
    state.metricsFilters.selectedDay = '';
  }
  renderMetricsDashboard();
});

metricsStatusElement.addEventListener('change', () => {
  state.metricsFilters.status = metricsStatusElement.value || '';
  renderMetricsDashboard();
});

metricsModelElement.addEventListener('change', () => {
  state.metricsFilters.model = metricsModelElement.value || '';
  renderMetricsDashboard();
});

metricsCwdElement.addEventListener('change', () => {
  state.metricsFilters.cwd = metricsCwdElement.value || '';
  renderMetricsDashboard();
});

metricsSearchElement.addEventListener('input', () => {
  state.metricsFilters.search = metricsSearchElement.value || '';
  renderMetricsDashboard();
});

metricsClearElement.addEventListener('click', () => {
  state.metricsFilters.dateScope = 'all';
  state.metricsFilters.month = getDefaultMetricsMonth();
  state.metricsFilters.from = '';
  state.metricsFilters.to = '';
  state.metricsFilters.status = '';
  state.metricsFilters.model = '';
  state.metricsFilters.cwd = '';
  state.metricsFilters.search = '';
  state.metricsFilters.selectedDay = '';
  syncMetricsFilterInputs();
  renderMetricsDashboard();
});

window.addEventListener('beforeunload', () => {
  if (state.codexRefreshTimer) {
    clearInterval(state.codexRefreshTimer);
    state.codexRefreshTimer = null;
  }
  applyTerminalPopoutClosedState({ suppressHint: true });
  clearServerScrollQueue();
  if (scrollSliderState.tickRafId !== null) {
    cancelAnimationFrame(scrollSliderState.tickRafId);
    scrollSliderState.tickRafId = null;
  }
  if (scrollSliderState.returnRafId !== null) {
    cancelAnimationFrame(scrollSliderState.returnRafId);
    scrollSliderState.returnRafId = null;
  }
  if (state.terminalResizeObserver) {
    state.terminalResizeObserver.disconnect();
    state.terminalResizeObserver = null;
  }
});

async function initialize() {
  try {
    setStatus('Loading sessions...', null);
    setCodexStatus('Loading session index...');
    syncMetricsFilterInputs();
    setView('console');
    await refreshSessions({ preserveSelection: false });
    await refreshCodexSessions({ force: true });
    scheduleCodexAutoRefresh();

    if (!state.activeSessionId) {
      await createSession();
      await refreshSessions({ preserveSelection: false });
    }

    connectSocket();
  } catch (error) {
    setStatus('Initialization failed', 'disconnected');
    setHint(`Failed to initialize terminal: ${error.message}`);
  }
}

initialize();
