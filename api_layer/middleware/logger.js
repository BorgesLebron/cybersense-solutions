'use strict';

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      actor_id: req.agent?.name || req.user?.id || 'anonymous',
      actor_type: req.agent ? 'agent' : req.user ? 'user' : 'anonymous',
      status: res.statusCode,
      latency_ms: Date.now() - start,
    };
    console.log(JSON.stringify(entry));
  });
  next();
}

function errorHandler(err, req, res, next) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    error: err.message,
    stack: err.stack
  }));

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }

  const status = err.status || err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = status < 500 ? err.message : 'An unexpected error occurred';
  res.status(status).json({ error: { code, message } });
}

module.exports = { requestLogger, errorHandler };
