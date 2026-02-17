(function remoteDesktopModule() {
  const elements = {
    viewPillConsole: document.getElementById('view-pill-console'),
    viewPillMetrics: document.getElementById('view-pill-metrics'),
    viewPillRemote: document.getElementById('view-pill-remote'),
    consoleView: document.getElementById('console-view'),
    metricsView: document.getElementById('metrics-view'),
    remoteView: document.getElementById('remote-view'),
    modeSelect: document.getElementById('remote-mode-select'),
    openKeyboardButton: document.getElementById('remote-open-keyboard'),
    fullscreenButton: document.getElementById('remote-fullscreen-toggle'),
    streamStats: document.getElementById('remote-stream-stats'),
    capabilityStatus: document.getElementById('remote-capability-status'),
    connectionStatus: document.getElementById('remote-connection-status'),
    stage: document.getElementById('remote-stage'),
    canvas: document.getElementById('remote-canvas'),
    streamImage: document.getElementById('remote-stream-image'),
    overlay: document.getElementById('remote-overlay'),
    cursor: document.getElementById('remote-cursor'),
    zoomOutButton: document.getElementById('remote-zoom-out'),
    zoomInButton: document.getElementById('remote-zoom-in'),
    zoomLabel: document.getElementById('remote-zoom-label'),
    panToggleButton: document.getElementById('remote-pan-toggle'),
    resetViewButton: document.getElementById('remote-reset-view'),
    minimap: document.getElementById('remote-minimap'),
    minimapViewport: document.getElementById('remote-minimap-viewport'),
    leftClickButton: document.getElementById('remote-left-click'),
    rightClickButton: document.getElementById('remote-right-click'),
    doubleClickButton: document.getElementById('remote-double-click'),
    keyboardStatus: document.getElementById('remote-keyboard-status'),
    keyboardInput: document.getElementById('remote-keyboard-input')
  };

  if (
    !elements.viewPillRemote ||
    !elements.remoteView ||
    !elements.stage ||
    !elements.canvas ||
    !elements.streamImage
  ) {
    return;
  }

  const state = {
    activeView: 'console',
    statusPollTimer: null,
    reconnectTimer: null,
    reconnectBackoffMs: 1200,
    ws: null,
    wsGeneration: 0,
    manualDisconnect: false,
    streamUrl: null,
    enabled: false,
    sidecarReachable: false,
    inputAvailable: false,
    controlAllowed: false,
    desiredMode: normalizeMode(elements.modeSelect ? elements.modeSelect.value : 'view'),
    effectiveMode: 'view',
    hasFrame: false,
    frameFps: 0,
    frameLatencyMs: null,
    simulatedFullscreen: false,
    display: {
      desktopWidth: 1280,
      desktopHeight: 720,
      zoom: 1,
      minZoom: 1,
      maxZoom: 3.2,
      panX: 0,
      panY: 0,
      drawScale: 1,
      drawLeft: 0,
      drawTop: 0,
      drawWidth: 1280,
      drawHeight: 720,
      stageWidth: 0,
      stageHeight: 0
    },
    panMode: false,
    pointer: {
      lastNormalizedX: 0.5,
      lastNormalizedY: 0.5,
      lastMoveSentAt: 0,
      hideCursorTimer: null
    },
    touch: {
      active: false,
      touchId: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      moved: false,
      longPressTimer: null,
      longPressTriggered: false,
      twoFingerActive: false,
      twoFingerLastY: 0
    },
    panGesture: {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0
    }
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeMode(value) {
    return value === 'control' ? 'control' : 'view';
  }

  function isRemoteViewActive() {
    return state.activeView === 'remote';
  }

  function isWsOpen() {
    return state.ws && state.ws.readyState === WebSocket.OPEN;
  }

  function isControlActive() {
    return (
      isRemoteViewActive() &&
      state.effectiveMode === 'control' &&
      state.controlAllowed === true &&
      isWsOpen()
    );
  }

  function setConnectionState(text, kind) {
    if (!elements.connectionStatus) {
      return;
    }
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.classList.remove('connected', 'disconnected', 'warn');
    if (kind === 'connected' || kind === 'disconnected' || kind === 'warn') {
      elements.connectionStatus.classList.add(kind);
    }
  }

  function setOverlayText(text) {
    if (!elements.overlay) {
      return;
    }
    elements.overlay.textContent = text;
  }

  function updateStatsText() {
    if (!elements.streamStats) {
      return;
    }
    const fps = Number.isFinite(state.frameFps) ? state.frameFps : 0;
    const latency = Number.isFinite(state.frameLatencyMs)
      ? `${Math.round(state.frameLatencyMs)} ms`
      : '-- ms';
    elements.streamStats.textContent = `fps: ${fps.toFixed(1)} | latency: ${latency}`;
  }

  function updateCapabilityText() {
    if (!elements.capabilityStatus) {
      return;
    }

    if (state.enabled !== true) {
      elements.capabilityStatus.textContent = 'Remote is disabled on the server.';
      return;
    }

    if (state.sidecarReachable !== true) {
      elements.capabilityStatus.textContent = 'Remote sidecar is offline or unreachable.';
      return;
    }

    const inputLabel = state.inputAvailable === true ? 'control available' : 'view-only (input unavailable)';
    const panLabel = state.panMode ? 'pan mode on' : 'pan mode off';
    elements.capabilityStatus.textContent = `mode: ${state.effectiveMode} | ${inputLabel} | ${panLabel}`;
  }

  function updateKeyboardStatus() {
    if (!elements.keyboardStatus) {
      return;
    }

    if (state.effectiveMode !== 'control' || state.controlAllowed !== true) {
      elements.keyboardStatus.textContent = 'Switch control mode to "Control enabled" before typing remotely.';
      return;
    }

    if (!isWsOpen()) {
      elements.keyboardStatus.textContent = 'Waiting for websocket connection before typing remotely.';
      return;
    }

    elements.keyboardStatus.textContent = 'Remote keyboard is ready. Use "Open Keyboard" on mobile.';
  }

  function updateModeUi() {
    if (elements.modeSelect) {
      const allowControl = state.inputAvailable === true;
      const controlOption = Array.from(elements.modeSelect.options || []).find((opt) => opt.value === 'control');
      if (controlOption) {
        controlOption.disabled = !allowControl;
      }
      if (!allowControl && state.desiredMode === 'control') {
        state.desiredMode = 'view';
      }
      elements.modeSelect.value = normalizeMode(state.desiredMode);
      elements.modeSelect.disabled = state.enabled !== true;
    }

    if (elements.openKeyboardButton) {
      elements.openKeyboardButton.disabled = !(
        state.effectiveMode === 'control' &&
        state.controlAllowed === true &&
        state.enabled === true &&
        isWsOpen()
      );
    }

    const controlsEnabled = state.enabled === true && state.sidecarReachable === true;
    if (elements.leftClickButton) elements.leftClickButton.disabled = !controlsEnabled;
    if (elements.rightClickButton) elements.rightClickButton.disabled = !controlsEnabled;
    if (elements.doubleClickButton) elements.doubleClickButton.disabled = !controlsEnabled;

    updateKeyboardStatus();
    updateCapabilityText();
  }

  function revokeFrameUrl() {
    if (!state.streamUrl) {
      return;
    }
    URL.revokeObjectURL(state.streamUrl);
    state.streamUrl = null;
  }

  function setFrameVisibility(hasFrame) {
    state.hasFrame = hasFrame === true;
    elements.stage.classList.toggle('has-frame', state.hasFrame);
  }

  function resetFrame() {
    revokeFrameUrl();
    setFrameVisibility(false);
    state.frameFps = 0;
    state.frameLatencyMs = null;
    updateStatsText();
    elements.streamImage.removeAttribute('src');
  }

  function updateDesktopDimensions(width, height) {
    const nextWidth = Number(width);
    const nextHeight = Number(height);
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 200 || nextHeight < 120) {
      return;
    }
    state.display.desktopWidth = Math.round(nextWidth);
    state.display.desktopHeight = Math.round(nextHeight);
    recomputeViewport();
  }

  function getStageRect() {
    return elements.stage.getBoundingClientRect();
  }

  function clampPan() {
    const maxPanX = Math.max(0, (state.display.drawWidth - state.display.stageWidth) / 2);
    const maxPanY = Math.max(0, (state.display.drawHeight - state.display.stageHeight) / 2);
    state.display.panX = clamp(state.display.panX, -maxPanX, maxPanX);
    state.display.panY = clamp(state.display.panY, -maxPanY, maxPanY);
  }

  function recomputeViewport() {
    const stageRect = getStageRect();
    const stageWidth = Math.max(1, Math.round(stageRect.width));
    const stageHeight = Math.max(1, Math.round(stageRect.height));
    state.display.stageWidth = stageWidth;
    state.display.stageHeight = stageHeight;

    const fitScale = Math.min(
      stageWidth / state.display.desktopWidth,
      stageHeight / state.display.desktopHeight
    );
    state.display.drawScale = fitScale * state.display.zoom;
    state.display.drawWidth = state.display.desktopWidth * state.display.drawScale;
    state.display.drawHeight = state.display.desktopHeight * state.display.drawScale;

    clampPan();

    state.display.drawLeft = ((stageWidth - state.display.drawWidth) / 2) + state.display.panX;
    state.display.drawTop = ((stageHeight - state.display.drawHeight) / 2) + state.display.panY;

    elements.stage.style.setProperty('--remote-desktop-width', `${state.display.desktopWidth}px`);
    elements.stage.style.setProperty('--remote-desktop-height', `${state.display.desktopHeight}px`);
    elements.stage.style.setProperty('--remote-scale', `${state.display.drawScale}`);
    elements.stage.style.setProperty('--remote-offset-x', `${state.display.drawLeft}px`);
    elements.stage.style.setProperty('--remote-offset-y', `${state.display.drawTop}px`);

    if (elements.zoomLabel) {
      elements.zoomLabel.textContent = `${state.display.zoom.toFixed(1)}x`;
    }
    if (elements.zoomOutButton) {
      elements.zoomOutButton.disabled = state.display.zoom <= state.display.minZoom + 0.001;
    }
    if (elements.zoomInButton) {
      elements.zoomInButton.disabled = state.display.zoom >= state.display.maxZoom - 0.001;
    }

    updateMinimap();
    paintCursor();
  }

  function updateMinimap() {
    if (!elements.minimap || !elements.minimapViewport) {
      return;
    }

    const shouldShow = state.display.zoom > 1.02;
    elements.minimap.hidden = !shouldShow;
    if (!shouldShow) {
      return;
    }

    const mapRect = elements.minimap.getBoundingClientRect();
    const mapWidth = Math.max(1, mapRect.width);
    const mapHeight = Math.max(1, mapRect.height);
    const mapScale = Math.min(
      (mapWidth - 2) / state.display.desktopWidth,
      (mapHeight - 2) / state.display.desktopHeight
    );

    const contentWidth = state.display.desktopWidth * mapScale;
    const contentHeight = state.display.desktopHeight * mapScale;
    const mapLeft = (mapWidth - contentWidth) / 2;
    const mapTop = (mapHeight - contentHeight) / 2;

    const viewportDesktopWidth = state.display.stageWidth / state.display.drawScale;
    const viewportDesktopHeight = state.display.stageHeight / state.display.drawScale;
    const viewportDesktopLeft = clamp(
      (0 - state.display.drawLeft) / state.display.drawScale,
      0,
      Math.max(0, state.display.desktopWidth - viewportDesktopWidth)
    );
    const viewportDesktopTop = clamp(
      (0 - state.display.drawTop) / state.display.drawScale,
      0,
      Math.max(0, state.display.desktopHeight - viewportDesktopHeight)
    );

    const viewportLeft = mapLeft + (viewportDesktopLeft * mapScale);
    const viewportTop = mapTop + (viewportDesktopTop * mapScale);
    const viewportWidth = clamp(viewportDesktopWidth * mapScale, 10, contentWidth);
    const viewportHeight = clamp(viewportDesktopHeight * mapScale, 10, contentHeight);

    elements.minimapViewport.style.left = `${viewportLeft}px`;
    elements.minimapViewport.style.top = `${viewportTop}px`;
    elements.minimapViewport.style.width = `${viewportWidth}px`;
    elements.minimapViewport.style.height = `${viewportHeight}px`;
  }

  function centerViewport() {
    state.display.zoom = 1;
    state.display.panX = 0;
    state.display.panY = 0;
    recomputeViewport();
  }

  function setZoom(nextZoom) {
    const clamped = clamp(nextZoom, state.display.minZoom, state.display.maxZoom);
    if (Math.abs(clamped - state.display.zoom) < 0.001) {
      return;
    }
    state.display.zoom = clamped;
    recomputeViewport();
  }

  function panBy(deltaX, deltaY) {
    state.display.panX += deltaX;
    state.display.panY += deltaY;
    recomputeViewport();
  }

  function panToDesktopCenter(normalizedX, normalizedY) {
    const nx = clamp(normalizedX, 0, 1);
    const ny = clamp(normalizedY, 0, 1);

    const desiredDrawLeft = (state.display.stageWidth / 2) - (nx * state.display.desktopWidth * state.display.drawScale);
    const desiredDrawTop = (state.display.stageHeight / 2) - (ny * state.display.desktopHeight * state.display.drawScale);
    const centeredDrawLeft = (state.display.stageWidth - state.display.drawWidth) / 2;
    const centeredDrawTop = (state.display.stageHeight - state.display.drawHeight) / 2;

    state.display.panX = desiredDrawLeft - centeredDrawLeft;
    state.display.panY = desiredDrawTop - centeredDrawTop;
    recomputeViewport();
  }

  function hideCursorSoon() {
    if (state.pointer.hideCursorTimer) {
      clearTimeout(state.pointer.hideCursorTimer);
    }
    state.pointer.hideCursorTimer = setTimeout(() => {
      elements.stage.classList.add('cursor-hidden');
    }, 2500);
  }

  function paintCursor() {
    if (!elements.cursor || !Number.isFinite(state.pointer.lastNormalizedX) || !Number.isFinite(state.pointer.lastNormalizedY)) {
      return;
    }

    const desktopX = state.pointer.lastNormalizedX * state.display.desktopWidth;
    const desktopY = state.pointer.lastNormalizedY * state.display.desktopHeight;
    const stageX = state.display.drawLeft + (desktopX * state.display.drawScale);
    const stageY = state.display.drawTop + (desktopY * state.display.drawScale);

    elements.cursor.style.left = `${stageX}px`;
    elements.cursor.style.top = `${stageY}px`;
    elements.cursor.hidden = false;
    elements.stage.classList.remove('cursor-hidden');
    hideCursorSoon();
  }

  function setPointerNormalized(normalizedX, normalizedY) {
    state.pointer.lastNormalizedX = clamp(normalizedX, 0, 1);
    state.pointer.lastNormalizedY = clamp(normalizedY, 0, 1);
    paintCursor();
  }

  function normalizedFromClient(clientX, clientY) {
    const rect = getStageRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    const stageX = clientX - rect.left;
    const stageY = clientY - rect.top;
    const desktopX = (stageX - state.display.drawLeft) / state.display.drawScale;
    const desktopY = (stageY - state.display.drawTop) / state.display.drawScale;

    const normalizedX = clamp(desktopX / state.display.desktopWidth, 0, 1);
    const normalizedY = clamp(desktopY / state.display.desktopHeight, 0, 1);

    return {
      x: normalizedX,
      y: normalizedY
    };
  }

  async function requestJson(path, options) {
    const response = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...(options || {})
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_error) {
        payload = null;
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        window.location.assign('/login');
        throw new Error('Authentication required');
      }
      throw new Error(payload && payload.error ? payload.error : `Request failed (${response.status})`);
    }

    return payload;
  }

  function sendRemoteMessage(payload) {
    if (!isWsOpen()) {
      return false;
    }
    try {
      state.ws.send(JSON.stringify(payload));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function sendInputEvent(event) {
    if (!isControlActive()) {
      return false;
    }
    return sendRemoteMessage({
      type: 'input',
      event
    });
  }

  function sendTextPayload(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return false;
    }
    const normalized = text.replace(/\r\n/g, '\n');
    let sentAny = false;
    for (let index = 0; index < normalized.length; index += 64) {
      const chunk = normalized.slice(index, index + 64);
      sentAny = sendInputEvent({ type: 'text', text: chunk }) || sentAny;
    }
    return sentAny;
  }

  function sendKeyPressFromEvent(event) {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const key = typeof event.key === 'string' ? event.key : '';
    const code = typeof event.code === 'string' ? event.code : '';
    const plainPrintable = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plainPrintable) {
      return sendTextPayload(key);
    }

    return sendInputEvent({
      type: 'key',
      action: 'press',
      key: key.slice(0, 64),
      code: code.slice(0, 64),
      modifiers: {
        alt: event.altKey === true,
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        shift: event.shiftKey === true
      }
    });
  }

  function sendPointerMove(normalized) {
    const now = Date.now();
    if ((now - state.pointer.lastMoveSentAt) < 12) {
      return false;
    }
    state.pointer.lastMoveSentAt = now;
    return sendInputEvent({
      type: 'mouse_move',
      x: normalized.x,
      y: normalized.y
    });
  }

  function sendMouseClick(button, normalized) {
    const target = normalized || {
      x: state.pointer.lastNormalizedX,
      y: state.pointer.lastNormalizedY
    };
    return sendInputEvent({
      type: 'mouse_button',
      button,
      action: 'click',
      x: target.x,
      y: target.y
    });
  }

  function sendMouseWheel(deltaY, normalized) {
    const target = normalized || {
      x: state.pointer.lastNormalizedX,
      y: state.pointer.lastNormalizedY
    };
    return sendInputEvent({
      type: 'mouse_wheel',
      deltaX: 0,
      deltaY: clamp(Math.round(deltaY), -1200, 1200),
      x: target.x,
      y: target.y
    });
  }

  function clearLongPressTimer() {
    if (state.touch.longPressTimer) {
      clearTimeout(state.touch.longPressTimer);
      state.touch.longPressTimer = null;
    }
  }

  function resetTouchState() {
    clearLongPressTimer();
    state.touch.active = false;
    state.touch.touchId = null;
    state.touch.moved = false;
    state.touch.longPressTriggered = false;
    state.touch.twoFingerActive = false;
    state.touch.twoFingerLastY = 0;
  }

  function handleRemoteControlEnvelope(message) {
    if (!message || message.__onlineCliControl !== true || message.channel !== 'remote') {
      return;
    }

    if (message.type === 'remote-ready') {
      state.controlAllowed = message.controlAllowed === true;
      state.effectiveMode = normalizeMode(message.mode);
      updateModeUi();
      return;
    }

    if (message.type === 'remote-mode') {
      state.controlAllowed = message.controlAllowed === true;
      state.effectiveMode = normalizeMode(message.mode);
      updateModeUi();
      return;
    }

    if (message.type === 'remote-stream-connected') {
      setConnectionState('Connected', 'connected');
      if (!state.hasFrame) {
        setOverlayText('Connected. Waiting for first frame...');
      }
      return;
    }

    if (message.type === 'remote-stream-disconnected') {
      setConnectionState('Stream disconnected', 'disconnected');
      if (!state.hasFrame) {
        setOverlayText('Remote stream disconnected.');
      }
      return;
    }

    if (message.type === 'remote-stream-error') {
      const text = typeof message.message === 'string' ? message.message : 'Remote stream error.';
      setOverlayText(text);
      return;
    }

    if (message.type === 'remote-input-error' || message.type === 'remote-input-disconnected') {
      updateCapabilityText();
      return;
    }

    if (message.type === 'remote-input-throttled') {
      if (elements.capabilityStatus) {
        elements.capabilityStatus.textContent = 'Input throttled by server rate limit.';
      }
      return;
    }

    if (message.type === 'remote-input-backpressure') {
      if (elements.capabilityStatus) {
        elements.capabilityStatus.textContent = 'Input queue saturated, reducing send rate.';
      }
      return;
    }

    if (message.type === 'remote-stats') {
      if (Number.isFinite(Number(message.fps))) {
        state.frameFps = Number(message.fps);
      }
      if (Number.isFinite(Number(message.captureTs))) {
        state.frameLatencyMs = clamp(Date.now() - Number(message.captureTs), 0, 60_000);
      } else if (Number.isFinite(Number(message.captureLatencyMs))) {
        state.frameLatencyMs = clamp(Number(message.captureLatencyMs), 0, 60_000);
      }
      updateStatsText();
    }
  }

  function handleSocketBinaryFrame(binaryPayload) {
    const blob = binaryPayload instanceof Blob
      ? binaryPayload
      : new Blob([binaryPayload], { type: 'image/jpeg' });

    const nextUrl = URL.createObjectURL(blob);
    const previousUrl = state.streamUrl;
    state.streamUrl = nextUrl;
    elements.streamImage.src = nextUrl;
    setFrameVisibility(true);
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }
  }

  function clearReconnectTimer() {
    if (!state.reconnectTimer) {
      return;
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (!isRemoteViewActive() || state.enabled !== true || state.sidecarReachable !== true) {
      return;
    }
    if (state.reconnectTimer) {
      return;
    }
    const nextDelay = state.reconnectBackoffMs;
    state.reconnectBackoffMs = clamp(state.reconnectBackoffMs + 400, 1200, 5000);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      ensureRemoteSocket().catch(() => {});
    }, nextDelay);
  }

  function disconnectRemoteSocket(options) {
    const opts = options || {};
    state.manualDisconnect = opts.manual === true;
    clearReconnectTimer();
    state.wsGeneration += 1;

    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      try {
        state.ws.close();
      } catch (_error) {
        // Ignore close races.
      }
    }
    state.ws = null;
    state.effectiveMode = 'view';
    state.controlAllowed = false;
    if (!opts.preserveFrame) {
      resetFrame();
    }
    updateModeUi();
  }

  async function refreshRemoteStatus(force) {
    const query = force ? '?force=1' : '';
    try {
      const status = await requestJson(`/api/remote/status${query}`);
      state.enabled = status && status.enabled === true;
      state.sidecarReachable = Boolean(status && status.sidecar && status.sidecar.reachable === true);
      state.inputAvailable = Boolean(status && status.sidecar && status.sidecar.inputAvailable === true);

      const defaultMode = normalizeMode(status ? status.defaultMode : 'view');
      if (state.desiredMode !== 'control') {
        state.desiredMode = defaultMode;
      }
      if (state.desiredMode === 'control' && state.inputAvailable !== true) {
        state.desiredMode = 'view';
      }

      const displayInfo = status && status.sidecar && status.sidecar.health && status.sidecar.health.display
        ? status.sidecar.health.display
        : null;
      if (displayInfo) {
        updateDesktopDimensions(displayInfo.width, displayInfo.height);
      }

      if (state.enabled !== true) {
        setConnectionState('Remote disabled', 'disconnected');
        setOverlayText('Remote capability is disabled on this server.');
        disconnectRemoteSocket({ manual: true, preserveFrame: false });
      } else if (state.sidecarReachable !== true) {
        setConnectionState('Sidecar offline', 'disconnected');
        setOverlayText('Remote sidecar is offline or unreachable.');
        disconnectRemoteSocket({ manual: true, preserveFrame: true });
      } else if (!isWsOpen()) {
        setConnectionState('Ready', 'warn');
        if (!state.hasFrame) {
          setOverlayText('Ready to connect.');
        }
      }
      updateModeUi();
      return true;
    } catch (error) {
      state.enabled = false;
      state.sidecarReachable = false;
      state.inputAvailable = false;
      updateModeUi();
      setConnectionState('Status unavailable', 'disconnected');
      setOverlayText(`Remote status failed: ${error.message}`);
      return false;
    }
  }

  async function requestRemoteToken() {
    return requestJson('/api/remote/token', {
      method: 'POST',
      body: JSON.stringify({
        mode: state.desiredMode
      })
    });
  }

  async function ensureRemoteSocket() {
    if (!isRemoteViewActive()) {
      return;
    }

    if (state.enabled !== true || state.sidecarReachable !== true) {
      const ok = await refreshRemoteStatus(true);
      if (!ok || state.enabled !== true || state.sidecarReachable !== true) {
        return;
      }
    }

    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearReconnectTimer();
    state.manualDisconnect = false;
    state.wsGeneration += 1;
    const currentGeneration = state.wsGeneration;
    setConnectionState('Connecting...', 'warn');
    if (!state.hasFrame) {
      setOverlayText('Connecting to remote stream...');
    }

    let tokenPayload = null;
    try {
      tokenPayload = await requestRemoteToken();
    } catch (error) {
      setConnectionState('Token request failed', 'disconnected');
      setOverlayText(`Could not start remote stream: ${error.message}`);
      scheduleReconnect();
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsPath = tokenPayload && tokenPayload.wsPath ? tokenPayload.wsPath : '/ws/remote';
    const wsUrl = `${protocol}://${window.location.host}${wsPath}?token=${encodeURIComponent(tokenPayload.token)}`;
    const socket = new WebSocket(wsUrl);
    state.ws = socket;

    socket.addEventListener('open', () => {
      if (state.ws !== socket || currentGeneration !== state.wsGeneration) {
        return;
      }
      state.reconnectBackoffMs = 1200;
      state.controlAllowed = tokenPayload.controlAllowed === true;
      state.effectiveMode = normalizeMode(tokenPayload.mode);
      updateModeUi();
      setConnectionState('Connected to gateway', 'warn');
      if (!state.hasFrame) {
        setOverlayText('Waiting for remote frames...');
      }
    });

    socket.addEventListener('message', (event) => {
      if (state.ws !== socket || currentGeneration !== state.wsGeneration) {
        return;
      }

      if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
        handleSocketBinaryFrame(event.data);
        return;
      }

      if (typeof event.data !== 'string') {
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (_error) {
        return;
      }
      handleRemoteControlEnvelope(payload);
    });

    socket.addEventListener('close', (event) => {
      if (state.ws !== socket || currentGeneration !== state.wsGeneration) {
        return;
      }
      state.ws = null;
      state.controlAllowed = false;
      state.effectiveMode = 'view';
      updateModeUi();

      if (state.manualDisconnect) {
        state.manualDisconnect = false;
        return;
      }

      setConnectionState(`Disconnected (${event.code})`, 'disconnected');
      if (!state.hasFrame) {
        setOverlayText('Remote stream disconnected.');
      }
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (currentGeneration !== state.wsGeneration) {
        return;
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  }

  function startStatusPolling() {
    if (state.statusPollTimer) {
      return;
    }
    state.statusPollTimer = setInterval(() => {
      refreshRemoteStatus(false).then(() => {
        if (isRemoteViewActive()) {
          ensureRemoteSocket().catch(() => {});
        }
      }).catch(() => {});
    }, 3500);
  }

  function stopStatusPolling() {
    if (!state.statusPollTimer) {
      return;
    }
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }

  function applyViewPills(activeView) {
    const isConsole = activeView === 'console';
    const isMetrics = activeView === 'metrics';
    const isRemote = activeView === 'remote';

    if (elements.viewPillConsole) {
      elements.viewPillConsole.classList.toggle('active', isConsole);
      elements.viewPillConsole.setAttribute('aria-selected', isConsole ? 'true' : 'false');
    }
    if (elements.viewPillMetrics) {
      elements.viewPillMetrics.classList.toggle('active', isMetrics);
      elements.viewPillMetrics.setAttribute('aria-selected', isMetrics ? 'true' : 'false');
    }
    if (elements.viewPillRemote) {
      elements.viewPillRemote.classList.toggle('active', isRemote);
      elements.viewPillRemote.setAttribute('aria-selected', isRemote ? 'true' : 'false');
    }

    if (elements.consoleView) {
      elements.consoleView.classList.toggle('active', isConsole);
    }
    if (elements.metricsView) {
      elements.metricsView.classList.toggle('active', isMetrics);
    }
    elements.remoteView.classList.toggle('active', isRemote);
  }

  function activateRemoteView() {
    state.activeView = 'remote';
    applyViewPills('remote');
    recomputeViewport();
    refreshRemoteStatus(true).then(() => {
      ensureRemoteSocket().catch(() => {});
    }).catch(() => {});
    startStatusPolling();
    elements.stage.focus({ preventScroll: true });
  }

  function deactivateRemoteView(nextView) {
    state.activeView = nextView;
    applyViewPills(nextView);
    exitSimulatedFullscreen();
    stopStatusPolling();
    disconnectRemoteSocket({ manual: true, preserveFrame: true });
    if (elements.keyboardInput) {
      elements.keyboardInput.blur();
    }
  }

  function setPanMode(enabled) {
    state.panMode = enabled === true;
    if (!state.panMode) {
      state.panGesture.active = false;
      state.panGesture.pointerId = null;
    }
    if (elements.panToggleButton) {
      elements.panToggleButton.setAttribute('aria-pressed', state.panMode ? 'true' : 'false');
      elements.panToggleButton.textContent = state.panMode ? 'Pan On' : 'Pan';
    }
    updateCapabilityText();
  }

  function isNativeFullscreenActive() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    return fullscreenElement === elements.stage;
  }

  function isFullscreenActive() {
    return isNativeFullscreenActive() || state.simulatedFullscreen === true;
  }

  function enterSimulatedFullscreen() {
    state.simulatedFullscreen = true;
    document.body.classList.add('remote-simulated-fullscreen');
    recomputeViewport();
  }

  function exitSimulatedFullscreen() {
    if (!state.simulatedFullscreen) {
      return;
    }
    state.simulatedFullscreen = false;
    document.body.classList.remove('remote-simulated-fullscreen');
    recomputeViewport();
  }

  function updateFullscreenButton() {
    if (!elements.fullscreenButton) {
      return;
    }
    const isFullscreen = isFullscreenActive();
    elements.fullscreenButton.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
    elements.fullscreenButton.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
  }

  function isEventFromStageControl(target) {
    if (!target || typeof target.closest !== 'function') {
      return false;
    }
    return Boolean(
      target.closest('.remote-nav-overlay') ||
      target.closest('.remote-minimap')
    );
  }

  function moveViewportFromMinimapClient(clientX, clientY) {
    if (!elements.minimap || elements.minimap.hidden) {
      return;
    }
    const rect = elements.minimap.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const localX = clamp(clientX - rect.left, 0, rect.width);
    const localY = clamp(clientY - rect.top, 0, rect.height);

    const mapScale = Math.min(
      (rect.width - 2) / state.display.desktopWidth,
      (rect.height - 2) / state.display.desktopHeight
    );
    const contentWidth = state.display.desktopWidth * mapScale;
    const contentHeight = state.display.desktopHeight * mapScale;
    const mapLeft = (rect.width - contentWidth) / 2;
    const mapTop = (rect.height - contentHeight) / 2;

    const desktopX = clamp((localX - mapLeft) / mapScale, 0, state.display.desktopWidth);
    const desktopY = clamp((localY - mapTop) / mapScale, 0, state.display.desktopHeight);
    panToDesktopCenter(desktopX / state.display.desktopWidth, desktopY / state.display.desktopHeight);
  }

  function applyRequestedMode(nextMode) {
    const normalized = normalizeMode(nextMode);
    if (normalized === 'control' && state.inputAvailable !== true) {
      state.desiredMode = 'view';
      updateModeUi();
      setOverlayText('Remote input is unavailable, staying in view-only mode.');
      return;
    }

    state.desiredMode = normalized;
    updateModeUi();

    if (!isWsOpen()) {
      ensureRemoteSocket().catch(() => {});
      return;
    }

    sendRemoteMessage({
      type: 'set-mode',
      mode: normalized
    });
  }

  function bindPointerAndTouchHandlers() {
    elements.stage.addEventListener('contextmenu', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (!isControlActive() || state.panMode) {
        return;
      }
      const normalized = normalizedFromClient(event.clientX, event.clientY);
      if (!normalized) {
        return;
      }
      setPointerNormalized(normalized.x, normalized.y);
      sendMouseClick('right', normalized);
      event.preventDefault();
    });

    elements.stage.addEventListener('wheel', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (!isControlActive() || state.panMode) {
        return;
      }
      const normalized = normalizedFromClient(event.clientX, event.clientY);
      if (!normalized) {
        return;
      }
      setPointerNormalized(normalized.x, normalized.y);
      sendMouseWheel(event.deltaY, normalized);
      event.preventDefault();
    }, { passive: false });

    elements.stage.addEventListener('pointerdown', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (event.pointerType === 'mouse') {
        if (state.panMode && event.button === 0) {
          state.panGesture.active = true;
          state.panGesture.pointerId = event.pointerId;
          state.panGesture.lastX = event.clientX;
          state.panGesture.lastY = event.clientY;
          elements.stage.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }

        if (!isControlActive()) {
          return;
        }

        const normalized = normalizedFromClient(event.clientX, event.clientY);
        if (!normalized) {
          return;
        }
        setPointerNormalized(normalized.x, normalized.y);
      }
    });

    elements.stage.addEventListener('pointermove', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (event.pointerType !== 'mouse') {
        return;
      }

      if (state.panGesture.active && state.panGesture.pointerId === event.pointerId) {
        const deltaX = event.clientX - state.panGesture.lastX;
        const deltaY = event.clientY - state.panGesture.lastY;
        state.panGesture.lastX = event.clientX;
        state.panGesture.lastY = event.clientY;
        panBy(deltaX, deltaY);
        event.preventDefault();
        return;
      }

      if (!isControlActive() || state.panMode) {
        return;
      }

      const normalized = normalizedFromClient(event.clientX, event.clientY);
      if (!normalized) {
        return;
      }
      setPointerNormalized(normalized.x, normalized.y);
      if (event.buttons !== 0) {
        sendPointerMove(normalized);
      } else {
        const now = Date.now();
        if ((now - state.pointer.lastMoveSentAt) >= 120) {
          sendPointerMove(normalized);
        }
      }
    });

    const releasePanPointer = (event) => {
      if (!state.panGesture.active || state.panGesture.pointerId !== event.pointerId) {
        return;
      }
      state.panGesture.active = false;
      state.panGesture.pointerId = null;
    };

    elements.stage.addEventListener('pointerup', (event) => {
      if (isEventFromStageControl(event.target)) {
        releasePanPointer(event);
        return;
      }
      releasePanPointer(event);
      if (event.pointerType !== 'mouse' || state.panMode || !isControlActive()) {
        return;
      }
      if (event.button === 0) {
        const normalized = normalizedFromClient(event.clientX, event.clientY);
        if (!normalized) {
          return;
        }
        setPointerNormalized(normalized.x, normalized.y);
        sendMouseClick('left', normalized);
        event.preventDefault();
      }
    });
    elements.stage.addEventListener('pointercancel', releasePanPointer);
    elements.stage.addEventListener('lostpointercapture', releasePanPointer);

    elements.stage.addEventListener('touchstart', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (!isControlActive() && !state.panMode) {
        return;
      }

      if (state.panMode && event.touches.length === 1) {
        const touch = event.touches[0];
        state.panGesture.active = true;
        state.panGesture.lastX = touch.clientX;
        state.panGesture.lastY = touch.clientY;
        event.preventDefault();
        return;
      }

      if (event.touches.length === 2) {
        clearLongPressTimer();
        state.touch.twoFingerActive = true;
        state.touch.active = false;
        state.touch.touchId = null;
        state.touch.twoFingerLastY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        event.preventDefault();
        return;
      }

      if (!isControlActive() || event.touches.length !== 1) {
        return;
      }

      const touch = event.touches[0];
      state.touch.active = true;
      state.touch.touchId = touch.identifier;
      state.touch.startX = touch.clientX;
      state.touch.startY = touch.clientY;
      state.touch.lastX = touch.clientX;
      state.touch.lastY = touch.clientY;
      state.touch.moved = false;
      state.touch.longPressTriggered = false;

      clearLongPressTimer();
      state.touch.longPressTimer = setTimeout(() => {
        if (!state.touch.active || state.touch.moved || state.touch.twoFingerActive || !isControlActive()) {
          return;
        }
        const normalized = normalizedFromClient(state.touch.lastX, state.touch.lastY);
        if (!normalized) {
          return;
        }
        setPointerNormalized(normalized.x, normalized.y);
        const sent = sendMouseClick('right', normalized);
        if (sent) {
          state.touch.longPressTriggered = true;
        }
      }, 460);

      event.preventDefault();
    }, { passive: false });

    elements.stage.addEventListener('touchmove', (event) => {
      if (isEventFromStageControl(event.target)) {
        return;
      }
      if (state.panMode && state.panGesture.active && event.touches.length === 1) {
        const touch = event.touches[0];
        const deltaX = touch.clientX - state.panGesture.lastX;
        const deltaY = touch.clientY - state.panGesture.lastY;
        state.panGesture.lastX = touch.clientX;
        state.panGesture.lastY = touch.clientY;
        panBy(deltaX, deltaY);
        event.preventDefault();
        return;
      }

      if (!isControlActive()) {
        return;
      }

      if (state.touch.twoFingerActive && event.touches.length === 2) {
        const averageY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        const deltaY = averageY - state.touch.twoFingerLastY;
        state.touch.twoFingerLastY = averageY;
        if (Math.abs(deltaY) > 0.8) {
          const normalized = normalizedFromClient(event.touches[0].clientX, averageY);
          if (normalized) {
            setPointerNormalized(normalized.x, normalized.y);
            sendMouseWheel(deltaY * 18, normalized);
          }
        }
        event.preventDefault();
        return;
      }

      if (!state.touch.active || event.touches.length !== 1) {
        return;
      }

      const touch = Array.from(event.touches).find((item) => item.identifier === state.touch.touchId);
      if (!touch) {
        return;
      }

      state.touch.lastX = touch.clientX;
      state.touch.lastY = touch.clientY;
      const movedX = Math.abs(state.touch.lastX - state.touch.startX);
      const movedY = Math.abs(state.touch.lastY - state.touch.startY);
      if (movedX > 6 || movedY > 6) {
        state.touch.moved = true;
        clearLongPressTimer();
        const normalized = normalizedFromClient(touch.clientX, touch.clientY);
        if (normalized) {
          setPointerNormalized(normalized.x, normalized.y);
          sendPointerMove(normalized);
        }
      }

      event.preventDefault();
    }, { passive: false });

    elements.stage.addEventListener('touchend', (event) => {
      if (isEventFromStageControl(event.target)) {
        if (event.touches.length === 0) {
          state.panGesture.active = false;
          state.panGesture.pointerId = null;
        }
        return;
      }
      if (state.panMode && state.panGesture.active) {
        if (event.touches.length === 0) {
          state.panGesture.active = false;
        }
        event.preventDefault();
        return;
      }

      if (!isControlActive()) {
        resetTouchState();
        return;
      }

      if (state.touch.twoFingerActive) {
        if (event.touches.length < 2) {
          state.touch.twoFingerActive = false;
        }
        event.preventDefault();
        return;
      }

      if (!state.touch.active) {
        return;
      }

      const endedTouch = Array.from(event.changedTouches || []).find((item) => item.identifier === state.touch.touchId);
      if (!endedTouch) {
        return;
      }

      clearLongPressTimer();
      if (!state.touch.moved && !state.touch.longPressTriggered) {
        const normalized = normalizedFromClient(endedTouch.clientX, endedTouch.clientY);
        if (normalized) {
          setPointerNormalized(normalized.x, normalized.y);
          sendMouseClick('left', normalized);
        }
      }
      resetTouchState();
      event.preventDefault();
    }, { passive: false });

    elements.stage.addEventListener('touchcancel', () => {
      resetTouchState();
      state.panGesture.active = false;
    });
  }

  function bindKeyboardHandlers() {
    if (!elements.keyboardInput) {
      return;
    }

    elements.keyboardInput.addEventListener('input', () => {
      if (!isControlActive()) {
        elements.keyboardInput.value = '';
        return;
      }

      const text = elements.keyboardInput.value;
      if (text) {
        sendTextPayload(text);
      }
      elements.keyboardInput.value = '';
    });

    elements.keyboardInput.addEventListener('keydown', (event) => {
      if (!isControlActive()) {
        return;
      }
      const printable = typeof event.key === 'string' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!printable) {
        sendKeyPressFromEvent(event);
        event.preventDefault();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (!isRemoteViewActive()) {
        return;
      }

      if (event.key === 'Escape' && state.simulatedFullscreen === true) {
        exitSimulatedFullscreen();
        updateFullscreenButton();
        return;
      }

      if (!isControlActive()) {
        return;
      }

      if (event.target === elements.keyboardInput) {
        return;
      }

      const target = event.target;
      if (target && target.closest && target.closest('#remote-view')) {
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'select' || tag === 'button' || tag === 'input' || tag === 'textarea' || target.isContentEditable) {
          return;
        }
      }

      if (event.key === 'Escape' && (document.fullscreenElement === elements.stage || document.webkitFullscreenElement === elements.stage)) {
        return;
      }

      const sent = sendKeyPressFromEvent(event);
      if (sent) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  function bindUiEvents() {
    elements.viewPillRemote.addEventListener('click', () => {
      activateRemoteView();
    });

    if (elements.viewPillConsole) {
      elements.viewPillConsole.addEventListener('click', () => {
        deactivateRemoteView('console');
      });
    }

    if (elements.viewPillMetrics) {
      elements.viewPillMetrics.addEventListener('click', () => {
        deactivateRemoteView('metrics');
      });
    }

    if (elements.modeSelect) {
      elements.modeSelect.addEventListener('change', () => {
        applyRequestedMode(elements.modeSelect.value || 'view');
      });
    }

    if (elements.openKeyboardButton && elements.keyboardInput) {
      elements.openKeyboardButton.addEventListener('click', () => {
        if (!isControlActive()) {
          updateKeyboardStatus();
          return;
        }
        elements.keyboardInput.focus();
      });
    }

    if (elements.fullscreenButton) {
      elements.fullscreenButton.addEventListener('click', async () => {
        if (isFullscreenActive()) {
          if (isNativeFullscreenActive()) {
            if (document.exitFullscreen) {
              await document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
              document.webkitExitFullscreen();
            }
          } else {
            exitSimulatedFullscreen();
          }
          updateFullscreenButton();
          return;
        }

        let enteredNative = false;
        try {
          if (elements.stage.requestFullscreen) {
            await elements.stage.requestFullscreen();
            enteredNative = true;
          } else if (elements.stage.webkitRequestFullscreen) {
            elements.stage.webkitRequestFullscreen();
            enteredNative = true;
          }
        } catch (_error) {
          enteredNative = false;
        }

        if (!enteredNative) {
          enterSimulatedFullscreen();
        }

        updateFullscreenButton();
      });
    }

    document.addEventListener('fullscreenchange', () => {
      if (!isNativeFullscreenActive()) {
        exitSimulatedFullscreen();
      }
      updateFullscreenButton();
      recomputeViewport();
    });
    document.addEventListener('webkitfullscreenchange', () => {
      if (!isNativeFullscreenActive()) {
        exitSimulatedFullscreen();
      }
      updateFullscreenButton();
      recomputeViewport();
    });

    if (elements.zoomOutButton) {
      elements.zoomOutButton.addEventListener('click', () => {
        setZoom(state.display.zoom - 0.2);
      });
    }
    if (elements.zoomInButton) {
      elements.zoomInButton.addEventListener('click', () => {
        setZoom(state.display.zoom + 0.2);
      });
    }
    if (elements.resetViewButton) {
      elements.resetViewButton.addEventListener('click', () => {
        centerViewport();
      });
    }
    if (elements.panToggleButton) {
      elements.panToggleButton.addEventListener('click', () => {
        setPanMode(!state.panMode);
      });
    }

    if (elements.minimap) {
      elements.minimap.addEventListener('pointerdown', (event) => {
        moveViewportFromMinimapClient(event.clientX, event.clientY);
        event.preventDefault();
      });
      elements.minimap.addEventListener('pointermove', (event) => {
        if (event.buttons === 1) {
          moveViewportFromMinimapClient(event.clientX, event.clientY);
          event.preventDefault();
        }
      });
      elements.minimap.addEventListener('touchstart', (event) => {
        if (!event.touches.length) {
          return;
        }
        moveViewportFromMinimapClient(event.touches[0].clientX, event.touches[0].clientY);
        event.preventDefault();
      }, { passive: false });
      elements.minimap.addEventListener('touchmove', (event) => {
        if (!event.touches.length) {
          return;
        }
        moveViewportFromMinimapClient(event.touches[0].clientX, event.touches[0].clientY);
        event.preventDefault();
      }, { passive: false });
    }

    if (elements.leftClickButton) {
      elements.leftClickButton.addEventListener('click', () => {
        sendMouseClick('left');
      });
    }
    if (elements.rightClickButton) {
      elements.rightClickButton.addEventListener('click', () => {
        sendMouseClick('right');
      });
    }
    if (elements.doubleClickButton) {
      elements.doubleClickButton.addEventListener('click', () => {
        sendMouseClick('left');
        setTimeout(() => {
          sendMouseClick('left');
        }, 70);
      });
    }

    elements.streamImage.addEventListener('load', () => {
      updateDesktopDimensions(elements.streamImage.naturalWidth, elements.streamImage.naturalHeight);
      setFrameVisibility(true);
      if (state.hasFrame) {
        setConnectionState('Connected', 'connected');
      }
    });

    window.addEventListener('resize', () => {
      recomputeViewport();
    });

    if (window.visualViewport) {
      const onViewportChange = () => {
        recomputeViewport();
      };
      window.visualViewport.addEventListener('resize', onViewportChange);
      window.visualViewport.addEventListener('scroll', onViewportChange);
    }
  }

  function setupLifecycle() {
    window.addEventListener('beforeunload', () => {
      stopStatusPolling();
      clearReconnectTimer();
      exitSimulatedFullscreen();
      disconnectRemoteSocket({ manual: true, preserveFrame: false });
      clearLongPressTimer();
      if (state.pointer.hideCursorTimer) {
        clearTimeout(state.pointer.hideCursorTimer);
        state.pointer.hideCursorTimer = null;
      }
    });
  }

  function initializeRemoteUi() {
    updateStatsText();
    updateModeUi();
    setConnectionState('Checking status...', 'warn');
    setOverlayText('Open the Remote tab to start desktop streaming.');
    recomputeViewport();
    bindUiEvents();
    bindPointerAndTouchHandlers();
    bindKeyboardHandlers();
    setupLifecycle();
    setPanMode(false);
    updateFullscreenButton();
    refreshRemoteStatus(false).catch(() => {});
  }

  initializeRemoteUi();
})();
