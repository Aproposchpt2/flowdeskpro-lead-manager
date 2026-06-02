'use strict';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};

function buildCorsHeaders(requestOrigin) {
  const allowedOriginsEnv = process.env.FLOWDESK_ALLOWED_ORIGINS;

  let allowOrigin = null;

  if (allowedOriginsEnv) {
    const allowed = allowedOriginsEnv.split(',').map((o) => o.trim());
    if (requestOrigin && allowed.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    }
  }

  const headers = {
    ...DEFAULT_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

function handleOptions(requestOrigin) {
  return {
    statusCode: 204,
    headers: buildCorsHeaders(requestOrigin),
    body: '',
  };
}

module.exports = { buildCorsHeaders, handleOptions };
