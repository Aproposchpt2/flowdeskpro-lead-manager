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


function buildLeadRecord(body) {
  const fullName = safeString(body.contact_name || body.full_name || body.name);
  const nameParts = splitName(fullName);
  const firstName = safeString(body.first_name) || nameParts.firstName;
  const lastName = safeString(body.last_name) || nameParts.lastName;
  const email = normalizeEmail(body.email);
  const phone = safeString(body.phone);

  const businessName = safeString(
    body.business_name ||
    body.company ||
    body.organization ||
    env('CLIENT_BRAND_NAME', 'Client Business')
  );

  return {
    created_at: nowIso(),
    updated_at: nowIso(),
    tenant_id: safeString(body.tenant_id || env('CLIENT_TENANT_ID', 'default')),
    client_name: safeString(body.client_name || env('CLIENT_NAME', businessName)),
    business_name: businessName,
    contact_name: fullName,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    company: safeString(body.company || businessName),
    source: safeString(body.source || 'web_intake'),
    source_page: safeString(body.source_page || body.source_url || ''),
    lead_status: safeString(body.lead_status || 'New / Needs Review'),
    urgency: safeString(body.urgency || 'Normal'),
    service_needed: safeString(body.service_needed || body.request_type || ''),
    category: safeString(body.category || ''),
    preferred_contact_method: safeString(body.preferred_contact_method || 'Email or phone'),
    preferred_callback_time: safeString(body.preferred_callback_time || ''),
    message: safeString(body.message || body.details || ''),
    details: safeString(body.details || body.message || ''),
    ai_summary: safeString(body.ai_summary || ''),
    next_action: safeString(body.next_action || 'Review the new lead and decide the next follow-up step.'),
    internal_notes: safeString(body.internal_notes || ''),
    follow_up_needed: body.follow_up_needed !== undefined ? Boolean(body.follow_up_needed) : true,
    assigned_to: safeString(body.assigned_to || ''),
    customer_status_message: safeString(body.customer_status_message || ''),
    last_customer_update_at: null,
    metadata: typeof body.metadata === 'object' && body.metadata && !Array.isArray(body.metadata)
      ? body.metadata
      : {}
  };
}

function buildInternalNotification(record, insertedRecord) {
  const config = getConfig();
  const dashboardUrl = config.siteUrl ? `${config.siteUrl.replace(/\/$/, '')}/dashboard` : '';
  const html = `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:660px;margin:0 auto;">
      <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">FlowDesk Pro Lead Manager</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">New Lead Received</h2>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">A new lead has entered the dashboard.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <tr><td style="padding:8px;color:#90A3BC;width:170px;">Business</td><td style="padding:8px;color:#ffffff;font-weight:700;">${escapeHtml(record.business_name)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Contact</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.contact_name)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Email</td><td style="padding:8px;color:#5BD3FF;">${escapeHtml(record.email)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Phone</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.phone || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Service Needed</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.service_needed || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Urgency</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.urgency)}</td></tr>
      </table>
      <div style="background:#0d1f34;border:1px solid rgba(91,211,255,.28);border-radius:14px;padding:16px;margin:18px 0;">
        <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Message</div>
        <div style="line-height:1.7;color:#c9d6e5;">${escapeHtml(record.message || 'No message provided.')}</div>
      </div>
      ${dashboardUrl ? `<a href="${dashboardUrl}" style="display:inline-block;background:linear-gradient(135deg,#F5F8FF,#5BD3FF,#1EA7FF);color:#03101f;font-weight:900;text-decoration:none;border-radius:10px;padding:13px 20px;">Open Dashboard</a>` : ''}
      <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Record ID: ${escapeHtml(insertedRecord?.id || '')}</p>
    </div>
  `;

  const text = [
    'FlowDesk Pro Lead Manager — New Lead Received',
    '',
    `Business: ${record.business_name}`,
    `Contact: ${record.contact_name}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Service Needed: ${record.service_needed || 'Not provided'}`,
    `Urgency: ${record.urgency}`,
    '',
    `Message: ${record.message || 'No message provided.'}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : '',
    insertedRecord?.id ? `Record ID: ${insertedRecord.id}` : ''
  ].filter(Boolean).join('\n');

  return {
    to: config.resendTo,
    subject: `New Lead — ${record.business_name} — ${record.contact_name || record.email}`,
    html,
    text
  };
}

function buildCustomerConfirmation(record) {
  const config = getConfig();
  const firstName = record.first_name || (record.contact_name ? record.contact_name.split(/\s+/)[0] : '');

  const html = `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:620px;margin:0 auto;">
      <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">${escapeHtml(config.clientBrandName)}</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">We received your request</h2>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">Thank you for contacting ${escapeHtml(config.clientBrandName)}. Your request has been received and will be reviewed for follow-up.</p>
      <div style="background:#0d1f34;border:1px solid rgba(91,211,255,.28);border-radius:14px;padding:16px;margin:18px 0;">
        <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Request Summary</div>
        <div style="line-height:1.7;color:#c9d6e5;">${escapeHtml(record.service_needed || record.message || 'General inquiry')}</div>
      </div>
      <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Powered by FlowDesk Pro Lead Manager.</p>
    </div>
  `;

  const text = [
    'We received your request.',
    '',
    `Thank you for contacting ${config.clientBrandName}. Your request has been received and will be reviewed for follow-up.`,
    '',
    `Request summary: ${record.service_needed || record.message || 'General inquiry'}`,
    '',
    'Powered by FlowDesk Pro Lead Manager.'
  ].join('\n');

  return {
    to: record.email,
    subject: `Request received — ${config.clientBrandName}`,
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

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error('submit-lead config error:', error.message);
    return json(500, { ok: false, error: 'Lead Manager is not configured.' });
  }

  const record = buildLeadRecord(body);

  if (!record.contact_name) return json(400, { ok: false, error: 'Contact name is required.' });
  if (!isValidEmail(record.email)) return json(400, { ok: false, error: 'A valid email address is required.' });

  try {
    const inserted = await supabaseRequest('POST', config.tableName, record);
    const insertedRecord = Array.isArray(inserted) && inserted.length ? inserted[0] : null;

    let internalEmailSent = false;
    let customerEmailSent = false;

    try {
      if (config.resendTo && config.resendKey) {
        await sendResendEmail(buildInternalNotification(record, insertedRecord));
        internalEmailSent = true;
      }
    } catch (error) {
      console.error('submit-lead internal email error:', error.message);
    }

    try {
      if (record.email && config.resendKey) {
        await sendResendEmail(buildCustomerConfirmation(record));
        customerEmailSent = true;
      }
    } catch (error) {
      console.error('submit-lead customer email error:', error.message);
    }

    return json(200, {
      ok: true,
      message: 'Lead submitted successfully.',
      record_id: insertedRecord?.id || null,
      record: insertedRecord,
      internal_email_sent: internalEmailSent,
      customer_email_sent: customerEmailSent
    });
  } catch (error) {
    console.error('submit-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to submit lead right now.' });
  }
};
