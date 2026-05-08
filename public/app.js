const terminalElement = document.getElementById('terminal');
const statusElement = document.getElementById('connection');
const hintElement = document.getElementById('hint');
const sessionSelectElement = document.getElementById('session-select');
const createSessionButton = document.getElementById('new-session');
const deleteSessionButton = document.getElementById('delete-session');
const viewPillConsoleElement = document.getElementById('view-pill-console');
const consoleViewElement = document.getElementById('console-view');
const scrollSliderElement = document.getElementById('scroll-slider');
const scrollSliderThumbElement = document.getElementById('scroll-slider-thumb');
const terminalFullscreenToggleElement = document.getElementById('terminal-fullscreen-toggle');
const terminalPopoutToggleElement = document.getElementById('terminal-popout-toggle');
const terminalPopoutVideoElement = document.getElementById('terminal-popout-video');
const isLikelyIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
  terminalFullscreen: false,
  terminalPopoutActive: false,
  singleConsoleMode: false
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
let accessDeniedShown = false;

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

    const pipUnsupported = /picture-in-picture is not supported here/i.test(message)
      || /does not support the picture-in-picture mode/i.test(message);
    const standaloneDisplayMode = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : Boolean(window.navigator && window.navigator.standalone === true);
    if (pipUnsupported && standaloneDisplayMode) {
      applyTerminalPopoutClosedState({ suppressHint: true, preserveMedia: true });
      setHint('Terminal popout is unavailable in Home Screen mode on this iOS device.');
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

function showAccessDenied() {
  if (accessDeniedShown) {
    return;
  }
  accessDeniedShown = true;
  setStatus('Tailscale access required', 'disconnected');
  setHint('Connect to Tailscale and reload this page.');
}

function updateActiveSessionHint() {
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  if (!activeSession) {
    setHint('No active session selected.');
    return;
  }

  setHint(`Connected to ${activeSession.name}. Swipe the terminal or drag the slider below to scroll history.`);
}

function setView(view) {
  state.activeView = view === 'remote' ? 'remote' : 'console';

  if (state.activeView !== 'console') {
    if (state.terminalFullscreen) {
      setTerminalFullscreen(false);
    }
    return;
  }

  viewPillConsoleElement.classList.toggle('active', true);
  viewPillConsoleElement.setAttribute('aria-selected', 'true');
  consoleViewElement.classList.toggle('active', true);
  scheduleTerminalLayoutSync(0);
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
    if (response.status === 401 || response.status === 403) {
      showAccessDenied();
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
      showAccessDenied();
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

  // Fallback for full-screen terminal apps where local xterm scrollback can't move.
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

window.addEventListener('beforeunload', () => {
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
    setView('console');
    await refreshSessions({ preserveSelection: false });

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
