const LEVELS = ['debug', 'info', 'warn', 'error'];

function createLogger(level = 'info') {
  const normalizedLevel = LEVELS.includes(level) ? level : 'info';
  const minimumIndex = LEVELS.indexOf(normalizedLevel);

  function shouldLog(nextLevel) {
    return LEVELS.indexOf(nextLevel) >= minimumIndex;
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

module.exports = { createLogger };
