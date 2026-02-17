const childProcess = require('child_process');
const http = require('http');
const express = require('express');
const screenshotDesktop = require('screenshot-desktop');
const { WebSocketServer, WebSocket } = require('ws');

function parseInteger(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === '') {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function decodeWsText(rawValue) {
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  if (Buffer.isBuffer(rawValue)) {
    return rawValue.toString('utf8');
  }
  if (rawValue instanceof ArrayBuffer || ArrayBuffer.isView(rawValue)) {
    return Buffer.from(rawValue).toString('utf8');
  }
  return null;
}

function createLogger(level) {
  const levels = ['debug', 'info', 'warn', 'error'];
  const normalizedLevel = levels.includes(level) ? level : 'info';
  const minimumIndex = levels.indexOf(normalizedLevel);

  function shouldLog(nextLevel) {
    return levels.indexOf(nextLevel) >= minimumIndex;
  }

  function format(nextLevel, message, context) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${nextLevel.toUpperCase()}]`;

    if (!context || Object.keys(context).length === 0) {
      return `${prefix} ${message}`;
    }

    return `${prefix} ${message} ${JSON.stringify(context)}`;
  }

  return {
    debug(message, context) {
      if (shouldLog('debug')) {
        console.debug(format('debug', message, context));
      }
    },
    info(message, context) {
      if (shouldLog('info')) {
        console.info(format('info', message, context));
      }
    },
    warn(message, context) {
      if (shouldLog('warn')) {
        console.warn(format('warn', message, context));
      }
    },
    error(message, context) {
      if (shouldLog('error')) {
        console.error(format('error', message, context));
      }
    }
  };
}

function isWsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function parseRequestQuery(req) {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    return parsed.searchParams;
  } catch (_error) {
    return new URLSearchParams();
  }
}

function getRequestPath(req) {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    return parsed.pathname;
  } catch (_error) {
    return '';
  }
}

function clampNormalized(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsed));
}

function getInputBounds(displayBounds) {
  const left = Number.isFinite(displayBounds && displayBounds.left)
    ? Number(displayBounds.left)
    : (Number.isFinite(displayBounds && displayBounds.virtualLeft) ? Number(displayBounds.virtualLeft) : 0);
  const top = Number.isFinite(displayBounds && displayBounds.top)
    ? Number(displayBounds.top)
    : (Number.isFinite(displayBounds && displayBounds.virtualTop) ? Number(displayBounds.virtualTop) : 0);
  const width = Math.max(1, Number.isFinite(displayBounds && displayBounds.width)
    ? Number(displayBounds.width)
    : (Number.isFinite(displayBounds && displayBounds.virtualWidth) ? Number(displayBounds.virtualWidth) : 1));
  const height = Math.max(1, Number.isFinite(displayBounds && displayBounds.height)
    ? Number(displayBounds.height)
    : (Number.isFinite(displayBounds && displayBounds.virtualHeight) ? Number(displayBounds.virtualHeight) : 1));

  return { left, top, width, height };
}

function resolveDisplayBounds(logger) {
  if (process.platform !== 'win32') {
    return {
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      virtualLeft: 0,
      virtualTop: 0,
      virtualWidth: 1920,
      virtualHeight: 1080,
      captureWidth: null,
      captureHeight: null,
      captureDisplayId: null,
      captureDisplayName: null,
      scaleX: 1,
      scaleY: 1,
      source: 'fallback-non-windows',
      baseSource: 'fallback-non-windows'
    };
  }

  try {
    const command = `
$member = '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);'
if (-not ("OnlineCli.NativeMetrics" -as [type])) {
  Add-Type -Name NativeMetrics -Namespace OnlineCli -MemberDefinition $member
}
[OnlineCli.NativeMetrics]::SetProcessDPIAware() | Out-Null
$left=[OnlineCli.NativeMetrics]::GetSystemMetrics(76)
$top=[OnlineCli.NativeMetrics]::GetSystemMetrics(77)
$width=[OnlineCli.NativeMetrics]::GetSystemMetrics(78)
$height=[OnlineCli.NativeMetrics]::GetSystemMetrics(79)
Write-Output ($left.ToString()+","+$top.ToString()+","+$width.ToString()+","+$height.ToString())
`;

    const raw = childProcess.execFileSync('powershell', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const match = String(raw || '').trim().match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/);
    if (!match) {
      throw new Error(`Unexpected display bounds output: ${String(raw || '').trim()}`);
    }

    const left = clampInteger(Number.parseInt(match[1], 10), -32_768, 32_768);
    const top = clampInteger(Number.parseInt(match[2], 10), -32_768, 32_768);
    const width = clampInteger(Number.parseInt(match[3], 10), 320, 16_384);
    const height = clampInteger(Number.parseInt(match[4], 10), 240, 16_384);

    return {
      left,
      top,
      width,
      height,
      virtualLeft: left,
      virtualTop: top,
      virtualWidth: width,
      virtualHeight: height,
      captureWidth: null,
      captureHeight: null,
      captureDisplayId: null,
      captureDisplayName: null,
      scaleX: 1,
      scaleY: 1,
      source: 'windows-virtual-screen',
      baseSource: 'windows-virtual-screen'
    };
  } catch (error) {
    logger.warn('Failed to resolve Windows display bounds, using fallback', {
      message: error.message
    });
    return {
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      virtualLeft: 0,
      virtualTop: 0,
      virtualWidth: 1920,
      virtualHeight: 1080,
      captureWidth: null,
      captureHeight: null,
      captureDisplayId: null,
      captureDisplayName: null,
      scaleX: 1,
      scaleY: 1,
      source: 'fallback-windows',
      baseSource: 'fallback-windows'
    };
  }
}

function normalizeDisplayDescriptor(rawDisplay) {
  if (!rawDisplay || typeof rawDisplay !== 'object') {
    return null;
  }

  const leftFromRect = Number(rawDisplay.left);
  const topFromRect = Number(rawDisplay.top);
  const rightFromRect = Number(rawDisplay.right);
  const bottomFromRect = Number(rawDisplay.bottom);

  const widthFromSize = Number(rawDisplay.width);
  const heightFromSize = Number(rawDisplay.height);
  const widthFromRect = Number.isFinite(rightFromRect) && Number.isFinite(leftFromRect)
    ? rightFromRect - leftFromRect
    : NaN;
  const heightFromRect = Number.isFinite(bottomFromRect) && Number.isFinite(topFromRect)
    ? bottomFromRect - topFromRect
    : NaN;

  const width = clampInteger(
    Number.isFinite(widthFromSize) && widthFromSize > 0 ? widthFromSize : widthFromRect,
    1,
    16_384
  );
  const height = clampInteger(
    Number.isFinite(heightFromSize) && heightFromSize > 0 ? heightFromSize : heightFromRect,
    1,
    16_384
  );
  const left = clampInteger(
    Number.isFinite(leftFromRect)
      ? leftFromRect
      : (Number.isFinite(rightFromRect) ? rightFromRect - width : 0),
    -32_768,
    32_768
  );
  const top = clampInteger(
    Number.isFinite(topFromRect)
      ? topFromRect
      : (Number.isFinite(bottomFromRect) ? bottomFromRect - height : 0),
    -32_768,
    32_768
  );

  return {
    id: rawDisplay.id ? String(rawDisplay.id) : null,
    name: rawDisplay.name ? String(rawDisplay.name) : null,
    left,
    top,
    width,
    height
  };
}

function chooseDisplayForFrame(frameWidth, frameHeight, displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return null;
  }

  const width = clampInteger(frameWidth, 1, 16_384);
  const height = clampInteger(frameHeight, 1, 16_384);
  const candidates = displays
    .map((rawDisplay) => normalizeDisplayDescriptor(rawDisplay))
    .filter((display) => display !== null);

  if (candidates.length === 0) {
    return null;
  }

  const exactCandidates = candidates.filter((display) => (
    Math.abs(display.width - width) <= 2
    && Math.abs(display.height - height) <= 2
  ));

  if (exactCandidates.length > 0) {
    const aroundOrigin = exactCandidates.find((display) => (
      display.left <= 0
      && display.top <= 0
      && (display.left + display.width) > 0
      && (display.top + display.height) > 0
    ));
    return aroundOrigin || exactCandidates[0];
  }

  let best = null;
  let bestScore = Infinity;
  for (const display of candidates) {
    const score = Math.abs(display.width - width) + Math.abs(display.height - height);
    if (score < bestScore) {
      best = display;
      bestScore = score;
    }
  }

  if (!best) {
    return null;
  }

  const toleranceWidth = Math.max(4, Math.round(width * 0.04));
  const toleranceHeight = Math.max(4, Math.round(height * 0.04));
  if (Math.abs(best.width - width) <= toleranceWidth && Math.abs(best.height - height) <= toleranceHeight) {
    return best;
  }

  const widthRatio = width / Math.max(1, best.width);
  const heightRatio = height / Math.max(1, best.height);
  const uniformScale = Math.abs(widthRatio - heightRatio) <= 0.05;
  const frameAspect = width / Math.max(1, height);
  const displayAspect = best.width / Math.max(1, best.height);
  const aspectClose = Math.abs(frameAspect - displayAspect) <= 0.04;
  if (uniformScale && aspectClose) {
    return best;
  }

  return null;
}

function parseJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xFF) {
      offset += 1;
    }
    while (offset < buffer.length && buffer[offset] === 0xFF) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xD8 || marker === 0xD9 || marker === 0x01) {
      continue;
    }
    if (marker >= 0xD0 && marker <= 0xD7) {
      continue;
    }
    if (offset + 1 >= buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || (offset + segmentLength) > buffer.length) {
      break;
    }

    const isSofMarker = (
      marker >= 0xC0
      && marker <= 0xCF
      && marker !== 0xC4
      && marker !== 0xC8
      && marker !== 0xCC
    );

    if (isSofMarker && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      break;
    }

    offset += segmentLength;
  }

  return null;
}

function calibrateDisplayBoundsToFrame(displayBounds, frameWidth, frameHeight, availableDisplays) {
  const normalizedFrameWidth = clampInteger(frameWidth, 320, 16_384);
  const normalizedFrameHeight = clampInteger(frameHeight, 240, 16_384);

  const virtualWidth = clampInteger(
    Number(displayBounds.virtualWidth) || Number(displayBounds.width) || normalizedFrameWidth,
    1,
    16_384
  );
  const virtualHeight = clampInteger(
    Number(displayBounds.virtualHeight) || Number(displayBounds.height) || normalizedFrameHeight,
    1,
    16_384
  );

  const virtualLeft = clampInteger(
    Number(displayBounds.virtualLeft) || Number(displayBounds.left) || 0,
    -32_768,
    32_768
  );
  const virtualTop = clampInteger(
    Number(displayBounds.virtualTop) || Number(displayBounds.top) || 0,
    -32_768,
    32_768
  );

  const ratioX = normalizedFrameWidth / Math.max(1, virtualWidth);
  const ratioY = normalizedFrameHeight / Math.max(1, virtualHeight);
  const ratioDelta = Math.abs(ratioX - ratioY);
  const needsScaleCalibration = Math.abs(ratioX - 1) > 0.02 || Math.abs(ratioY - 1) > 0.02;
  const canScaleVirtualUniformly = ratioDelta <= 0.035;
  const baseSource = typeof displayBounds.baseSource === 'string' && displayBounds.baseSource
    ? displayBounds.baseSource
    : 'display-bounds';
  const matchedDisplay = chooseDisplayForFrame(
    normalizedFrameWidth,
    normalizedFrameHeight,
    availableDisplays
  );

  let next = null;
  if (matchedDisplay) {
    next = {
      left: matchedDisplay.left,
      top: matchedDisplay.top,
      width: matchedDisplay.width,
      height: matchedDisplay.height,
      scaleX: Number((normalizedFrameWidth / Math.max(1, matchedDisplay.width)).toFixed(4)),
      scaleY: Number((normalizedFrameHeight / Math.max(1, matchedDisplay.height)).toFixed(4)),
      source: 'capture-display',
      captureDisplayId: matchedDisplay.id || null,
      captureDisplayName: matchedDisplay.name || null
    };
  } else if (!needsScaleCalibration) {
    next = {
      left: virtualLeft,
      top: virtualTop,
      width: virtualWidth,
      height: virtualHeight,
      scaleX: 1,
      scaleY: 1,
      source: baseSource,
      captureDisplayId: null,
      captureDisplayName: null
    };
  } else if (canScaleVirtualUniformly) {
    next = {
      left: Math.round(virtualLeft * ratioX),
      top: Math.round(virtualTop * ratioY),
      width: normalizedFrameWidth,
      height: normalizedFrameHeight,
      scaleX: Number(ratioX.toFixed(4)),
      scaleY: Number(ratioY.toFixed(4)),
      source: 'capture-calibrated',
      captureDisplayId: null,
      captureDisplayName: null
    };
  } else {
    // Non-uniform frame/virtual ratios usually indicate monitor cropping; avoid lossy virtual scaling.
    next = {
      left: virtualLeft,
      top: virtualTop,
      width: virtualWidth,
      height: virtualHeight,
      scaleX: Number(ratioX.toFixed(4)),
      scaleY: Number(ratioY.toFixed(4)),
      source: 'capture-ambiguous',
      captureDisplayId: null,
      captureDisplayName: null
    };
  }

  const changed = (
    displayBounds.left !== next.left
    || displayBounds.top !== next.top
    || displayBounds.width !== next.width
    || displayBounds.height !== next.height
    || displayBounds.captureWidth !== normalizedFrameWidth
    || displayBounds.captureHeight !== normalizedFrameHeight
    || displayBounds.captureDisplayId !== next.captureDisplayId
    || displayBounds.captureDisplayName !== next.captureDisplayName
    || displayBounds.source !== next.source
  );

  displayBounds.left = next.left;
  displayBounds.top = next.top;
  displayBounds.width = next.width;
  displayBounds.height = next.height;
  displayBounds.captureWidth = normalizedFrameWidth;
  displayBounds.captureHeight = normalizedFrameHeight;
  displayBounds.captureDisplayId = next.captureDisplayId;
  displayBounds.captureDisplayName = next.captureDisplayName;
  displayBounds.scaleX = next.scaleX;
  displayBounds.scaleY = next.scaleY;
  displayBounds.source = next.source;

  if (!Number.isFinite(displayBounds.virtualLeft)) {
    displayBounds.virtualLeft = virtualLeft;
  }
  if (!Number.isFinite(displayBounds.virtualTop)) {
    displayBounds.virtualTop = virtualTop;
  }
  if (!Number.isFinite(displayBounds.virtualWidth) || displayBounds.virtualWidth <= 0) {
    displayBounds.virtualWidth = virtualWidth;
  }
  if (!Number.isFinite(displayBounds.virtualHeight) || displayBounds.virtualHeight <= 0) {
    displayBounds.virtualHeight = virtualHeight;
  }

  return changed;
}

function createUnavailableCursorTracker(reason) {
  return {
    available: false,
    reason: reason || 'cursor-tracker-unavailable',
    getSnapshot() {
      return null;
    },
    close() {}
  };
}

function createWindowsCursorTracker(logger) {
  if (process.platform !== 'win32') {
    return createUnavailableCursorTracker('cursor-tracker-only-on-windows');
  }

  const state = {
    available: true,
    reason: null,
    shell: null,
    buffer: '',
    closed: false,
    x: null,
    y: null,
    mapLeft: 0,
    mapTop: 0,
    mapWidth: null,
    mapHeight: null,
    updatedAt: 0
  };

  function markUnavailable(reason) {
    state.available = false;
    state.reason = reason || 'cursor-tracker-unavailable';
  }

  try {
    state.shell = childProcess.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
  } catch (error) {
    markUnavailable(error && error.message ? error.message : 'cursor-tracker-spawn-failed');
    return createUnavailableCursorTracker(state.reason);
  }

  const trackerScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeCursorDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
[NativeCursorDpi]::SetProcessDPIAware() | Out-Null
while ($true) {
  try {
    $p = [System.Windows.Forms.Cursor]::Position
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    Write-Output (
      $p.X.ToString()+","+
      $p.Y.ToString()+","+
      $b.Left.ToString()+","+
      $b.Top.ToString()+","+
      $b.Width.ToString()+","+
      $b.Height.ToString()
    )
  } catch {
  }
  Start-Sleep -Milliseconds 24
}
`;

  function parseCursorLine(line) {
    const match = String(line || '').trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+),(\d+),(\d+)$/);
    if (!match) {
      return;
    }
    state.x = Number.parseInt(match[1], 10);
    state.y = Number.parseInt(match[2], 10);
    state.mapLeft = Number.parseInt(match[3], 10);
    state.mapTop = Number.parseInt(match[4], 10);
    state.mapWidth = Number.parseInt(match[5], 10);
    state.mapHeight = Number.parseInt(match[6], 10);
    state.updatedAt = Date.now();
  }

  function consumeStdout(chunk) {
    state.buffer += String(chunk || '');
    let newlineIndex = state.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = state.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      state.buffer = state.buffer.slice(newlineIndex + 1);
      parseCursorLine(line);
      newlineIndex = state.buffer.indexOf('\n');
    }
  }

  if (state.shell.stdout) {
    state.shell.stdout.on('data', consumeStdout);
    state.shell.stdout.on('error', (error) => {
      const message = error && error.message ? error.message : 'cursor-tracker-stdout-error';
      markUnavailable(message);
      logger.warn('Cursor tracker stdout error', { message });
    });
  }

  if (state.shell.stderr) {
    state.shell.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (!message) {
        return;
      }
      logger.debug('Cursor tracker stderr', { message });
    });
  }

  state.shell.on('exit', (code, signal) => {
    state.closed = true;
    markUnavailable(`cursor-tracker-exited:${code}:${signal || 'none'}`);
    logger.warn('Cursor tracker shell exited', {
      code,
      signal: signal || null
    });
  });

  state.shell.on('error', (error) => {
    const message = error && error.message ? error.message : 'cursor-tracker-shell-error';
    markUnavailable(message);
    logger.warn('Cursor tracker shell error', { message });
  });

  if (state.shell.stdin) {
    state.shell.stdin.on('error', (error) => {
      const message = error && error.message ? error.message : 'cursor-tracker-stdin-error';
      markUnavailable(message);
    });
  }

  try {
    state.shell.stdin.write(`${trackerScript}\n`);
  } catch (error) {
    markUnavailable(error && error.message ? error.message : 'cursor-tracker-bootstrap-failed');
    if (state.shell && !state.shell.killed) {
      try {
        state.shell.kill();
      } catch (_error) {
        // Ignore cursor tracker cleanup races.
      }
    }
    return createUnavailableCursorTracker(state.reason);
  }

  return {
    get available() {
      return state.available;
    },
    get reason() {
      return state.reason;
    },
    getSnapshot(displayBounds) {
      if (!state.available || !Number.isFinite(state.x) || !Number.isFinite(state.y)) {
        return null;
      }

      const left = Number.isFinite(displayBounds && displayBounds.left)
        ? Number(displayBounds.left)
        : (Number.isFinite(state.mapLeft) ? state.mapLeft : 0);
      const top = Number.isFinite(displayBounds && displayBounds.top)
        ? Number(displayBounds.top)
        : (Number.isFinite(state.mapTop) ? state.mapTop : 0);
      const width = Math.max(1, Number.isFinite(displayBounds && displayBounds.width)
        ? Number(displayBounds.width)
        : (Number.isFinite(state.mapWidth) && state.mapWidth > 0 ? state.mapWidth : 1));
      const height = Math.max(1, Number.isFinite(displayBounds && displayBounds.height)
        ? Number(displayBounds.height)
        : (Number.isFinite(state.mapHeight) && state.mapHeight > 0 ? state.mapHeight : 1));

      const normalizedX = clampNormalized((state.x - left) / Math.max(1, width - 1));
      const normalizedY = clampNormalized((state.y - top) / Math.max(1, height - 1));
      if (normalizedX === null || normalizedY === null) {
        return null;
      }

      return {
        x: Number(normalizedX.toFixed(6)),
        y: Number(normalizedY.toFixed(6)),
        screenX: state.x,
        screenY: state.y,
        mapLeft: left,
        mapTop: top,
        mapWidth: width,
        mapHeight: height,
        at: state.updatedAt || Date.now()
      };
    },
    close() {
      state.closed = true;
      if (state.shell && !state.shell.killed) {
        try {
          state.shell.stdin.write("exit\n");
          state.shell.stdin.end();
        } catch (_error) {
          // Ignore stdin shutdown races.
        }

        setTimeout(() => {
          if (state.shell && !state.shell.killed) {
            try {
              state.shell.kill();
            } catch (_error) {
              // Ignore force-kill races.
            }
          }
        }, 200).unref();
      }
    }
  };
}

