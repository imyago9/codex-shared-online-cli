const { start } = require('./scripts/start');

start().catch((error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
