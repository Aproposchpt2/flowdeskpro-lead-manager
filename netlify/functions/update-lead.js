'use strict';

const https = require('https');

const DEFAULT_TABLE = 'lead_manager_records';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Content-Type': 'application/json'
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(payload)
  };
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeEmail(value = '') {
  return safeString(value).toLowerCase();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getConfig() {
  const supabaseUrl = env('SUPABASE_URL');
  const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_KEY');
  const tableName = env('LEAD_MANAGER_TABLE', DEFAULT_TABLE);

  const resendKey = env('RESEND_API_KEY');
  const resendFrom = env('RESEND_FROM_EMAIL', 'FlowDesk Pro <notifications@aiflowdeskpro.com>');
  const resendTo = env('RESEND_TO_EMAIL') || env('CLIENT_NOTIFICATION_EMAIL');

  const siteUrl = env('LEAD_MANAGER_SITE_URL', '');
  const clientName = env('CLIENT_NAME', 'Client');
  const clientBrandName = env('CLIENT_BRAND_NAME', clientName);
  const tenantId = env('CLIENT_TENANT_ID', 'default');

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  return {
    supabaseUrl,
    supabaseKey,
    tableName,
    resendKey,
    resendFrom,
    resendTo,
    siteUrl,
    clientName,
    clientBrandName,
    tenantId
  };
}

function encodeQueryValue(value) {
  return encodeURIComponent(String(value ?? ''));
}

function supabaseRequest(method, path, body = null, extraHeaders = {}) {
  const config = getConfig();
  const bodyString = body ? JSON.stringify(body) : '';

  return new Promise((resolve, reject) => {
    const base = config.supabaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}/rest/v1/${path}`);

    const requestHeaders = {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    };

    if (!requestHeaders.Prefer && ['POST', 'PATCH', 'PUT'].includes(method)) {
      requestHeaders.Prefer = 'return=representation';
    }

    if (bodyString) requestHeaders['Content-Length'] = Buffer.byteLength(bodyString);

    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(new Error(`Supabase ${method} failed ${res.statusCode}: ${data}`));
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Supabase request timed out.')));

    if (bodyString) req.write(bodyString);
    req.end();
  });
}

function sendResendEmail({ to, subject, html, text }) {
  const config = getConfig();

  if (!config.resendKey) {
    return Promise.reject(new Error('RESEND_API_KEY is not configured.'));
  }

  if (!to) {
    return Promise.reject(new Error('No email recipient was provided.'));
  }

  const bodyString = JSON.stringify({
    from: config.resendFrom,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString)
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(new Error(`Resend failed ${res.statusCode}: ${data}`));
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Resend request timed out.')));

    req.write(bodyString);
    req.end();
  });
}

function splitName(fullName) {
  const cleaned = safeString(fullName);
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  };
}


function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(lowered)) return true;
    if (['false', 'no', '0', 'off'].includes(lowered)) return false;
  }
  if (value === null || value === undefined) return fallback;
  return Boolean(value);
}

function buildUpdatePayload(body) {
  const allowed = [
    'lead_status',
    'urgency',
    'service_needed',
    'category',
    'preferred_contact_method',
    'preferred_callback_time',
    'message',
    'details',
    'ai_summary',
    'next_action',
    'internal_notes',
    'assigned_to',
    'customer_status_message'
  ];

  const payload = { updated_at: nowIso() };

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      payload[field] = safeString(body[field]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'follow_up_needed')) {
    payload.follow_up_needed = normalizeBoolean(body.follow_up_needed, true);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'appointment_requested')) {
    payload.appointment_requested = normalizeBoolean(body.appointment_requested, false);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'appointment_status')) {
    payload.appointment_status = safeString(body.appointment_status);
  }

  if (
    Object.prototype.hasOwnProperty.call(body, 'customer_status_message') &&
    safeString(body.customer_status_message)
  ) {
    payload.last_customer_update_at = nowIso();
  }

  return payload;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (!['POST', 'PATCH'].includes(event.httpMethod)) {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const id = safeString(body.id || body.record_id);
  if (!id) return json(400, { ok: false, error: 'Lead record id is required.' });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error('update-lead config error:', error.message);
    return json(500, { ok: false, error: 'Lead Manager is not configured.' });
  }

  const tenantId = safeString(body.tenant_id || config.tenantId || 'default');
  const updatePayload = buildUpdatePayload(body);

  if (Object.keys(updatePayload).length <= 1) {
    return json(400, { ok: false, error: 'No update fields were provided.' });
  }

  try {
    const path = `${config.tableName}?id=eq.${encodeQueryValue(id)}&tenant_id=eq.${encodeQueryValue(tenantId)}`;
    const updated = await supabaseRequest('PATCH', path, updatePayload);
    const record = Array.isArray(updated) && updated.length ? updated[0] : null;

    if (!record) {
      return json(404, { ok: false, error: 'Lead record was not found for this tenant.' });
    }

    return json(200, {
      ok: true,
      message: 'Lead updated successfully.',
      record
    });
  } catch (error) {
    console.error('update-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to update lead right now.' });
  }
};