function createUnavailableInputController(reason) {
  return {
    available: false,
    reason,
    async handleEvent() {
      return { ok: false, reason };
    }
  };
}

function pickEnumValue(enumObject, names) {
  if (!enumObject || typeof enumObject !== 'object') {
    return null;
  }

  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(enumObject, name)) {
      return enumObject[name];
    }
  }

  return null;
}

function createNutInputController(nut, displayBounds, logger) {
  const mouse = nut && nut.mouse;
  const keyboard = nut && nut.keyboard;
  const Button = nut && nut.Button;
  const Key = nut && nut.Key;
  const Point = nut && nut.Point;

  if (!mouse || !keyboard || !Button || !Key) {
    return createUnavailableInputController('nut-js api incomplete');
  }

  const keyMapByCode = {
    Enter: ['Enter', 'Return'],
    Escape: ['Escape'],
    Backspace: ['Backspace'],
    Tab: ['Tab'],
    Space: ['Space'],
    ArrowUp: ['Up'],
    ArrowDown: ['Down'],
    ArrowLeft: ['Left'],
    ArrowRight: ['Right'],
    Delete: ['Delete'],
    Home: ['Home'],
    End: ['End'],
    PageUp: ['PageUp'],
    PageDown: ['PageDown'],
    Insert: ['Insert'],
    F1: ['F1'],
    F2: ['F2'],
    F3: ['F3'],
    F4: ['F4'],
    F5: ['F5'],
    F6: ['F6'],
    F7: ['F7'],
    F8: ['F8'],
    F9: ['F9'],
    F10: ['F10'],
    F11: ['F11'],
    F12: ['F12']
  };

  const keyMapByName = {
    enter: ['Enter', 'Return'],
    escape: ['Escape'],
    esc: ['Escape'],
    backspace: ['Backspace'],
    tab: ['Tab'],
    space: ['Space'],
    ' ': ['Space'],
    arrowup: ['Up'],
    arrowdown: ['Down'],
    arrowleft: ['Left'],
    arrowright: ['Right'],
    up: ['Up'],
    down: ['Down'],
    left: ['Left'],
    right: ['Right'],
    delete: ['Delete'],
    home: ['Home'],
    end: ['End'],
    pageup: ['PageUp'],
    pagedown: ['PageDown']
  };

  function resolveCharacterKey(keyValue) {
    if (!keyValue || typeof keyValue !== 'string' || keyValue.length !== 1) {
      return null;
    }

    const upper = keyValue.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return pickEnumValue(Key, [upper]);
    }

    if (upper >= '0' && upper <= '9') {
      return pickEnumValue(Key, [`Num${upper}`, `Number${upper}`, upper]);
    }

    return null;
  }

  function resolveKey(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const code = typeof event.code === 'string' ? event.code.trim() : '';
    if (code) {
      if (/^Key[A-Z]$/.test(code)) {
        return pickEnumValue(Key, [code.slice(3)]);
      }
      if (/^Digit[0-9]$/.test(code)) {
        const digit = code.slice(5);
        return pickEnumValue(Key, [`Num${digit}`, `Number${digit}`, digit]);
      }
      if (keyMapByCode[code]) {
        return pickEnumValue(Key, keyMapByCode[code]);
      }
    }

    const keyName = typeof event.key === 'string' ? event.key.trim() : '';
    const fromCharacter = resolveCharacterKey(keyName);
    if (fromCharacter !== null) {
      return fromCharacter;
    }

    if (keyName) {
      const normalized = keyName.toLowerCase();
      if (keyMapByName[normalized]) {
        return pickEnumValue(Key, keyMapByName[normalized]);
      }
    }

    return null;
  }

  function resolveModifierKeys(event) {
    const modifiers = event && event.modifiers && typeof event.modifiers === 'object'
      ? event.modifiers
      : {};

    const keys = [];
    if (modifiers.ctrl === true) {
      const value = pickEnumValue(Key, ['LeftControl', 'RightControl', 'Control']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.shift === true) {
      const value = pickEnumValue(Key, ['LeftShift', 'RightShift', 'Shift']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.alt === true) {
      const value = pickEnumValue(Key, ['LeftAlt', 'RightAlt', 'Alt']);
      if (value !== null) {
        keys.push(value);
      }
    }
    if (modifiers.meta === true) {
      const value = pickEnumValue(Key, ['LeftSuper', 'RightSuper', 'Meta']);
      if (value !== null) {
        keys.push(value);
      }
    }

    return keys;
  }

  function resolveButton(buttonName) {
    const normalized = typeof buttonName === 'string' ? buttonName.trim().toLowerCase() : '';
    if (normalized === 'right') {
      return pickEnumValue(Button, ['RIGHT', 'Right', 'right']);
    }
    if (normalized === 'middle') {
      return pickEnumValue(Button, ['MIDDLE', 'Middle', 'middle']);
    }
    return pickEnumValue(Button, ['LEFT', 'Left', 'left']);
  }

  function buildPoint(x, y) {
    if (typeof Point === 'function') {
      return new Point(x, y);
    }
    return { x, y };
  }

  async function moveToNormalized(x, y) {
    const normalizedX = clampNormalized(x);
    const normalizedY = clampNormalized(y);
    if (normalizedX === null || normalizedY === null) {
      throw new Error('invalid-normalized-coordinates');
    }

    const bounds = getInputBounds(displayBounds);
    const px = bounds.left + Math.round(normalizedX * Math.max(1, bounds.width - 1));
    const py = bounds.top + Math.round(normalizedY * Math.max(1, bounds.height - 1));

    if (typeof mouse.setPosition !== 'function') {
      throw new Error('mouse-setPosition-unavailable');
    }

    await mouse.setPosition(buildPoint(px, py));
  }

  async function handleMouseButton(event) {
    if (event && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      await moveToNormalized(event.x, event.y);
    }

    const button = resolveButton(event.button);
    if (button === null) {
      throw new Error('unknown-mouse-button');
    }

    if (event.action === 'down') {
      if (typeof mouse.pressButton !== 'function') {
        throw new Error('mouse-pressButton-unavailable');
      }
      await mouse.pressButton(button);
      return;
    }

    if (event.action === 'up') {
      if (typeof mouse.releaseButton !== 'function') {
        throw new Error('mouse-releaseButton-unavailable');
      }
      await mouse.releaseButton(button);
      return;
    }

    if (typeof mouse.click === 'function') {
      await mouse.click(button);
      return;
    }

    if (typeof mouse.pressButton === 'function' && typeof mouse.releaseButton === 'function') {
      await mouse.pressButton(button);
      await mouse.releaseButton(button);
      return;
    }

    throw new Error('mouse-click-unavailable');
  }

  async function handleMouseWheel(event) {
    const deltaY = Number(event.deltaY) || 0;
    if (deltaY === 0) {
      return;
    }

    const scrollAmount = clampInteger(Math.abs(Math.round(deltaY / 20)), 1, 40);
    if (deltaY < 0) {
      if (typeof mouse.scrollUp !== 'function') {
        throw new Error('mouse-scrollUp-unavailable');
      }
      await mouse.scrollUp(scrollAmount);
      return;
    }

    if (typeof mouse.scrollDown !== 'function') {
      throw new Error('mouse-scrollDown-unavailable');
    }
    await mouse.scrollDown(scrollAmount);
  }

  async function handleKeyEvent(event) {
    const action = typeof event.action === 'string' ? event.action : 'press';
    const key = resolveKey(event);
    const text = typeof event.text === 'string' ? event.text : '';
    const modifiers = resolveModifierKeys(event);

    if (action === 'down') {
      if (key === null || typeof keyboard.pressKey !== 'function') {
        return;
      }
      await keyboard.pressKey(key);
      return;
    }

    if (action === 'up') {
      if (key === null || typeof keyboard.releaseKey !== 'function') {
        return;
      }
      await keyboard.releaseKey(key);
      return;
    }

    if (modifiers.length > 0 && typeof keyboard.pressKey === 'function') {
      await keyboard.pressKey(...modifiers);
    }

    if (key !== null && typeof keyboard.pressKey === 'function' && typeof keyboard.releaseKey === 'function') {
      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);
    } else if (text && typeof keyboard.type === 'function') {
      await keyboard.type(text);
    } else if (typeof event.key === 'string' && event.key.length === 1 && typeof keyboard.type === 'function') {
      await keyboard.type(event.key);
    }

    if (modifiers.length > 0 && typeof keyboard.releaseKey === 'function') {
      await keyboard.releaseKey(...modifiers.slice().reverse());
    }
  }

  return {
    available: true,
    reason: null,
    async handleEvent(event) {
      if (!event || typeof event !== 'object') {
        throw new Error('invalid-input-event');
      }

      const type = typeof event.type === 'string' ? event.type.trim().toLowerCase() : '';
      if (!type) {
        throw new Error('input-event-missing-type');
      }

      if (type === 'mouse_move') {
        await moveToNormalized(event.x, event.y);
        return { ok: true };
      }

      if (type === 'mouse_button') {
        await handleMouseButton(event);
        return { ok: true };
      }

      if (type === 'mouse_wheel') {
        await handleMouseWheel(event);
        return { ok: true };
      }

      if (type === 'key') {
        await handleKeyEvent(event);
        return { ok: true };
      }

      if (type === 'text') {
        const text = typeof event.text === 'string' ? event.text : '';
        if (!text) {
          return { ok: true };
        }
        if (typeof keyboard.type !== 'function') {
          throw new Error('keyboard-type-unavailable');
        }
        await keyboard.type(text);
        return { ok: true };
      }

      throw new Error(`unsupported-input-type:${type}`);
    }
  };
}

