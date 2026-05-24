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


async function getLeadById(config, id, tenantId) {
  const query = [
    'select=*',
    `id=eq.${encodeQueryValue(id)}`,
    `tenant_id=eq.${encodeQueryValue(tenantId)}`,
    'limit=1'
  ].join('&');

  const records = await supabaseRequest('GET', `${config.tableName}?${query}`);
  return Array.isArray(records) && records.length ? records[0] : null;
}

function buildCustomerUpdateEmail(record, message) {
  const config = getConfig();
  const firstName = record.first_name || (record.contact_name ? record.contact_name.split(/\s+/)[0] : '');
  const brand = config.clientBrandName || record.business_name || 'Our Team';

  const html = `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:640px;margin:0 auto;">
      <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">${escapeHtml(brand)}</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">Update on your request</h2>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
      <div style="background:#0d1f34;border:1px solid rgba(91,211,255,.28);border-radius:14px;padding:16px;margin:18px 0;">
        <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Message</div>
        <div style="line-height:1.7;color:#f5f8ff;white-space:pre-wrap;">${escapeHtml(message)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <tr><td style="padding:8px;color:#90A3BC;width:150px;">Business</td><td style="padding:8px;color:#ffffff;font-weight:700;">${escapeHtml(record.business_name || brand)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Status</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.lead_status || 'In Review')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Request</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.service_needed || 'General inquiry')}</td></tr>
      </table>
      <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Powered by FlowDesk Pro Lead Manager.</p>
    </div>
  `;

  const text = [
    `Update from ${brand}`,
    '',
    firstName ? `Hi ${firstName},` : 'Hi,',
    '',
    message,
    '',
    `Status: ${record.lead_status || 'In Review'}`,
    `Request: ${record.service_needed || 'General inquiry'}`,
    '',
    'Powered by FlowDesk Pro Lead Manager.'
  ].join('\n');

  return {
    to: record.email,
    subject: `Update on your request — ${brand}`,
    html,
    text
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const id = safeString(body.id || body.record_id);
  if (!id) return json(400, { ok: false, error: 'Lead record id is required.' });

  const message = safeString(body.customer_status_message || body.message);
  if (!message) return json(400, { ok: false, error: 'Customer status message is required.' });

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error('email-lead config error:', error.message);
    return json(500, { ok: false, error: 'Lead Manager is not configured.' });
  }

  if (!config.resendKey) {
    return json(500, { ok: false, error: 'Email service is not configured.' });
  }

  const tenantId = safeString(body.tenant_id || config.tenantId || 'default');

  try {
    const record = await getLeadById(config, id, tenantId);

    if (!record) {
      return json(404, { ok: false, error: 'Lead record was not found for this tenant.' });
    }

    if (!isValidEmail(record.email)) {
      return json(400, { ok: false, error: 'Lead record does not contain a valid email address.' });
    }

    const emailResult = await sendResendEmail(buildCustomerUpdateEmail(record, message));

    const updatePayload = {
      customer_status_message: message,
      last_customer_update_at: nowIso(),
      updated_at: nowIso()
    };

    if (safeString(body.lead_status)) {
      updatePayload.lead_status = safeString(body.lead_status);
    }

    const updated = await supabaseRequest(
      'PATCH',
      `${config.tableName}?id=eq.${encodeQueryValue(id)}&tenant_id=eq.${encodeQueryValue(tenantId)}`,
      updatePayload
    );

    const updatedRecord = Array.isArray(updated) && updated.length ? updated[0] : null;

    return json(200, {
      ok: true,
      message: 'Customer update email sent.',
      email: emailResult,
      record: updatedRecord
    });
  } catch (error) {
    console.error('email-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to email lead right now.' });
  }
};
