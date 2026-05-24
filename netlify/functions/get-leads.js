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


function clampLimit(rawLimit) {
  const parsed = parseInt(rawLimit || '100', 10);
  if (Number.isNaN(parsed)) return 100;
  return Math.max(1, Math.min(parsed, 250));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error('get-leads config error:', error.message);
    return json(500, { ok: false, error: 'Lead Manager is not configured.' });
  }

  try {
    const params = event.queryStringParameters || {};
    const limit = clampLimit(params.limit);
    const tenantId = safeString(params.tenant_id || config.tenantId || 'default');
    const table = config.tableName;
    const queryParts = [
      'select=*',
      `tenant_id=eq.${encodeQueryValue(tenantId)}`,
      'order=created_at.desc',
      `limit=${limit}`
    ];

    if (params.status) queryParts.push(`lead_status=ilike.${encodeQueryValue(`*${params.status}*`)}`);
    if (params.urgency) queryParts.push(`urgency=ilike.${encodeQueryValue(`*${params.urgency}*`)}`);
    if (params.source) queryParts.push(`source=ilike.${encodeQueryValue(`*${params.source}*`)}`);

    const records = await supabaseRequest('GET', `${table}?${queryParts.join('&')}`);
    return json(200, {
      ok: true,
      records: Array.isArray(records) ? records : [],
      count: Array.isArray(records) ? records.length : 0,
      tenant_id: tenantId
    });
  } catch (error) {
    console.error('get-leads error:', error.message);
    return json(500, { ok: false, error: 'Unable to load lead records.' });
  }
};
