'use strict';

/**
 * FlowDesk Pro Lead Manager — Universal External Intake Receiver
 * File: netlify/functions/submit-lead.js
 *
 * Purpose:
 * - Accept external lead/customer/product-intake submissions from approved origins
 * - Handle CORS preflight and return CORS headers on every response
 * - Insert records into public.lead_manager_records through Supabase REST
 * - Optionally send an internal Resend notification when configured
 *
 * Required Netlify environment variables:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY
 * - LEAD_ALLOWED_ORIGINS
 *
 * Optional Netlify environment variables:
 * - LEAD_MANAGER_TABLE
 * - RESEND_API_KEY
 * - RESEND_FROM_EMAIL
 * - RESEND_TO_EMAIL or CLIENT_NOTIFICATION_EMAIL
 * - LEAD_MANAGER_SITE_URL
 * - CLIENT_NAME
 * - CLIENT_BRAND_NAME
 * - CLIENT_TENANT_ID
 */

const https = require('https');

const DEFAULT_TABLE = 'lead_manager_records';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

const LEAD_MANAGER_TABLE = process.env.LEAD_MANAGER_TABLE || DEFAULT_TABLE;

function getHeader(event, name) {
  const headers = event.headers || {};
  const lowerName = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }

  return '';
}

function getOrigin(event) {
  return getHeader(event, 'origin') || '';
}

