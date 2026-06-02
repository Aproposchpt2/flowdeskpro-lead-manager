'use strict';

function json(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  };
}

function error(statusCode, code, message, headers = {}) {
  return json(statusCode, { ok: false, error: { code, message } }, headers);
}

function parseJsonBody(event) {
  const body = event.body;
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

module.exports = { json, error, parseJsonBody };
