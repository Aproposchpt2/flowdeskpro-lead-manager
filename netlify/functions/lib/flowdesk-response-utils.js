'use strict';

/**
 * FlowDesk Pro Lead Manager — JSON response helpers for Netlify Functions.
 */

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function error(statusCode, code, message, extraHeaders = {}) {
  return json(statusCode, { error: { code, message } }, extraHeaders);
}

function parseJsonBody(event) {
  if (!event || !event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports = { json, error, parseJsonBody };