function resolveWindowsVirtualKey(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const keyByCode = {
    Enter: 0x0D,
    Escape: 0x1B,
    Backspace: 0x08,
    Tab: 0x09,
    Space: 0x20,
    ArrowUp: 0x26,
    ArrowDown: 0x28,
    ArrowLeft: 0x25,
    ArrowRight: 0x27,
    Delete: 0x2E,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Insert: 0x2D,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7A,
    F12: 0x7B
  };

  const keyByName = {
    enter: 0x0D,
    escape: 0x1B,
    esc: 0x1B,
    backspace: 0x08,
    tab: 0x09,
    ' ': 0x20,
    space: 0x20,
    arrowup: 0x26,
    arrowdown: 0x28,
    arrowleft: 0x25,
    arrowright: 0x27,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    delete: 0x2E,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22
  };

  const code = typeof event.code === 'string' ? event.code.trim() : '';
  if (code) {
    if (/^Key[A-Z]$/.test(code)) {
      return code.charCodeAt(3);
    }
    if (/^Digit[0-9]$/.test(code)) {
      return 0x30 + Number.parseInt(code.slice(5), 10);
    }
    if (/^Numpad[0-9]$/.test(code)) {
      return 0x60 + Number.parseInt(code.slice(6), 10);
    }
    if (Object.prototype.hasOwnProperty.call(keyByCode, code)) {
      return keyByCode[code];
    }
  }

  const keyValue = typeof event.key === 'string' ? event.key.trim() : '';
  if (keyValue.length === 1) {
    const upper = keyValue.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') {
      return upper.charCodeAt(0);
    }
    if (upper >= '0' && upper <= '9') {
      return upper.charCodeAt(0);
    }
  }
  const keyNormalized = keyValue.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(keyByName, keyNormalized)) {
    return keyByName[keyNormalized];
  }

  return null;
}

