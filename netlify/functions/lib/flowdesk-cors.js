'use strict';

/**
 * FlowDesk Pro Lead Manager — shared CORS helpers for Netlify Functions.
 * Used by voice-agent endpoints (lookup-caller, log-call) that are called
 * cross-origin by ElevenLabs and the dashboard frontend.
 */

const ALLOWED_METHODS = 'GET, POST, PATCH, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Agent-Secret';

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
  };
}

function handleOptions(origin) {
  return {
    statusCode: 204,
    headers: buildCorsHeaders(origin),
    body: '',
  };
}

module.exports = { buildCorsHeaders, handleOptions };
