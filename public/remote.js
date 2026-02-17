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
    overlayFullscreenButton: document.getElementById('remote-overlay-fullscreen-toggle'),
    streamStats: document.getElementById('remote-stream-stats'),
    capabilityStatus: document.getElementById('remote-capability-status'),
    connectionStatus: document.getElementById('remote-connection-status'),
    stage: document.getElementById('remote-stage'),
    canvas: document.getElementById('remote-canvas'),
    controlOverlay: document.getElementById('remote-control-overlay'),
    controlLauncherButton: document.getElementById('remote-control-launcher'),
    controlCollapseButton: document.getElementById('remote-control-collapse'),
    driveOverlay: document.getElementById('remote-drive-overlay'),
    driveHandle: document.getElementById('remote-drive-handle'),
    joystickPad: document.getElementById('remote-joystick-pad'),
    joystickKnob: document.getElementById('remote-joystick-knob'),
    joystickLeftButton: document.getElementById('remote-joystick-left-click'),
    joystickRightButton: document.getElementById('remote-joystick-right-click'),
    joystickSensitivityInput: document.getElementById('remote-joystick-sensitivity'),
    joystickSensitivityValue: document.getElementById('remote-joystick-sensitivity-value'),
    streamImage: document.getElementById('remote-stream-image'),
    overlay: document.getElementById('remote-overlay'),
    cursorIndicator: document.getElementById('remote-cursor-indicator'),
    standaloneHint: document.getElementById('remote-standalone-hint'),
    standaloneDismissButton: document.getElementById('remote-standalone-dismiss'),
    zoomOutButton: document.getElementById('remote-zoom-out'),
    zoomInButton: document.getElementById('remote-zoom-in'),
    zoomLabel: document.getElementById('remote-zoom-label'),
    panToggleButton: document.getElementById('remote-pan-toggle'),
    resetViewButton: document.getElementById('remote-reset-view'),
    minimap: document.getElementById('remote-minimap'),
    minimapViewport: document.getElementById('remote-minimap-viewport'),
    overlayLeftClickButton: document.getElementById('remote-overlay-left-click'),
    overlayRightClickButton: document.getElementById('remote-overlay-right-click'),
    overlayDoubleClickButton: document.getElementById('remote-overlay-double-click'),
    overlayWheelUpButton: document.getElementById('remote-overlay-wheel-up'),
    overlayWheelDownButton: document.getElementById('remote-overlay-wheel-down'),
    overlayEscButton: document.getElementById('remote-overlay-esc'),
    overlayTabButton: document.getElementById('remote-overlay-tab'),
    overlayEnterButton: document.getElementById('remote-overlay-enter'),
    overlayBackspaceButton: document.getElementById('remote-overlay-backspace'),
    overlaySpaceButton: document.getElementById('remote-overlay-space'),
    overlayOpenKeyboardButton: document.getElementById('remote-overlay-open-keyboard'),
    overlayArrowUpButton: document.getElementById('remote-overlay-arrow-up'),
    overlayArrowDownButton: document.getElementById('remote-overlay-arrow-down'),
    overlayArrowLeftButton: document.getElementById('remote-overlay-arrow-left'),
    overlayArrowRightButton: document.getElementById('remote-overlay-arrow-right'),
    overlayAltTabButton: document.getElementById('remote-overlay-alt-tab'),
    overlayWinTabButton: document.getElementById('remote-overlay-win-tab'),
    overlayWinDButton: document.getElementById('remote-overlay-win-d'),
    overlayTaskManagerButton: document.getElementById('remote-overlay-task-manager'),
    overlayCopyButton: document.getElementById('remote-overlay-copy'),
    overlayPasteButton: document.getElementById('remote-overlay-paste'),
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
    sidecarInputReason: null,
    controlAllowed: false,
    desiredMode: normalizeMode(elements.modeSelect ? elements.modeSelect.value : 'view'),
    effectiveMode: 'view',
    lastControlUpgradeAttemptAt: 0,
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
    quickControls: {
      expanded: true
    },
    driveOverlay: {
      x: null,
      y: null,
      dragging: false,
      dragPointerId: null,
      dragOffsetX: 0,
      dragOffsetY: 0
    },
    pointer: {
      lastNormalizedX: 0.5,
      lastNormalizedY: 0.5,
      lastMoveSentAt: 0
    },
    cursor: {
      normalizedX: 0.5,
      normalizedY: 0.5,
      visible: false,
      hideTimer: null,
      lastRemoteAt: 0
    },
    panGesture: {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0
    },
    joystick: {
      active: false,
      pointerId: null,
      centerX: 0,
      centerY: 0,
      radius: 1,
      vectorX: 0,
      vectorY: 0,
      moveTimer: null,
      lastTickAt: 0,
      baseSpeedPerSec: 0.72,
      sensitivityPercent: 100,
      maxSpeedPerSec: 0.72
    },
    pwa: {
      isIos: false,
      isStandalone: false,
      hintDismissed: false
    }
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeMode(value) {
    return value === 'control' ? 'control' : 'view';
  }

  function detectIosDevice() {
    const userAgent = (window.navigator && window.navigator.userAgent) || '';
    const platform = (window.navigator && window.navigator.platform) || '';
    const maxTouchPoints = Number(window.navigator && window.navigator.maxTouchPoints) || 0;
    const iosUserAgent = /iphone|ipad|ipod/i.test(userAgent);
    const ipadDesktopClass = platform === 'MacIntel' && maxTouchPoints > 1;
    return iosUserAgent || ipadDesktopClass;
  }

  function detectStandaloneDisplayMode() {
    const displayModeStandalone = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
    const navigatorStandalone = Boolean(window.navigator && window.navigator.standalone === true);
    return displayModeStandalone || navigatorStandalone;
  }

  function getStandaloneHintStorageKey() {
    return 'online-cli-remote-standalone-hint-dismissed-v1';
  }

  function getQuickControlsCollapsedStorageKey() {
    return 'online-cli-remote-controls-collapsed-v1';
  }

  function getJoystickSensitivityStorageKey() {
    return 'online-cli-remote-joystick-sensitivity-v1';
  }

  function getDriveOverlayPositionStorageKey() {
    return 'online-cli-remote-drive-overlay-position-v1';
  }

  function safeReadLocalStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeWriteLocalStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage failures in private mode.
    }
  }

  function safeReadJsonStorage(key) {
    const raw = safeReadLocalStorage(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function updateStandaloneBodyClass() {
    document.body.classList.toggle('pwa-standalone', state.pwa.isStandalone === true);
  }

  function shouldShowStandaloneHint() {
    return state.pwa.isIos === true && state.pwa.isStandalone !== true && state.pwa.hintDismissed !== true;
  }

  function setStandaloneHintVisible(visible, options) {
    if (!elements.standaloneHint) {
      return;
    }
    const opts = options || {};
    const shouldShow = visible === true && (
      opts.force === true
        ? (state.pwa.isIos === true && state.pwa.isStandalone !== true)
        : shouldShowStandaloneHint()
    );
    elements.standaloneHint.hidden = !shouldShow;
  }

  function refreshStandaloneState() {
    const previousStandaloneState = state.pwa.isStandalone;
    state.pwa.isStandalone = detectStandaloneDisplayMode();
    if (previousStandaloneState !== state.pwa.isStandalone && state.pwa.isStandalone) {
      setStandaloneHintVisible(false);
    }
    updateStandaloneBodyClass();
    updateFullscreenButton();
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

  function getQuickControlButtons() {
    return [
      elements.overlayLeftClickButton,
      elements.overlayRightClickButton,
      elements.overlayDoubleClickButton,
      elements.overlayWheelUpButton,
      elements.overlayWheelDownButton,
      elements.overlayEscButton,
      elements.overlayTabButton,
      elements.overlayEnterButton,
      elements.overlayBackspaceButton,
      elements.overlaySpaceButton,
      elements.overlayOpenKeyboardButton,
      elements.overlayArrowUpButton,
      elements.overlayArrowDownButton,
      elements.overlayArrowLeftButton,
      elements.overlayArrowRightButton,
      elements.overlayAltTabButton,
      elements.overlayWinTabButton,
      elements.overlayWinDButton,
      elements.overlayTaskManagerButton,
      elements.overlayCopyButton,
      elements.overlayPasteButton
    ].filter(Boolean);
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

    const inputReason = state.inputAvailable === true
      ? ''
      : (state.sidecarInputReason ? ` (${state.sidecarInputReason})` : '');
    const inputLabel = state.inputAvailable === true
      ? 'control available'
      : `view-only${inputReason}`;
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

    const controlsEnabled = isControlActive();
    for (const button of getQuickControlButtons()) {
      button.disabled = !controlsEnabled;
    }
    if (elements.joystickPad) {
      elements.joystickPad.classList.toggle('disabled', !controlsEnabled);
    }
    if (elements.joystickLeftButton) {
      elements.joystickLeftButton.disabled = !controlsEnabled;
    }
    if (elements.joystickRightButton) {
      elements.joystickRightButton.disabled = !controlsEnabled;
    }
    if (!controlsEnabled) {
      state.joystick.active = false;
      state.joystick.pointerId = null;
      state.joystick.vectorX = 0;
      state.joystick.vectorY = 0;
      state.joystick.lastTickAt = 0;
      stopJoystickLoop();
      resetJoystickKnob();
    }

    updateKeyboardStatus();
    updateCapabilityText();
    updateFullscreenButton();
  }

  function persistQuickControlsCollapsedState() {
    safeWriteLocalStorage(
      getQuickControlsCollapsedStorageKey(),
      state.quickControls.expanded ? '0' : '1'
    );
  }

  function setJoystickSensitivityPercent(nextPercent, shouldPersist = true) {
    const numeric = Number(nextPercent);
    const normalizedPercent = clamp(Math.round(Number.isFinite(numeric) ? numeric : 100), 30, 180);
    const speed = state.joystick.baseSpeedPerSec * (normalizedPercent / 100);
    state.joystick.sensitivityPercent = normalizedPercent;
    state.joystick.maxSpeedPerSec = Number(speed.toFixed(4));

    if (elements.joystickSensitivityInput) {
      elements.joystickSensitivityInput.value = String(normalizedPercent);
    }
    if (elements.joystickSensitivityValue) {
      elements.joystickSensitivityValue.textContent = `${normalizedPercent}%`;
    }

    if (shouldPersist) {
      safeWriteLocalStorage(getJoystickSensitivityStorageKey(), String(normalizedPercent));
    }
  }

  function setQuickControlsExpanded(expanded, shouldPersist = true) {
    state.quickControls.expanded = expanded === true;

    if (elements.controlOverlay) {
      elements.controlOverlay.hidden = !state.quickControls.expanded;
      elements.controlOverlay.style.display = state.quickControls.expanded ? '' : 'none';
      elements.controlOverlay.setAttribute('aria-hidden', state.quickControls.expanded ? 'false' : 'true');
    }
    if (elements.controlLauncherButton) {
      elements.controlLauncherButton.hidden = false;
      elements.controlLauncherButton.style.display = '';
      elements.controlLauncherButton.setAttribute('aria-expanded', state.quickControls.expanded ? 'true' : 'false');
      elements.controlLauncherButton.textContent = state.quickControls.expanded ? 'Hide Controls' : 'Controls';
    }
    if (elements.controlCollapseButton) {
      elements.controlCollapseButton.textContent = state.quickControls.expanded ? 'Hide' : 'Show';
    }

    if (shouldPersist) {
      persistQuickControlsCollapsedState();
    }
  }

  function maybeReconnectForControlUpgrade(reason) {
    if (!isRemoteViewActive()) {
      return;
    }

    if (state.enabled !== true || state.sidecarReachable !== true) {
      return;
    }

    if (state.desiredMode !== 'control' || state.inputAvailable !== true || state.controlAllowed === true) {
      return;
    }

    const now = Date.now();
    if ((now - state.lastControlUpgradeAttemptAt) < 1800) {
      return;
    }
    state.lastControlUpgradeAttemptAt = now;

    if (!state.hasFrame) {
      setOverlayText('Reconnecting to enable control mode...');
    }

    disconnectRemoteSocket({ manual: true, preserveFrame: true });
    ensureRemoteSocket().catch(() => {});

    if (reason) {
      updateCapabilityText();
    }
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
    if (!state.hasFrame) {
      hideRemoteCursor();
    }
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

  function getDriveOverlayDimensions() {
    if (!elements.driveOverlay) {
      return { width: 220, height: 146 };
    }
    const width = Math.max(90, Math.round(elements.driveOverlay.offsetWidth || 220));
    const height = Math.max(72, Math.round(elements.driveOverlay.offsetHeight || 146));
    return { width, height };
  }

  function clampDriveOverlayPosition(nextX, nextY) {
    const stageRect = getStageRect();
    const stageWidth = Math.max(1, Math.round(stageRect.width));
    const stageHeight = Math.max(1, Math.round(stageRect.height));
    const overlaySize = getDriveOverlayDimensions();
    const margin = 8;
    return {
      x: clamp(Number(nextX) || 0, margin, Math.max(margin, stageWidth - overlaySize.width - margin)),
      y: clamp(Number(nextY) || 0, margin, Math.max(margin, stageHeight - overlaySize.height - margin))
    };
  }

  function applyDriveOverlayPosition(nextX, nextY, shouldPersist = true) {
    if (!elements.driveOverlay) {
      return;
    }
    const clamped = clampDriveOverlayPosition(nextX, nextY);
    state.driveOverlay.x = clamped.x;
    state.driveOverlay.y = clamped.y;
    elements.driveOverlay.style.left = `${clamped.x}px`;
    elements.driveOverlay.style.top = `${clamped.y}px`;
    elements.driveOverlay.style.right = 'auto';
    elements.driveOverlay.style.bottom = 'auto';

    if (shouldPersist) {
      safeWriteLocalStorage(getDriveOverlayPositionStorageKey(), JSON.stringify(clamped));
    }
  }

  function ensureDriveOverlayPosition() {
    if (!elements.driveOverlay) {
      return;
    }

    const stageRect = getStageRect();
    const rawStageWidth = Math.round(stageRect.width);
    const rawStageHeight = Math.round(stageRect.height);
    if (!Number.isFinite(rawStageWidth) || !Number.isFinite(rawStageHeight) || rawStageWidth < 120 || rawStageHeight < 120) {
      return;
    }

    if (Number.isFinite(state.driveOverlay.x) && Number.isFinite(state.driveOverlay.y)) {
      applyDriveOverlayPosition(state.driveOverlay.x, state.driveOverlay.y, false);
      return;
    }

    const stageWidth = rawStageWidth;
    const stageHeight = rawStageHeight;
    const overlaySize = getDriveOverlayDimensions();
    const fallbackX = 10;
    const fallbackY = Math.max(8, stageHeight - overlaySize.height - 10);
    const defaultX = Number.isFinite(state.driveOverlay.x) ? state.driveOverlay.x : fallbackX;
    const defaultY = Number.isFinite(state.driveOverlay.y) ? state.driveOverlay.y : fallbackY;
    applyDriveOverlayPosition(defaultX, defaultY, false);
  }

  function beginDriveOverlayDrag(event) {
    if (
      !elements.driveOverlay
      || !elements.driveHandle
      || !event
      || event.button !== 0
    ) {
      return;
    }

    const overlayRect = elements.driveOverlay.getBoundingClientRect();
    state.driveOverlay.dragging = true;
    state.driveOverlay.dragPointerId = event.pointerId;
    state.driveOverlay.dragOffsetX = event.clientX - overlayRect.left;
    state.driveOverlay.dragOffsetY = event.clientY - overlayRect.top;
    elements.driveOverlay.classList.add('dragging');

    if (typeof elements.driveHandle.setPointerCapture === 'function') {
      try {
        elements.driveHandle.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore pointer capture races.
      }
    }

    event.preventDefault();
  }

  function moveDriveOverlayDrag(event) {
    if (
      !state.driveOverlay.dragging
      || state.driveOverlay.dragPointerId !== event.pointerId
    ) {
      return;
    }

    const stageRect = getStageRect();
    const localLeft = event.clientX - stageRect.left - state.driveOverlay.dragOffsetX;
    const localTop = event.clientY - stageRect.top - state.driveOverlay.dragOffsetY;
    applyDriveOverlayPosition(localLeft, localTop, false);
    event.preventDefault();
  }

  function endDriveOverlayDrag(event) {
    if (
      !state.driveOverlay.dragging
      || !event
      || state.driveOverlay.dragPointerId !== event.pointerId
    ) {
      return;
    }

    if (elements.driveHandle && typeof elements.driveHandle.releasePointerCapture === 'function') {
      try {
        elements.driveHandle.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore pointer release races.
      }
    }

    state.driveOverlay.dragging = false;
    state.driveOverlay.dragPointerId = null;
    state.driveOverlay.dragOffsetX = 0;
    state.driveOverlay.dragOffsetY = 0;
    if (elements.driveOverlay) {
      elements.driveOverlay.classList.remove('dragging');
    }

    if (Number.isFinite(state.driveOverlay.x) && Number.isFinite(state.driveOverlay.y)) {
      applyDriveOverlayPosition(state.driveOverlay.x, state.driveOverlay.y, true);
    }

    event.preventDefault();
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
    renderRemoteCursor();
    ensureDriveOverlayPosition();
  }

  function scheduleViewportRecompute() {
    recomputeViewport();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        recomputeViewport();
        window.requestAnimationFrame(() => {
          recomputeViewport();
        });
      });
      return;
    }
    setTimeout(() => {
      recomputeViewport();
    }, 40);
    setTimeout(() => {
      recomputeViewport();
    }, 120);
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

  function clearCursorHideTimer() {
    if (!state.cursor.hideTimer) {
      return;
    }
    clearTimeout(state.cursor.hideTimer);
    state.cursor.hideTimer = null;
  }

  function setCursorIndicatorVisible(visible) {
    state.cursor.visible = visible === true;
    if (!elements.cursorIndicator) {
      return;
    }
    elements.cursorIndicator.hidden = !state.cursor.visible;
  }

  function renderRemoteCursor() {
    if (!elements.cursorIndicator || state.cursor.visible !== true) {
      return;
    }
    const drawX = state.display.drawLeft + (state.cursor.normalizedX * state.display.desktopWidth * state.display.drawScale);
    const drawY = state.display.drawTop + (state.cursor.normalizedY * state.display.desktopHeight * state.display.drawScale);
    elements.cursorIndicator.style.left = `${Math.round(drawX)}px`;
    elements.cursorIndicator.style.top = `${Math.round(drawY)}px`;
  }

  function hideRemoteCursor() {
    clearCursorHideTimer();
    setCursorIndicatorVisible(false);
  }

  function setRemoteCursorNormalized(normalizedX, normalizedY, options = {}) {
    state.cursor.normalizedX = clamp(normalizedX, 0, 1);
    state.cursor.normalizedY = clamp(normalizedY, 0, 1);
    if (options.source === 'remote') {
      state.cursor.lastRemoteAt = Date.now();
      state.pointer.lastNormalizedX = state.cursor.normalizedX;
      state.pointer.lastNormalizedY = state.cursor.normalizedY;
    }
    setCursorIndicatorVisible(true);
    renderRemoteCursor();

    const autoHideMs = Number.isFinite(options.autoHideMs) ? Number(options.autoHideMs) : 0;
    clearCursorHideTimer();
    if (autoHideMs > 0) {
      state.cursor.hideTimer = setTimeout(() => {
        state.cursor.hideTimer = null;
        setCursorIndicatorVisible(false);
      }, autoHideMs);
    }
  }

  function setPointerNormalized(normalizedX, normalizedY) {
    state.pointer.lastNormalizedX = clamp(normalizedX, 0, 1);
    state.pointer.lastNormalizedY = clamp(normalizedY, 0, 1);

    // Prefer host cursor telemetry when available; local updates keep it visible as fallback.
    if ((Date.now() - state.cursor.lastRemoteAt) > 260) {
      setRemoteCursorNormalized(state.pointer.lastNormalizedX, state.pointer.lastNormalizedY, {
        source: 'local',
        autoHideMs: 900
      });
    }
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

  function sendQuickKeyPress(key, code, modifiers) {
    return sendInputEvent({
      type: 'key',
      action: 'press',
      key: typeof key === 'string' ? key.slice(0, 64) : '',
      code: typeof code === 'string' ? code.slice(0, 64) : '',
      modifiers: {
        alt: Boolean(modifiers && modifiers.alt === true),
        ctrl: Boolean(modifiers && modifiers.ctrl === true),
        meta: Boolean(modifiers && modifiers.meta === true),
        shift: Boolean(modifiers && modifiers.shift === true)
      }
    });
  }

  function sendDoubleLeftClick(normalized) {
    const first = sendMouseClick('left', normalized);
    if (!first) {
      return false;
    }
    setTimeout(() => {
      sendMouseClick('left', normalized);
    }, 70);
    return true;
  }

  function focusRemoteKeyboard() {
    if (!elements.keyboardInput) {
      return false;
    }
    if (!isControlActive()) {
      updateKeyboardStatus();
      return false;
    }
    elements.keyboardInput.focus();
    return true;
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
    const hasFreshRemoteCursor = (Date.now() - state.cursor.lastRemoteAt) <= 450;
    const fallbackTarget = hasFreshRemoteCursor
      ? { x: state.cursor.normalizedX, y: state.cursor.normalizedY }
      : { x: state.pointer.lastNormalizedX, y: state.pointer.lastNormalizedY };
    const target = normalized || fallbackTarget;
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

  function resetJoystickKnob() {
    if (!elements.joystickKnob) {
      return;
    }
    elements.joystickKnob.style.transform = 'translate(-50%, -50%)';
  }

  function setJoystickVectorFromClient(clientX, clientY) {
    if (!elements.joystickPad || !elements.joystickKnob) {
      return;
    }

    const rect = elements.joystickPad.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const radius = Math.max(1, state.joystick.radius);
    const rawDx = localX - state.joystick.centerX;
    const rawDy = localY - state.joystick.centerY;
    const distance = Math.hypot(rawDx, rawDy);
    const limitedScale = distance > radius ? (radius / distance) : 1;
    const dx = rawDx * limitedScale;
    const dy = rawDy * limitedScale;

    state.joystick.vectorX = clamp(dx / radius, -1, 1);
    state.joystick.vectorY = clamp(dy / radius, -1, 1);
    elements.joystickKnob.style.transform = `translate(calc(-50% + ${Math.round(dx)}px), calc(-50% + ${Math.round(dy)}px))`;
  }

  function stopJoystickLoop() {
    if (!state.joystick.moveTimer) {
      return;
    }
    clearInterval(state.joystick.moveTimer);
    state.joystick.moveTimer = null;
  }

  function tickJoystickMove() {
    if (!state.joystick.active || !isControlActive()) {
      return;
    }

    const now = Date.now();
    if (!state.joystick.lastTickAt) {
      state.joystick.lastTickAt = now;
      return;
    }
    const deltaSec = clamp((now - state.joystick.lastTickAt) / 1000, 0, 0.05);
    state.joystick.lastTickAt = now;

    const vx = state.joystick.vectorX;
    const vy = state.joystick.vectorY;
    if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
      return;
    }

    const nextX = clamp(state.pointer.lastNormalizedX + (vx * state.joystick.maxSpeedPerSec * deltaSec), 0, 1);
    const nextY = clamp(state.pointer.lastNormalizedY + (vy * state.joystick.maxSpeedPerSec * deltaSec), 0, 1);
    if (Math.abs(nextX - state.pointer.lastNormalizedX) < 0.0002 && Math.abs(nextY - state.pointer.lastNormalizedY) < 0.0002) {
      return;
    }

    setPointerNormalized(nextX, nextY);
    sendPointerMove({ x: nextX, y: nextY });
  }

  function startJoystickLoop() {
    if (state.joystick.moveTimer) {
      return;
    }
    state.joystick.lastTickAt = Date.now();
    state.joystick.moveTimer = setInterval(() => {
      tickJoystickMove();
    }, 16);
  }

  function beginJoystickControl(event) {
    if (!elements.joystickPad || !event || event.button !== 0) {
      return;
    }
    if (!isControlActive()) {
      return;
    }

    const rect = elements.joystickPad.getBoundingClientRect();
    state.joystick.active = true;
    state.joystick.pointerId = event.pointerId;
    state.joystick.centerX = rect.width / 2;
    state.joystick.centerY = rect.height / 2;
    state.joystick.radius = Math.max(24, Math.min(rect.width, rect.height) * 0.42);
    state.joystick.lastTickAt = Date.now();

    if (typeof elements.joystickPad.setPointerCapture === 'function') {
      try {
        elements.joystickPad.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore pointer capture races.
      }
    }

    setJoystickVectorFromClient(event.clientX, event.clientY);
    startJoystickLoop();
    event.preventDefault();
  }

  function moveJoystickControl(event) {
    if (!state.joystick.active || state.joystick.pointerId !== event.pointerId) {
      return;
    }
    setJoystickVectorFromClient(event.clientX, event.clientY);
    event.preventDefault();
  }

  function endJoystickControl(event) {
    if (!state.joystick.active || state.joystick.pointerId !== event.pointerId) {
      return;
    }

    if (elements.joystickPad && typeof elements.joystickPad.releasePointerCapture === 'function') {
      try {
        elements.joystickPad.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore pointer release races.
      }
    }

    state.joystick.active = false;
    state.joystick.pointerId = null;
    state.joystick.vectorX = 0;
    state.joystick.vectorY = 0;
    state.joystick.lastTickAt = 0;
    stopJoystickLoop();
    resetJoystickKnob();
    event.preventDefault();
  }

  function handleRemoteControlEnvelope(message) {
    if (!message || message.__onlineCliControl !== true || message.channel !== 'remote') {
      return;
    }

    if (message.type === 'remote-ready') {
      state.controlAllowed = message.controlAllowed === true;
      state.effectiveMode = normalizeMode(message.mode);
      updateModeUi();
      if (state.desiredMode === 'control' && state.effectiveMode !== 'control' && state.inputAvailable === true) {
        maybeReconnectForControlUpgrade('remote-ready');
      }
      return;
    }

    if (message.type === 'remote-mode') {
      state.controlAllowed = message.controlAllowed === true;
      state.effectiveMode = normalizeMode(message.mode);
      updateModeUi();
      if (state.desiredMode === 'control' && state.effectiveMode !== 'control') {
        if (message.reason === 'control-unavailable' && state.inputAvailable === true) {
          maybeReconnectForControlUpgrade('mode-rejected');
        } else if (typeof message.reason === 'string' && message.reason) {
          setOverlayText(`Control mode unavailable (${message.reason}).`);
        }
      }
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

    if (message.type === 'remote-cursor') {
      if (Number.isFinite(Number(message.x)) && Number.isFinite(Number(message.y))) {
        setRemoteCursorNormalized(Number(message.x), Number(message.y), {
          source: 'remote',
          autoHideMs: 1800
        });
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
    hideRemoteCursor();
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
      const previousInputAvailable = state.inputAvailable;
      state.enabled = status && status.enabled === true;
      state.sidecarReachable = Boolean(status && status.sidecar && status.sidecar.reachable === true);
      state.inputAvailable = Boolean(status && status.sidecar && status.sidecar.inputAvailable === true);
      state.sidecarInputReason = status && status.sidecar && status.sidecar.reason
        ? String(status.sidecar.reason)
        : null;

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
      } else if (state.inputAvailable === true && previousInputAvailable !== true) {
        maybeReconnectForControlUpgrade('input-upgraded');
      }
      updateModeUi();
      return true;
    } catch (error) {
      state.enabled = false;
      state.sidecarReachable = false;
      state.inputAvailable = false;
      state.sidecarInputReason = error && error.message ? error.message : null;
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
    refreshStandaloneState();
    applyViewPills('remote');
    recomputeViewport();
    setStandaloneHintVisible(true);
    refreshRemoteStatus(true).then(() => {
      ensureRemoteSocket().catch(() => {});
    }).catch(() => {});
    startStatusPolling();
    elements.stage.focus({ preventScroll: true });
  }

  function deactivateRemoteView(nextView) {
    state.activeView = nextView;
    applyViewPills(nextView);
    setStandaloneHintVisible(false);
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
    if (state.display.zoom <= state.display.minZoom + 0.001) {
      state.display.panX = 0;
      state.display.panY = 0;
    }
    scheduleViewportRecompute();
  }

  function exitSimulatedFullscreen() {
    if (!state.simulatedFullscreen) {
      return;
    }
    state.simulatedFullscreen = false;
    document.body.classList.remove('remote-simulated-fullscreen');
    scheduleViewportRecompute();
  }

  function updateFullscreenButton() {
    const isFullscreen = isFullscreenActive();
    const buttonLabel = (!isFullscreen && state.pwa.isIos === true && state.pwa.isStandalone !== true)
      ? 'Home Screen Fullscreen'
      : (isFullscreen ? 'Exit Fullscreen' : 'Fullscreen');

    if (elements.fullscreenButton) {
      elements.fullscreenButton.textContent = buttonLabel;
      elements.fullscreenButton.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
    }
    if (elements.overlayFullscreenButton) {
      elements.overlayFullscreenButton.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
      elements.overlayFullscreenButton.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
      elements.overlayFullscreenButton.disabled = state.enabled !== true;
    }
  }

  function isEventFromStageControl(target) {
    if (!target || typeof target.closest !== 'function') {
      return false;
    }
    return Boolean(
      target.closest('.remote-drive-overlay') ||
      target.closest('.remote-control-overlay') ||
      target.closest('.remote-control-launcher') ||
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

    if (normalized === 'control' && state.inputAvailable === true && state.controlAllowed !== true) {
      maybeReconnectForControlUpgrade('mode-switch');
      return;
    }

    if (!isWsOpen()) {
      ensureRemoteSocket().catch(() => {});
      return;
    }

    sendRemoteMessage({
      type: 'set-mode',
      mode: normalized
    });
  }

  async function toggleFullscreenMode() {
    refreshStandaloneState();

    if (
      !isFullscreenActive()
      && state.pwa.isIos === true
      && state.pwa.isStandalone !== true
    ) {
      setStandaloneHintVisible(true, { force: true });
      setOverlayText('For stable iOS fullscreen, install to Home Screen and launch from the app icon.');
      return;
    }

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
      const shouldUseNativeFullscreen = state.pwa.isIos !== true;
      if (shouldUseNativeFullscreen && elements.stage.requestFullscreen) {
        await elements.stage.requestFullscreen();
        enteredNative = true;
      } else if (shouldUseNativeFullscreen && elements.stage.webkitRequestFullscreen) {
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

    if (elements.controlCollapseButton) {
      const collapseQuickControls = (event) => {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        setQuickControlsExpanded(false);
      };
      elements.controlCollapseButton.addEventListener('click', collapseQuickControls);
      elements.controlCollapseButton.addEventListener('pointerup', collapseQuickControls);
    }

    if (elements.controlLauncherButton) {
      elements.controlLauncherButton.addEventListener('click', (event) => {
        event.preventDefault();
        setQuickControlsExpanded(!state.quickControls.expanded);
      });
    }

    if (elements.openKeyboardButton && elements.keyboardInput) {
      elements.openKeyboardButton.addEventListener('click', () => {
        focusRemoteKeyboard();
      });
    }

    if (elements.fullscreenButton) {
      elements.fullscreenButton.addEventListener('click', () => {
        toggleFullscreenMode().catch(() => {});
      });
    }

    if (elements.overlayFullscreenButton) {
      elements.overlayFullscreenButton.addEventListener('click', () => {
        toggleFullscreenMode().catch(() => {});
      });
    }

    if (elements.standaloneDismissButton) {
      elements.standaloneDismissButton.addEventListener('click', () => {
        state.pwa.hintDismissed = true;
        safeWriteLocalStorage(getStandaloneHintStorageKey(), '1');
        setStandaloneHintVisible(false);
      });
    }

    document.addEventListener('fullscreenchange', () => {
      if (!isNativeFullscreenActive()) {
        exitSimulatedFullscreen();
      }
      updateFullscreenButton();
      scheduleViewportRecompute();
    });
    document.addEventListener('webkitfullscreenchange', () => {
      if (!isNativeFullscreenActive()) {
        exitSimulatedFullscreen();
      }
      updateFullscreenButton();
      scheduleViewportRecompute();
    });

    if (typeof window.matchMedia === 'function') {
      const standaloneMedia = window.matchMedia('(display-mode: standalone)');
      if (standaloneMedia && typeof standaloneMedia.addEventListener === 'function') {
        standaloneMedia.addEventListener('change', () => {
          refreshStandaloneState();
          if (isRemoteViewActive()) {
            setStandaloneHintVisible(true);
          }
        });
      }
    }

    window.addEventListener('pageshow', () => {
      refreshStandaloneState();
      if (isRemoteViewActive()) {
        setStandaloneHintVisible(true);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshStandaloneState();
        if (isRemoteViewActive()) {
          setStandaloneHintVisible(true);
        }
      }
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
    if (elements.joystickSensitivityInput) {
      elements.joystickSensitivityInput.addEventListener('input', () => {
        setJoystickSensitivityPercent(elements.joystickSensitivityInput.value, true);
      });
      elements.joystickSensitivityInput.addEventListener('change', () => {
        setJoystickSensitivityPercent(elements.joystickSensitivityInput.value, true);
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

    if (elements.joystickLeftButton) {
      elements.joystickLeftButton.addEventListener('click', () => {
        sendMouseClick('left');
      });
    }
    if (elements.joystickRightButton) {
      elements.joystickRightButton.addEventListener('click', () => {
        sendMouseClick('right');
      });
    }
    if (elements.driveHandle) {
      elements.driveHandle.addEventListener('pointerdown', (event) => {
        beginDriveOverlayDrag(event);
      });
      elements.driveHandle.addEventListener('pointermove', (event) => {
        moveDriveOverlayDrag(event);
      });
      elements.driveHandle.addEventListener('pointerup', (event) => {
        endDriveOverlayDrag(event);
      });
      elements.driveHandle.addEventListener('pointercancel', (event) => {
        endDriveOverlayDrag(event);
      });
      elements.driveHandle.addEventListener('lostpointercapture', () => {
        state.driveOverlay.dragging = false;
        state.driveOverlay.dragPointerId = null;
        state.driveOverlay.dragOffsetX = 0;
        state.driveOverlay.dragOffsetY = 0;
        if (elements.driveOverlay) {
          elements.driveOverlay.classList.remove('dragging');
        }
      });
    }
    if (elements.joystickPad) {
      elements.joystickPad.addEventListener('pointerdown', (event) => {
        beginJoystickControl(event);
      });
      elements.joystickPad.addEventListener('pointermove', (event) => {
        moveJoystickControl(event);
      });
      elements.joystickPad.addEventListener('pointerup', (event) => {
        endJoystickControl(event);
      });
      elements.joystickPad.addEventListener('pointercancel', (event) => {
        endJoystickControl(event);
      });
      elements.joystickPad.addEventListener('lostpointercapture', () => {
        state.joystick.active = false;
        state.joystick.pointerId = null;
        state.joystick.vectorX = 0;
        state.joystick.vectorY = 0;
        state.joystick.lastTickAt = 0;
        stopJoystickLoop();
        resetJoystickKnob();
      });
    }

    if (elements.overlayLeftClickButton) {
      elements.overlayLeftClickButton.addEventListener('click', () => {
        sendMouseClick('left');
      });
    }
    if (elements.overlayRightClickButton) {
      elements.overlayRightClickButton.addEventListener('click', () => {
        sendMouseClick('right');
      });
    }
    if (elements.overlayDoubleClickButton) {
      elements.overlayDoubleClickButton.addEventListener('click', () => {
        sendDoubleLeftClick();
      });
    }
    if (elements.overlayWheelUpButton) {
      elements.overlayWheelUpButton.addEventListener('click', () => {
        sendMouseWheel(-180);
      });
    }
    if (elements.overlayWheelDownButton) {
      elements.overlayWheelDownButton.addEventListener('click', () => {
        sendMouseWheel(180);
      });
    }
    if (elements.overlayEscButton) {
      elements.overlayEscButton.addEventListener('click', () => {
        sendQuickKeyPress('Escape', 'Escape');
      });
    }
    if (elements.overlayTabButton) {
      elements.overlayTabButton.addEventListener('click', () => {
        sendQuickKeyPress('Tab', 'Tab');
      });
    }
    if (elements.overlayEnterButton) {
      elements.overlayEnterButton.addEventListener('click', () => {
        sendQuickKeyPress('Enter', 'Enter');
      });
    }
    if (elements.overlayBackspaceButton) {
      elements.overlayBackspaceButton.addEventListener('click', () => {
        sendQuickKeyPress('Backspace', 'Backspace');
      });
    }
    if (elements.overlaySpaceButton) {
      elements.overlaySpaceButton.addEventListener('click', () => {
        sendQuickKeyPress(' ', 'Space');
      });
    }
    if (elements.overlayOpenKeyboardButton) {
      elements.overlayOpenKeyboardButton.addEventListener('click', () => {
        focusRemoteKeyboard();
      });
    }
    if (elements.overlayArrowUpButton) {
      elements.overlayArrowUpButton.addEventListener('click', () => {
        sendQuickKeyPress('ArrowUp', 'ArrowUp');
      });
    }
    if (elements.overlayArrowDownButton) {
      elements.overlayArrowDownButton.addEventListener('click', () => {
        sendQuickKeyPress('ArrowDown', 'ArrowDown');
      });
    }
    if (elements.overlayArrowLeftButton) {
      elements.overlayArrowLeftButton.addEventListener('click', () => {
        sendQuickKeyPress('ArrowLeft', 'ArrowLeft');
      });
    }
    if (elements.overlayArrowRightButton) {
      elements.overlayArrowRightButton.addEventListener('click', () => {
        sendQuickKeyPress('ArrowRight', 'ArrowRight');
      });
    }
    if (elements.overlayAltTabButton) {
      elements.overlayAltTabButton.addEventListener('click', () => {
        sendQuickKeyPress('Tab', 'Tab', { alt: true });
      });
    }
    if (elements.overlayWinTabButton) {
      elements.overlayWinTabButton.addEventListener('click', () => {
        sendQuickKeyPress('Tab', 'Tab', { meta: true });
      });
    }
    if (elements.overlayWinDButton) {
      elements.overlayWinDButton.addEventListener('click', () => {
        sendQuickKeyPress('d', 'KeyD', { meta: true });
      });
    }
    if (elements.overlayTaskManagerButton) {
      elements.overlayTaskManagerButton.addEventListener('click', () => {
        sendQuickKeyPress('Escape', 'Escape', { ctrl: true, shift: true });
      });
    }
    if (elements.overlayCopyButton) {
      elements.overlayCopyButton.addEventListener('click', () => {
        sendQuickKeyPress('c', 'KeyC', { ctrl: true });
      });
    }
    if (elements.overlayPasteButton) {
      elements.overlayPasteButton.addEventListener('click', () => {
        sendQuickKeyPress('v', 'KeyV', { ctrl: true });
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
      scheduleViewportRecompute();
    });

    window.addEventListener('orientationchange', () => {
      scheduleViewportRecompute();
    });

    if (window.visualViewport) {
      const onViewportChange = () => {
        scheduleViewportRecompute();
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
      state.driveOverlay.dragging = false;
      state.driveOverlay.dragPointerId = null;
      stopJoystickLoop();
      resetJoystickKnob();
    });
  }

  function initializeRemoteUi() {
    state.pwa.isIos = detectIosDevice();
    state.pwa.hintDismissed = safeReadLocalStorage(getStandaloneHintStorageKey()) === '1';
    state.quickControls.expanded = safeReadLocalStorage(getQuickControlsCollapsedStorageKey()) !== '1';
    const storedSensitivity = Number.parseInt(safeReadLocalStorage(getJoystickSensitivityStorageKey()), 10);
    if (Number.isFinite(storedSensitivity)) {
      state.joystick.sensitivityPercent = storedSensitivity;
    }
    const storedDriveOverlayPos = safeReadJsonStorage(getDriveOverlayPositionStorageKey());
    if (storedDriveOverlayPos && typeof storedDriveOverlayPos === 'object') {
      if (Number.isFinite(Number(storedDriveOverlayPos.x))) {
        state.driveOverlay.x = Number(storedDriveOverlayPos.x);
      }
      if (Number.isFinite(Number(storedDriveOverlayPos.y))) {
        state.driveOverlay.y = Number(storedDriveOverlayPos.y);
      }
    }
    refreshStandaloneState();
    setStandaloneHintVisible(false);
    updateStatsText();
    setJoystickSensitivityPercent(state.joystick.sensitivityPercent, false);
    updateModeUi();
    setConnectionState('Checking status...', 'warn');
    setOverlayText('Open the Remote tab to start desktop streaming.');
    recomputeViewport();
    setQuickControlsExpanded(state.quickControls.expanded, false);
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