function resolveWindowsModifierMask(event) {
  const modifiers = event && event.modifiers && typeof event.modifiers === 'object'
    ? event.modifiers
    : {};

  let mask = 0;
  if (modifiers.ctrl === true) {
    mask |= 1;
  }
  if (modifiers.shift === true) {
    mask |= 2;
  }
  if (modifiers.alt === true) {
    mask |= 4;
  }
  if (modifiers.meta === true) {
    mask |= 8;
  }
  return mask;
}

function createWindowsPowerShellInputController(displayBounds, logger) {
  if (process.platform !== 'win32') {
    return createUnavailableInputController('powershell-input-only-on-windows');
  }

  const state = {
    available: true,
    reason: 'powershell-fallback',
    closed: false,
    shell: null,
    pendingMove: null,
    moveTimer: null
  };

  function markUnavailable(reason) {
    state.available = false;
    state.reason = reason || 'powershell-input-unavailable';
  }

  try {
    state.shell = childProcess.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true
      }
    );
  } catch (error) {
    markUnavailable(error && error.message ? error.message : 'powershell-spawn-failed');
    return createUnavailableInputController(state.reason);
  }

  const bootstrapScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern short VkKeyScan(char ch);
}
"@
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP = 0x0040
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002
$VK_SHIFT = 0x10
$VK_CONTROL = 0x11
$VK_MENU = 0x12
$VK_LWIN = 0x5B