function getAllowedOrigins() {
  return (process.env.LEAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAllowedOrigin(event) {
  const origin = getOrigin(event);
  const allowedOrigins = getAllowedOrigins();

  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }

  if (!origin) {
    return '*';
  }

  return '';
}

function buildHeaders(event) {
  const allowedOrigin = getAllowedOrigin(event);

  return {
    'Access-Control-Allow-Origin': allowedOrigin || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}

function jsonResponse(event, statusCode, payload) {
  return {
    statusCode,
    headers: buildHeaders(event),
    body: JSON.stringify(payload)
  };
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeEmail(value) {
  return safeString(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function asBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;

  const text = safeString(value).toLowerCase();
  if (['true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', 'no', 'n', 'off'].includes(text)) return false;

  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonBody(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    const err = new Error('Invalid JSON body.');
    err.statusCode = 400;
    throw err;
  }
}

function cleanMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  try {
    return JSON.parse(JSON.stringify(input));
  } catch (_) {
    return {};
  }
}

function buildRecord(body, event) {
  const firstName = safeString(body.first_name || body.firstName);
  const lastName = safeString(body.last_name || body.lastName);
  const contactName = safeString(
    body.contact_name ||
    body.full_name ||
    body.name ||
    `${firstName} ${lastName}`.trim()
  );

  const email = normalizeEmail(body.email);
  const phone = safeString(body.phone || body.phone_number || body.phoneNumber);

  const company = safeString(
    body.company ||
    body.business_name_from_form ||
    body.organization ||
    ''
  );

  const sourceUrl = safeString(body.source_url || body.sourceUrl || getHeader(event, 'referer'));
  const metadata = {
    origin_site: 'ai4-product-purchasing.ai4businesses.org',
    lead_source_type: 'external_intake',
    payment_status: 'not_configured_yet',
    requires_sales_follow_up: true,
    ...cleanMetadata(body.metadata)
  };

  const selectedProduct = safeString(
    metadata.selected_product ||
    body.selected_product ||
    body.product ||
    body.service_needed
  );

  const selectedPlan = safeString(
    metadata.selected_plan ||
    metadata.purchase_plan_name ||
    body.selected_plan ||
    body.plan
  );

  if (selectedProduct) metadata.selected_product = selectedProduct;
  if (selectedPlan) metadata.selected_plan = selectedPlan;

  if (!metadata.origin_site && sourceUrl) {
    try {
      metadata.origin_site = new URL(sourceUrl).hostname;
    } catch (_) {}
  }

  return {
    created_at: nowIso(),
    updated_at: nowIso(),

    tenant_id: safeString(body.tenant_id || process.env.CLIENT_TENANT_ID, 'default'),
    client_name: safeString(body.client_name || process.env.CLIENT_NAME, 'Apropos Group LLC'),
    business_name: safeString(body.business_name || process.env.CLIENT_BRAND_NAME, 'AI4 Businesses'),

    contact_name: contactName,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    company,

    source: safeString(body.source, 'ai4_product_purchasing'),
    channel: safeString(body.channel, 'web'),
    source_page: safeString(body.source_page || body.sourcePage, 'signup-intake'),
    source_url: sourceUrl,

    lead_status: safeString(body.lead_status || body.leadStatus, 'New / Needs Review'),
    urgency: safeString(body.urgency, 'Normal'),
    service_needed: safeString(body.service_needed || body.serviceNeeded || selectedProduct || selectedPlan),
    category: safeString(body.category, 'Product Purchase / Signup Intake'),

    preferred_contact_method: safeString(body.preferred_contact_method || body.preferredContactMethod, 'Email or phone'),
    preferred_callback_time: safeString(body.preferred_callback_time || body.preferredCallbackTime, ''),

    message: safeString(body.message || body.details),
    details: safeString(
      body.details ||
      body.message ||
      `Product Purchasing intake received. Product: ${selectedProduct || 'Not provided'}; Plan: ${selectedPlan || 'Not provided'}.`
    ),

    ai_summary: safeString(body.ai_summary || body.aiSummary, ''),
    next_action: safeString(body.next_action || body.nextAction, 'Review product/customer intake and follow up with setup next steps.'),
    internal_notes: safeString(body.internal_notes || body.internalNotes, ''),

    follow_up_needed: asBoolean(body.follow_up_needed, true),
    appointment_requested: asBoolean(body.appointment_requested, false),
    sms_consent: asBoolean(body.sms_consent, false),

    assigned_to: safeString(body.assigned_to || body.assignedTo, ''),
    customer_status_message: safeString(body.customer_status_message || body.customerStatusMessage, ''),
    last_customer_update_at: null,

    metadata
  };
}

function validateRecord(record) {
  const missing = [];

  if (!record.contact_name) missing.push('contact_name');
  if (!record.email) missing.push('email');
  if (!record.service_needed) missing.push('service_needed');

  if (record.email && !isValidEmail(record.email)) {
    return 'Please enter a valid email address.';
  }

  if (missing.length) {
    return `Missing required field(s): ${missing.join(', ')}.`;
  }

  return '';
}

function requestJson(method, urlString, headers, body) {
  const bodyString = body ? JSON.stringify(body) : '';

  return new Promise((resolve, reject) => {
    const url = new URL(urlString);

    const requestHeaders = {
      ...headers
    };

    if (bodyString) {
      requestHeaders['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders
      },
      (res) => {
        let responseText = '';

        res.on('data', (chunk) => {
          responseText += chunk;
        });

        res.on('end', () => {
          let parsed = null;
          try {
            parsed = responseText ? JSON.parse(responseText) : null;
          } catch (_) {
            parsed = responseText;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data: parsed, raw: responseText });
            return;
          }

          const error = new Error(responseText || `HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.data = parsed;
          reject(error);
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out.'));
    });

    if (bodyString) req.write(bodyString);
    req.end();
  });
}

async function insertLeadRecord(record) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const tablePath = encodeURIComponent(LEAD_MANAGER_TABLE);
  const url = `${baseUrl}/rest/v1/${tablePath}`;

  const response = await requestJson(
    'POST',
    url,
    {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    record
  );

  const inserted = Array.isArray(response.data) ? response.data[0] : response.data;
  return inserted || {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildDashboardUrl() {
  const siteUrl = safeString(process.env.LEAD_MANAGER_SITE_URL, 'https://lead-management.aiflowdeskpro.com');
  return `${siteUrl.replace(/\/$/, '')}/dashboard`;
}

function buildInternalEmail(record, inserted) {
  const metadata = record.metadata || {};
  const selectedProduct = safeString(metadata.selected_product || record.service_needed, 'Not provided');
  const selectedPlan = safeString(metadata.selected_plan || metadata.purchase_plan_name, 'Not provided');
  const paymentStatus = safeString(metadata.payment_status, 'not_configured_yet');
  const originSite = safeString(metadata.origin_site, 'Not provided');
  const dashboardUrl = buildDashboardUrl();

  const html = `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:680px;margin:0 auto;">
      <div style="color:#73E6FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">FlowDesk Pro Lead Manager</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">New Product Purchasing Intake Received</h2>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">A new record was submitted from the AI4 Product Purchasing site.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <tr><td style="padding:8px;color:#90A3BC;">Contact</td><td style="padding:8px;color:#ffffff;font-weight:700;">${escapeHtml(record.contact_name)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Email</td><td style="padding:8px;color:#73E6FF;">${escapeHtml(record.email)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Phone</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.phone || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Business</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.company || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Product</td><td style="padding:8px;color:#ffffff;">${escapeHtml(selectedProduct)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Plan</td><td style="padding:8px;color:#ffffff;">${escapeHtml(selectedPlan)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Origin Site</td><td style="padding:8px;color:#ffffff;">${escapeHtml(originSite)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Payment Status</td><td style="padding:8px;color:#ffffff;">${escapeHtml(paymentStatus)}</td></tr>
      </table>
      <div style="background:#0d1f34;border:1px solid rgba(115,230,255,.28);border-radius:14px;padding:16px;margin:18px 0;">
        <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Message</div>
        <div style="line-height:1.7;color:#c9d6e5;">${escapeHtml(record.message || 'No message provided.')}</div>
      </div>
      <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:linear-gradient(135deg,#F5F8FF,#73E6FF,#4A7FFF);color:#03101f;font-weight:900;text-decoration:none;border-radius:10px;padding:13px 20px;">Open Lead Manager Dashboard</a>
      <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Record ID: ${escapeHtml(inserted?.id || '')}</p>
    </div>
  `;

  const text = [
    'FlowDesk Pro Lead Manager — New Product Purchasing Intake Received',
    '',
    `Contact: ${record.contact_name}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Business: ${record.company || 'Not provided'}`,
    `Product: ${selectedProduct}`,
    `Plan: ${selectedPlan}`,
    `Origin Site: ${originSite}`,
    `Payment Status: ${paymentStatus}`,
    '',
    `Message: ${record.message || 'No message provided.'}`,
    `Dashboard: ${dashboardUrl}`,
    `Record ID: ${inserted?.id || ''}`
  ].join('\n');

  return { html, text };
}

async function sendInternalNotification(record, inserted) {
  const resendKey = process.env.RESEND_API_KEY || '';
  const toEmail = process.env.RESEND_TO_EMAIL || process.env.CLIENT_NOTIFICATION_EMAIL || '';
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk Pro <notifications@aiflowdeskpro.com>';

  if (!resendKey || !toEmail) {
    return { skipped: true };
  }

  const email = buildInternalEmail(record, inserted);
  const subject = `New Product Intake — ${record.contact_name || record.email}`;

  try {
    const response = await requestJson(
      'POST',
      'https://api.resend.com/emails',
      {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      {
        from: fromEmail,
        to: [toEmail],
        subject,
        html: email.html,
        text: email.text
      }
    );

    return { sent: true, response: response.data };
  } catch (error) {
    console.error('[submit-lead] Resend notification failed:', error.message);
    return { sent: false, error: error.message };
  }
}

exports.handler = async (event) => {
  const method = event.httpMethod || '';

  if (method === 'OPTIONS') {
    return jsonResponse(event, 204, {});
  }

  if (method !== 'POST') {
    return jsonResponse(event, 405, {
      ok: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  const allowedOrigin = getAllowedOrigin(event);
  if (!allowedOrigin) {
    console.warn('[submit-lead] blocked origin:', getOrigin(event));
    return jsonResponse(event, 403, {
      ok: false,
      error: 'Origin is not allowed.'
    });
  }

  try {
    const body = parseJsonBody(event);
    const record = buildRecord(body, event);
    const validationError = validateRecord(record);

    if (validationError) {
      return jsonResponse(event, 400, {
        ok: false,
        error: validationError
      });
    }

    const inserted = await insertLeadRecord(record);
    const notification = await sendInternalNotification(record, inserted);

    return jsonResponse(event, 200, {
      ok: true,
      message: 'Lead received.',
      id: inserted.id || null,
      record: inserted,
      notification
    });
  } catch (error) {
    console.error('[submit-lead] error:', {
      message: error.message,
      statusCode: error.statusCode || 500,
      data: error.data || null
    });

    return jsonResponse(event, error.statusCode || 500, {
      ok: false,
      error: 'Unable to submit lead right now.',
      detail: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