function Invoke-KeyDown([int]$vk) {
  [NativeInput]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
}

function Invoke-KeyUp([int]$vk) {
  [NativeInput]::keybd_event([byte]$vk, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

function Invoke-KeyPress([int]$vk) {
  Invoke-KeyDown $vk
  Invoke-KeyUp $vk
}

function Invoke-ApplyModifierMask([int]$mask, [bool]$down) {
  $mods = New-Object System.Collections.Generic.List[int]
  if (($mask -band 1) -ne 0) { [void]$mods.Add($VK_CONTROL) }
  if (($mask -band 2) -ne 0) { [void]$mods.Add($VK_SHIFT) }
  if (($mask -band 4) -ne 0) { [void]$mods.Add($VK_MENU) }
  if (($mask -band 8) -ne 0) { [void]$mods.Add($VK_LWIN) }

  if ($down) {
    foreach ($vk in $mods) { Invoke-KeyDown $vk }
    return
  }

  for ($i = $mods.Count - 1; $i -ge 0; $i--) {
    Invoke-KeyUp $mods[$i]
  }
}

function Invoke-KeyChord([int]$vk, [int]$modMask) {
  Invoke-ApplyModifierMask $modMask $true
  Invoke-KeyPress $vk
  Invoke-ApplyModifierMask $modMask $false
}

function Invoke-MouseMove([int]$x, [int]$y) {
  [NativeInput]::SetCursorPos($x, $y) | Out-Null
}

function Invoke-MouseButton([string]$button, [string]$action) {
  $downFlag = 0
  $upFlag = 0
  switch ($button) {
    'left' { $downFlag = $MOUSEEVENTF_LEFTDOWN; $upFlag = $MOUSEEVENTF_LEFTUP }
    'right' { $downFlag = $MOUSEEVENTF_RIGHTDOWN; $upFlag = $MOUSEEVENTF_RIGHTUP }
    'middle' { $downFlag = $MOUSEEVENTF_MIDDLEDOWN; $upFlag = $MOUSEEVENTF_MIDDLEUP }
    default { return }
  }

  if ($action -eq 'down') {
    [NativeInput]::mouse_event([uint32]$downFlag, 0, 0, 0, [UIntPtr]::Zero)
    return
  }
  if ($action -eq 'up') {
    [NativeInput]::mouse_event([uint32]$upFlag, 0, 0, 0, [UIntPtr]::Zero)
    return
  }

  [NativeInput]::mouse_event([uint32]$downFlag, 0, 0, 0, [UIntPtr]::Zero)
  [NativeInput]::mouse_event([uint32]$upFlag, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-MouseWheel([int]$deltaY) {
  if ($deltaY -eq 0) { return }
  [NativeInput]::mouse_event([uint32]$MOUSEEVENTF_WHEEL, 0, 0, [uint32]$deltaY, [UIntPtr]::Zero)
}

function Invoke-TextInput([string]$base64) {
  if ([string]::IsNullOrWhiteSpace($base64)) { return }

  $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($base64))
  foreach ($ch in $text.ToCharArray()) {
    if ([int][char]$ch -eq 13 -or [int][char]$ch -eq 10) {
      Invoke-KeyPress 0x0D
      continue
    }

    $vkData = [NativeInput]::VkKeyScan([char]$ch)
    if ($vkData -eq -1) {
      continue
    }

    $vk = $vkData -band 0xFF
    $shiftState = ($vkData -shr 8) -band 0xFF
    $mask = 0
    if (($shiftState -band 2) -ne 0) { $mask = $mask -bor 1 }
    if (($shiftState -band 1) -ne 0) { $mask = $mask -bor 2 }
    if (($shiftState -band 4) -ne 0) { $mask = $mask -bor 4 }
    Invoke-KeyChord $vk $mask
  }
}
`;

  function writePowerShellCommand(command) {
    if (!state.available || state.closed || !state.shell || !state.shell.stdin || state.shell.stdin.destroyed) {
      throw new Error('powershell-input-shell-unavailable');
    }

    state.shell.stdin.write(`${command}\n`);
  }

  state.shell.on('exit', (code, signal) => {
    state.closed = true;
    markUnavailable(`powershell-shell-exited:${code}:${signal || 'none'}`);
    logger.warn('PowerShell input shell exited', {
      code,
      signal: signal || null
    });
  });

  state.shell.on('error', (error) => {
    const message = error && error.message ? error.message : 'powershell-shell-error';
    markUnavailable(message);
    logger.warn('PowerShell input shell error', { message });
  });

  if (state.shell.stderr) {
    state.shell.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (!message) {
        return;
      }
      logger.debug('PowerShell input stderr', { message });
    });
  }

  if (state.shell.stdin) {
    state.shell.stdin.on('error', (error) => {
      markUnavailable(error && error.message ? error.message : 'powershell-stdin-error');
    });
  }

  try {
    writePowerShellCommand(bootstrapScript);
  } catch (error) {
    markUnavailable(error && error.message ? error.message : 'powershell-bootstrap-failed');
    if (state.shell && !state.shell.killed) {
      try {
        state.shell.kill();
      } catch (_error) {
        // Ignore shell cleanup races.
      }
    }
    return createUnavailableInputController(state.reason);
  }

  function normalizedToPixels(x, y) {
    const normalizedX = clampNormalized(x);
    const normalizedY = clampNormalized(y);
    if (normalizedX === null || normalizedY === null) {
      return null;
    }

    const bounds = getInputBounds(displayBounds);

    return {
      px: bounds.left + Math.round(normalizedX * Math.max(1, bounds.width - 1)),
      py: bounds.top + Math.round(normalizedY * Math.max(1, bounds.height - 1))
    };
  }

  function flushPendingMove() {
    if (!state.pendingMove) {
      return;
    }
    const move = state.pendingMove;
    state.pendingMove = null;
    writePowerShellCommand(`Invoke-MouseMove ${move.px} ${move.py}`);
  }

  function queueMove(pixels) {
    state.pendingMove = pixels;
    if (state.moveTimer) {
      return;
    }

    state.moveTimer = setTimeout(() => {
      state.moveTimer = null;
      try {
        flushPendingMove();
      } catch (error) {
        markUnavailable(error && error.message ? error.message : 'powershell-move-failed');
      }
    }, 16);
    state.moveTimer.unref();
  }

  function moveCursor(event, coalesce) {
    const pixels = normalizedToPixels(event.x, event.y);
    if (!pixels) {
      return;
    }
    if (coalesce) {
      queueMove(pixels);
      return;
    }
    flushPendingMove();
    writePowerShellCommand(`Invoke-MouseMove ${pixels.px} ${pixels.py}`);
  }

  return {
    get available() {
      return state.available;
    },
    get reason() {
      return state.reason;
    },
    async handleEvent(event) {
      if (!state.available) {
        throw new Error(state.reason || 'powershell-input-unavailable');
      }

      if (!event || typeof event !== 'object') {
        throw new Error('invalid-input-event');
      }

      const type = typeof event.type === 'string' ? event.type.trim().toLowerCase() : '';
      if (!type) {
        throw new Error('input-event-missing-type');
      }

      if (type === 'mouse_move') {
        moveCursor(event, true);
        return { ok: true };
      }

      if (type === 'mouse_button') {
        if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
          moveCursor(event, false);
        }
        writePowerShellCommand(`Invoke-MouseButton '${event.button}' '${event.action}'`);
        return { ok: true };
      }

      if (type === 'mouse_wheel') {
        if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
          moveCursor(event, false);
        }
        const deltaY = clampInteger(Number(event.deltaY) || 0, -1200, 1200);
        if (deltaY !== 0) {
          writePowerShellCommand(`Invoke-MouseWheel ${deltaY}`);
        }
        return { ok: true };
      }

      if (type === 'key') {
        const vk = resolveWindowsVirtualKey(event);
        const action = typeof event.action === 'string' ? event.action.trim().toLowerCase() : 'press';
        const modifierMask = resolveWindowsModifierMask(event);

        if (vk !== null) {
          if (action === 'down') {
            writePowerShellCommand(`Invoke-KeyDown ${vk}`);
            return { ok: true };
          }
          if (action === 'up') {
            writePowerShellCommand(`Invoke-KeyUp ${vk}`);
            return { ok: true };
          }
          writePowerShellCommand(`Invoke-KeyChord ${vk} ${modifierMask}`);
          return { ok: true };
        }

        const text = typeof event.text === 'string' ? event.text : '';
        if (text) {
          const encoded = Buffer.from(text, 'utf8').toString('base64');
          writePowerShellCommand(`Invoke-TextInput '${encoded}'`);
          return { ok: true };
        }
        return { ok: true };
      }

      if (type === 'text') {
        const text = typeof event.text === 'string' ? event.text : '';
        if (!text) {
          return { ok: true };
        }
        const encoded = Buffer.from(text, 'utf8').toString('base64');
        writePowerShellCommand(`Invoke-TextInput '${encoded}'`);
        return { ok: true };
      }

      throw new Error(`unsupported-input-type:${type}`);
    },
    close() {
      state.closed = true;
      if (state.moveTimer) {
        clearTimeout(state.moveTimer);
        state.moveTimer = null;
      }
      state.pendingMove = null;

      if (state.shell && !state.shell.killed) {
        try {
          state.shell.stdin.write("exit\n");
          state.shell.stdin.end();
        } catch (_error) {
          // Ignore stdin shutdown races.
        }

        setTimeout(() => {
          if (state.shell && !state.shell.killed) {
            try {
              state.shell.kill();
            } catch (_error) {
              // Ignore force-kill races.
            }
          }
        }, 200).unref();
      }
    }
  };
}

function createInputController(config, displayBounds, logger) {
  if (!config.inputEnabled) {
    return createUnavailableInputController('disabled-by-env');
  }

  let nut = null;
  try {
    // Optional dependency: if this fails, we intentionally keep view-only streaming.
    nut = require('@nut-tree-fork/nut-js');
  } catch (error) {
    logger.warn('nut-js unavailable, attempting PowerShell input fallback', {
      message: error.message
    });
    if (process.platform === 'win32') {
      const fallbackController = createWindowsPowerShellInputController(displayBounds, logger);
      if (fallbackController.available === true) {
        logger.info('PowerShell input fallback enabled');
        return fallbackController;
      }
      logger.warn('PowerShell input fallback unavailable, starting in view-only mode', {
        reason: fallbackController.reason
      });
      return fallbackController;
    }
    return createUnavailableInputController('nut-js-not-installed');
  }

  try {
    return createNutInputController(nut, displayBounds, logger);
  } catch (error) {
    logger.warn('Failed to initialize nut-js input controller, attempting PowerShell fallback', {
      message: error.message
    });
    if (process.platform === 'win32') {
      const fallbackController = createWindowsPowerShellInputController(displayBounds, logger);
      if (fallbackController.available === true) {
        logger.info('PowerShell input fallback enabled');
        return fallbackController;
      }
      logger.warn('PowerShell input fallback unavailable, starting in view-only mode', {
        reason: fallbackController.reason
      });
      return fallbackController;
    }
    return createUnavailableInputController('nut-js-init-failed');
  }
}

const config = {
  host: process.env.REMOTE_AGENT_HOST || '127.0.0.1',
  port: clampInteger(parseInteger(process.env.REMOTE_AGENT_PORT, 3390), 1, 65_535),
  streamFps: clampInteger(parseInteger(process.env.REMOTE_STREAM_FPS, 8), 1, 20),
  jpegQuality: clampInteger(parseInteger(process.env.REMOTE_JPEG_QUALITY, 55), 20, 95),
  inputEnabled: parseBoolean(process.env.REMOTE_INPUT_ENABLED, true),
  logLevel: process.env.LOG_LEVEL || 'info'
};

const logger = createLogger(config.logLevel);
const displayBounds = resolveDisplayBounds(logger);
const cursorTracker = createWindowsCursorTracker(logger);
const inputController = createInputController(config, displayBounds, logger);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const streamState = {
  clients: new Set(),
  timer: null,
  inFlight: false,
  activeFps: config.streamFps,
  activeQuality: config.jpegQuality,
  framesInWindow: 0,
  windowStartedAt: Date.now(),
  currentFps: 0,
  lastFrameBytes: 0,
  lastCaptureTs: 0,
  lastCaptureLatencyMs: 0,
  lastCaptureError: null,
  lastErrorAt: 0
};

const captureDisplayCatalog = {
  entries: [],
  refreshedAt: 0,
  inFlight: null,
  lastError: null,
  lastErrorAt: 0,
  lastAttemptAt: 0
};

async function refreshCaptureDisplayCatalog(force = false) {
  if (typeof screenshotDesktop.listDisplays !== 'function') {
    return captureDisplayCatalog.entries;
  }

  const now = Date.now();
  if (!force && captureDisplayCatalog.entries.length > 0 && (now - captureDisplayCatalog.refreshedAt) < 120_000) {
    return captureDisplayCatalog.entries;
  }
  if (!force && captureDisplayCatalog.inFlight) {
    return captureDisplayCatalog.inFlight;
  }

  captureDisplayCatalog.lastAttemptAt = now;
  const inFlight = screenshotDesktop.listDisplays()
    .then((rawDisplays) => {
      const normalized = Array.isArray(rawDisplays)
        ? rawDisplays
          .map((entry) => normalizeDisplayDescriptor(entry))
          .filter((entry) => entry !== null)
        : [];
      captureDisplayCatalog.entries = normalized;
      captureDisplayCatalog.refreshedAt = Date.now();
      captureDisplayCatalog.lastError = null;
      return normalized;
    })
    .catch((error) => {
      captureDisplayCatalog.lastError = error && error.message ? error.message : 'display-list-failed';
      const nowMs = Date.now();
      if ((nowMs - captureDisplayCatalog.lastErrorAt) >= 10_000) {
        captureDisplayCatalog.lastErrorAt = nowMs;
        logger.warn('Failed to list capture displays', {
          message: captureDisplayCatalog.lastError
        });
      }
      return captureDisplayCatalog.entries;
    });

  captureDisplayCatalog.inFlight = inFlight;
  try {
    return await inFlight;
  } finally {
    if (captureDisplayCatalog.inFlight === inFlight) {
      captureDisplayCatalog.inFlight = null;
    }
  }
}

refreshCaptureDisplayCatalog(false).catch(() => {});

function getOpenStreamClientCount() {
  let count = 0;
  for (const client of streamState.clients) {
    if (isWsOpen(client)) {
      count += 1;
    }
  }
  return count;
}

function broadcastStreamControl(payload) {
  const message = JSON.stringify(payload);
  for (const client of streamState.clients) {
    if (!isWsOpen(client)) {
      continue;
    }
    try {
      client.send(message);
    } catch (_error) {
      // Ignore send races.
    }
  }
}

function recomputeStreamSettings() {
  let nextFps = config.streamFps;
  let nextQuality = config.jpegQuality;

  for (const client of streamState.clients) {
    if (!isWsOpen(client)) {
      continue;
    }

    if (Number.isFinite(client.requestedFps)) {
      nextFps = clampInteger(client.requestedFps, 1, 20);
    }
    if (Number.isFinite(client.requestedQuality)) {
      nextQuality = clampInteger(client.requestedQuality, 20, 95);
    }
  }

  const fpsChanged = nextFps !== streamState.activeFps;
  streamState.activeFps = nextFps;
  streamState.activeQuality = nextQuality;

  if (fpsChanged && streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
    startStreamLoop();
  }
}

async function captureAndBroadcastFrame() {
  if (streamState.inFlight) {
    return;
  }
  if (getOpenStreamClientCount() === 0) {
    return;
  }

  streamState.inFlight = true;
  const captureStart = Date.now();
  if (
    captureDisplayCatalog.entries.length === 0
    && (Date.now() - captureDisplayCatalog.lastAttemptAt) >= 15_000
  ) {
    refreshCaptureDisplayCatalog(false).catch(() => {});
  }

  try {
    const frame = await screenshotDesktop({
      format: 'jpg',
      quality: streamState.activeQuality
    });

    const frameBuffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const frameDimensions = parseJpegDimensions(frameBuffer);
    if (frameDimensions) {
      const changed = calibrateDisplayBoundsToFrame(
        displayBounds,
        frameDimensions.width,
        frameDimensions.height,
        captureDisplayCatalog.entries
      );
      if (changed) {
        logger.info('Updated display mapping from capture frame', {
          left: displayBounds.left,
          top: displayBounds.top,
          width: displayBounds.width,
          height: displayBounds.height,
          virtualLeft: displayBounds.virtualLeft,
          virtualTop: displayBounds.virtualTop,
          virtualWidth: displayBounds.virtualWidth,
          virtualHeight: displayBounds.virtualHeight,
          captureWidth: displayBounds.captureWidth,
          captureHeight: displayBounds.captureHeight,
          captureDisplayId: displayBounds.captureDisplayId,
          captureDisplayName: displayBounds.captureDisplayName,
          scaleX: displayBounds.scaleX,
          scaleY: displayBounds.scaleY,
          source: displayBounds.source
        });
      }
    }
    const now = Date.now();

    streamState.lastCaptureTs = now;
    streamState.lastCaptureLatencyMs = now - captureStart;
    streamState.lastFrameBytes = frameBuffer.length;
    streamState.framesInWindow += 1;
    streamState.lastCaptureError = null;
    const cursorSnapshot = cursorTracker.getSnapshot(displayBounds);
    const cursorMessage = cursorSnapshot
      ? JSON.stringify({
        type: 'cursor',
        x: cursorSnapshot.x,
        y: cursorSnapshot.y,
        screenX: cursorSnapshot.screenX,
        screenY: cursorSnapshot.screenY,
        mapLeft: cursorSnapshot.mapLeft,
        mapTop: cursorSnapshot.mapTop,
        mapWidth: cursorSnapshot.mapWidth,
        mapHeight: cursorSnapshot.mapHeight,
        at: cursorSnapshot.at
      })
      : null;

    for (const client of streamState.clients) {
      if (!isWsOpen(client)) {
        continue;
      }
      try {
        client.send(frameBuffer, { binary: true });
        if (cursorMessage) {
          client.send(cursorMessage);
        }
      } catch (_error) {
        // Ignore send races.
      }
    }

    const elapsedWindowMs = now - streamState.windowStartedAt;
    if (elapsedWindowMs >= 1000) {
      streamState.currentFps = (streamState.framesInWindow * 1000) / Math.max(1, elapsedWindowMs);
      streamState.framesInWindow = 0;
      streamState.windowStartedAt = now;

      broadcastStreamControl({
        type: 'stats',
        fps: Number(streamState.currentFps.toFixed(2)),
        frameBytes: streamState.lastFrameBytes,
        captureTs: streamState.lastCaptureTs,
        captureLatencyMs: streamState.lastCaptureLatencyMs,
        clients: getOpenStreamClientCount()
      });
    }
  } catch (error) {
    streamState.lastCaptureError = error && error.message ? error.message : 'capture-failed';
    const now = Date.now();

    if ((now - streamState.lastErrorAt) >= 2000) {
      streamState.lastErrorAt = now;
      logger.warn('Desktop capture failed', {
        message: streamState.lastCaptureError
      });

      broadcastStreamControl({
        type: 'error',
        message: streamState.lastCaptureError
      });
    }
  } finally {
    streamState.inFlight = false;
  }
}

function startStreamLoop() {
  if (streamState.timer || getOpenStreamClientCount() === 0) {
    return;
  }

  refreshCaptureDisplayCatalog(false).catch(() => {});

  const intervalMs = Math.max(60, Math.round(1000 / streamState.activeFps));
  streamState.timer = setInterval(() => {
    captureAndBroadcastFrame().catch(() => {});
  }, intervalMs);
  streamState.timer.unref();

  captureAndBroadcastFrame().catch(() => {});
}

function stopStreamLoopIfIdle() {
  if (getOpenStreamClientCount() > 0) {
    return;
  }

  if (streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
  }
}

app.get('/health', (_req, res) => {
  const cursorSnapshot = cursorTracker.getSnapshot(displayBounds);
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    stream: {
      fps: Number(streamState.currentFps.toFixed(2)),
      targetFps: streamState.activeFps,
      jpegQuality: streamState.activeQuality,
      clients: getOpenStreamClientCount(),
      lastFrameBytes: streamState.lastFrameBytes,
      lastCaptureTs: streamState.lastCaptureTs || null,
      lastCaptureLatencyMs: streamState.lastCaptureLatencyMs || null,
      lastError: streamState.lastCaptureError
    },
    input: {
      available: inputController.available === true,
      reason: inputController.reason || null
    },
    cursor: {
      available: cursorTracker.available === true,
      reason: cursorTracker.reason || null,
      snapshot: cursorSnapshot || null
    },
    display: displayBounds,
    platform: process.platform
  });
});

const server = http.createServer(app);

const streamWss = new WebSocketServer({ noServer: true });
streamWss.on('connection', (socket, req) => {
  const query = parseRequestQuery(req);
  socket.requestedFps = clampInteger(parseInteger(query.get('fps'), config.streamFps), 1, 20);
  socket.requestedQuality = clampInteger(parseInteger(query.get('quality'), config.jpegQuality), 20, 95);

  streamState.clients.add(socket);
  recomputeStreamSettings();
  startStreamLoop();

  if (isWsOpen(socket)) {
    socket.send(JSON.stringify({
      type: 'ready',
      fps: streamState.activeFps,
      jpegQuality: streamState.activeQuality
    }));
  }

  socket.on('close', () => {
    streamState.clients.delete(socket);
    recomputeStreamSettings();
    stopStreamLoopIfIdle();
  });

  socket.on('error', (error) => {
    logger.warn('Stream websocket client error', {
      message: error.message
    });
  });
});

const inputWss = new WebSocketServer({ noServer: true });
inputWss.on('connection', (socket) => {
  if (inputController.available !== true) {
    if (isWsOpen(socket)) {
      socket.send(JSON.stringify({
        type: 'error',
        message: `input unavailable (${inputController.reason || 'unknown'})`
      }));
    }
    socket.close(1013, 'Input unavailable');
    return;
  }

  if (isWsOpen(socket)) {
    socket.send(JSON.stringify({
      type: 'ready'
    }));
  }

  let pending = Promise.resolve();

  socket.on('message', (rawValue, isBinary) => {
    if (isBinary) {
      return;
    }

    const text = decodeWsText(rawValue);
    if (!text) {
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      if (isWsOpen(socket)) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'invalid-json'
        }));
      }
      return;
    }

    const event = payload && payload.type === 'input' ? payload.event : payload;
    if (!event || typeof event !== 'object') {
      return;
    }

    pending = pending
      .then(async () => {
        await inputController.handleEvent(event);
      })
      .catch((error) => {
        const message = error && error.message ? error.message : 'input-execution-failed';
        logger.warn('Input event failed', {
          message
        });

        if (isWsOpen(socket)) {
          socket.send(JSON.stringify({
            type: 'error',
            message
          }));
        }
      });
  });

  socket.on('error', (error) => {
    logger.warn('Input websocket client error', {
      message: error.message
    });
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = getRequestPath(req);

  if (pathname === '/stream') {
    streamWss.handleUpgrade(req, socket, head, (clientSocket) => {
      streamWss.emit('connection', clientSocket, req);
    });
    return;
  }

  if (pathname === '/input') {
    inputWss.handleUpgrade(req, socket, head, (clientSocket) => {
      inputWss.emit('connection', clientSocket, req);
    });
    return;
  }

  try {
    socket.destroy();
  } catch (_error) {
    // Ignore socket teardown races.
  }
});

server.listen(config.port, config.host, () => {
  logger.info('Remote sidecar listening', {
    url: `http://${config.host}:${config.port}`,
    streamFps: config.streamFps,
    jpegQuality: config.jpegQuality,
    inputAvailable: inputController.available,
    inputReason: inputController.reason,
    cursorAvailable: cursorTracker.available,
    cursorReason: cursorTracker.reason,
    display: displayBounds
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Shutting down remote sidecar', { signal });

  if (streamState.timer) {
    clearInterval(streamState.timer);
    streamState.timer = null;
  }

  if (inputController && typeof inputController.close === 'function') {
    try {
      inputController.close();
    } catch (_error) {
      // Ignore input controller shutdown races.
    }
  }

  if (cursorTracker && typeof cursorTracker.close === 'function') {
    try {
      cursorTracker.close();
    } catch (_error) {
      // Ignore cursor tracker shutdown races.
    }
  }

  for (const socket of streamWss.clients) {
    try {
      socket.close(1001, 'Sidecar shutting down');
    } catch (_error) {
      // Ignore close races.
    }
  }

  for (const socket of inputWss.clients) {
    try {
      socket.close(1001, 'Sidecar shutting down');
    } catch (_error) {
      // Ignore close races.
    }
  }

  streamWss.close();
  inputWss.close();

  server.close(() => {
    logger.info('Remote sidecar stopped');
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
