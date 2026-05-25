'use strict';

/**
 * FlowDesk Pro Lead Manager — Universal External Intake Receiver
 * File: netlify/functions/submit-lead.js
 *
 * Receives external lead/customer/product-intake submissions from approved
 * origins such as AI4 Product Purchasing and writes them to Supabase
 * public.lead_manager_records using the Supabase REST API.
 *
 * Secrets must live in Netlify Environment Variables only.
 */

const https = require('https');

const DEFAULT_TABLE = 'lead_manager_records';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ai4-product-purchasing.ai4businesses.org',
  'https://lead-management.aiflowdeskpro.com',
  'https://go-online-now.ai4websitedesign.com'
];

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

const TABLE_NAME = process.env.LEAD_MANAGER_TABLE || DEFAULT_TABLE;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ||
  'FlowDesk Pro Lead Manager <notifications@aiflowdeskpro.com>';
const RESEND_TO_EMAIL =
  process.env.RESEND_TO_EMAIL ||
  process.env.CLIENT_NOTIFICATION_EMAIL ||
  '';

function normalizeOrigin(value = '') {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch (_) {
    return trimmed;
  }
}

function getAllowedOrigins() {
  const configured = String(process.env.LEAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  return new Set(origins.map(normalizeOrigin));
}

function getRequestOrigin(event) {
  const headers = event.headers || {};
  return normalizeOrigin(headers.origin || headers.Origin || '');
}

function isOriginAllowed(origin) {
  if (!origin) return true; // Allows server-side tests, Netlify UI calls, and same-origin requests.
  return getAllowedOrigins().has(normalizeOrigin(origin));
}

function corsHeaders(origin) {
  const allowed = isOriginAllowed(origin);
  const allowOrigin = origin
    ? (allowed ? normalizeOrigin(origin) : 'null')
    : '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'OPTIONS, POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}

function json(statusCode, payload, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(payload)
  };
}

function empty(statusCode, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: ''
  };
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeEmail(value = '') {
  return safeString(value).toLowerCase();
}

function booleanValue(value, fallback = false) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonBody(event) {
  if (!event.body) return {};

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object.');
    }
    return parsed;
  } catch (error) {
    const err = new Error(`Invalid JSON body: ${error.message}`);
    err.statusCode = 400;
    throw err;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function mergeMetadata(body, derived) {
  const incoming =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  return {
    ...incoming,
    origin_site: safeString(incoming.origin_site || derived.originSite),
    lead_source_type: safeString(incoming.lead_source_type || derived.leadSourceType),
    selected_product: safeString(incoming.selected_product || derived.selectedProduct),
    selected_plan: safeString(incoming.selected_plan || derived.selectedPlan),
    purchase_plan_name: safeString(incoming.purchase_plan_name || derived.purchasePlanName),
    payment_site: booleanValue(incoming.payment_site, true),
    payment_processed_by: safeString(
      incoming.payment_processed_by || derived.paymentProcessedBy || derived.originSite
    ),
    payment_status: safeString(incoming.payment_status || derived.paymentStatus),
    member_signup_form: booleanValue(incoming.member_signup_form, derived.memberSignupForm),
    requires_sales_follow_up: booleanValue(incoming.requires_sales_follow_up, true),
    received_by: 'FlowDesk Pro Lead Manager',
    received_at: nowIso()
  };
}

function buildLeadRecord(body) {
  const firstName = safeString(body.first_name || body.firstName);
  const lastName = safeString(body.last_name || body.lastName);
  const contactName = safeString(
    body.contact_name ||
    body.full_name ||
    body.name ||
    `${firstName} ${lastName}`.trim() ||
    body.company ||
    body.business_name ||
    body.phone ||
    'Unknown Contact'
  );

  const email =
    normalizeEmail(body.email) ||
    `no-email-${Date.now()}@lead-manager.local`;

  const phone = safeString(body.phone || body.phone_number || body.phoneNumber);
  const company = safeString(body.company || body.business_name || body.organization);

  const incomingMetadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  const selectedProduct = safeString(
    body.selected_product ||
    incomingMetadata.selected_product ||
    body.product ||
    body.service_needed
  );

  const selectedPlan = safeString(
    body.selected_plan ||
    incomingMetadata.selected_plan ||
    incomingMetadata.purchase_plan_name ||
    body.plan ||
    body.purchase_plan_name
  );

  const purchasePlanName = safeString(
    body.purchase_plan_name ||
    incomingMetadata.purchase_plan_name ||
    selectedPlan ||
    selectedProduct
  );

  const sourceUrl = safeString(body.source_url || body.sourceUrl);
  const originSite = safeString(
    incomingMetadata.origin_site ||
    body.origin_site ||
    (sourceUrl ? normalizeOrigin(sourceUrl).replace(/^https?:\/\//, '') : '') ||
    'ai4-product-purchasing.ai4businesses.org'
  );

  const leadSourceType = safeString(
    incomingMetadata.lead_source_type ||
    body.lead_source_type ||
    'external_intake'
  );

  const paymentStatus = safeString(
    incomingMetadata.payment_status ||
    body.payment_status ||
    'not_configured_yet'
  );

  const metadata = mergeMetadata(body, {
    originSite,
    leadSourceType,
    selectedProduct,
    selectedPlan,
    purchasePlanName,
    paymentProcessedBy: safeString(incomingMetadata.payment_processed_by || body.payment_processed_by),
    paymentStatus,
    memberSignupForm: booleanValue(incomingMetadata.member_signup_form, true)
  });

  const serviceNeeded = safeString(
    body.service_needed ||
    selectedProduct ||
    selectedPlan ||
    purchasePlanName ||
    'Product / service intake'
  );

  const category = safeString(
    body.category ||
    (leadSourceType.includes('flowdesk')
      ? 'FlowDesk Pro Product Purchase Intake'
      : leadSourceType.includes('website')
        ? 'Website Design Studio Purchase Plan Intake'
        : 'External Product Intake')
  );

  return {
    created_at: nowIso(),
    updated_at: nowIso(),

    tenant_id: safeString(body.tenant_id || process.env.CLIENT_TENANT_ID || 'default'),
    client_name: safeString(body.client_name || process.env.CLIENT_NAME || 'Apropos Group LLC'),
    business_name: safeString(body.business_name || process.env.CLIENT_BRAND_NAME || 'AI4 Businesses'),

    contact_name: contactName,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    company,

    source: safeString(body.source || 'ai4_product_purchasing'),
    channel: safeString(body.channel || 'web'),
    source_page: safeString(body.source_page || 'product-purchasing-intake'),
    source_url: sourceUrl,

    lead_status: safeString(body.lead_status || 'New / Needs Review'),
    urgency: safeString(body.urgency || 'Normal'),
    service_needed: serviceNeeded,
    category,

    preferred_contact_method: safeString(body.preferred_contact_method || 'Email or phone'),
    preferred_callback_time: safeString(body.preferred_callback_time || ''),

    message: safeString(body.message || body.details || ''),
    details: safeString(
      body.details ||
      body.message ||
      `External intake received from ${originSite}.`
    ),
    ai_summary: safeString(body.ai_summary || ''),
    next_action: safeString(
      body.next_action ||
      'Review product/customer intake and follow up with setup or onboarding details.'
    ),

    internal_notes: safeString(body.internal_notes || ''),
    follow_up_needed: booleanValue(body.follow_up_needed, true),
    assigned_to: safeString(body.assigned_to || ''),

    customer_status_message: safeString(body.customer_status_message || ''),
    last_customer_update_at: null,

    appointment_requested: booleanValue(body.appointment_requested, false),
    appointment_status: safeString(body.appointment_status || ''),
    sms_consent: booleanValue(body.sms_consent, false),

    selected_product: selectedProduct,
    selected_plan: selectedPlan,
    product_type: safeString(
      body.product_type ||
      (leadSourceType.includes('flowdesk') ? 'FlowDesk Pro' : leadSourceType.includes('website') ? 'Website Design Studio' : '')
    ),
    cta_label: safeString(body.cta_label || incomingMetadata.cta_label || ''),
    campaign_source: safeString(body.campaign_source || ''),
    payment_status: paymentStatus,

    metadata
  };
}

function createSchemaFallbackRecord(record, reason) {
  const fallback = {
    created_at: record.created_at,
    updated_at: record.updated_at,

    tenant_id: record.tenant_id,
    client_name: record.client_name,
    business_name: record.business_name,

    contact_name: record.contact_name,
    first_name: record.first_name,
    last_name: record.last_name,
    email: record.email,
    phone: record.phone,
    company: record.company,

    source: record.source,
    source_page: record.source_page,
    lead_status: record.lead_status,
    urgency: record.urgency,
    service_needed: record.service_needed,
    category: record.category,

    preferred_contact_method: record.preferred_contact_method,
    preferred_callback_time: record.preferred_callback_time,

    message: record.message,
    details: record.details,
    ai_summary: record.ai_summary,
    next_action: record.next_action,

    internal_notes: record.internal_notes,
    follow_up_needed: record.follow_up_needed,
    assigned_to: record.assigned_to,

    customer_status_message: record.customer_status_message,
    last_customer_update_at: record.last_customer_update_at,

    appointment_requested: record.appointment_requested,
    appointment_status: record.appointment_status,

    metadata: {
      ...(record.metadata || {}),
      channel: record.channel,
      source_url: record.source_url,
      selected_product: record.selected_product || record.metadata?.selected_product || '',
      selected_plan: record.selected_plan || record.metadata?.selected_plan || '',
      product_type: record.product_type,
      cta_label: record.cta_label,
      campaign_source: record.campaign_source,
      sms_consent: record.sms_consent,
      payment_status: record.payment_status || record.metadata?.payment_status || '',
      schema_fallback_used: true,
      schema_fallback_reason: String(reason || '').slice(0, 500)
    }
  };

  Object.keys(fallback).forEach((key) => {
    if (fallback[key] === undefined) delete fallback[key];
  });

  return fallback;
}

class HttpError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function supabaseRequest(method, path, body) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return Promise.reject(
      new Error('Supabase environment variables are not configured.')
    );
  }

  const bodyString = body ? JSON.stringify(body) : '';
  const base = SUPABASE_URL.replace(/\/+$/, '');
  const url = new URL(`${base}/rest/v1/${path}`);

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  if (bodyString) {
    headers['Content-Length'] = Buffer.byteLength(bodyString);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers
      },
      (res) => {
        let response = '';

        res.on('data', (chunk) => {
          response += chunk;
        });

        res.on('end', () => {
          let parsed = response;
          try {
            parsed = response ? JSON.parse(response) : null;
          } catch (_) {
            parsed = response;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(
            new HttpError(
              `Supabase ${method} ${path} failed with ${res.statusCode}`,
              res.statusCode,
              parsed
            )
          );
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Supabase request timed out.'));
    });

    if (bodyString) req.write(bodyString);
    req.end();
  });
}

async function insertLeadRecord(record) {
  const path = `${encodeURIComponent(TABLE_NAME)}?select=*`;

  try {
    const inserted = await supabaseRequest('POST', path, record);
    return {
      record: Array.isArray(inserted) ? inserted[0] : inserted,
      schemaFallbackUsed: false
    };
  } catch (error) {
    const serialized = JSON.stringify(error.responseBody || error.message || '');
    const looksLikeSchemaCacheIssue =
      error.statusCode === 400 &&
      /schema cache|could not find|column|PGRST204|PGRST/i.test(serialized);

    if (!looksLikeSchemaCacheIssue) {
      throw error;
    }

    console.warn('[submit-lead] Extended insert failed; retrying with schema fallback:', serialized);

    const fallbackRecord = createSchemaFallbackRecord(record, serialized);
    const inserted = await supabaseRequest('POST', path, fallbackRecord);

    return {
      record: Array.isArray(inserted) ? inserted[0] : inserted,
      schemaFallbackUsed: true
    };
  }
}

function sendResendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY || !to) {
    return Promise.resolve({ skipped: true, reason: 'Resend is not configured.' });
  }

  const bodyString = JSON.stringify({
    from: RESEND_FROM_EMAIL,
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
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString)
        }
      },
      (res) => {
        let response = '';

        res.on('data', (chunk) => {
          response += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(response);
            return;
          }

          reject(new Error(`Resend failed with ${res.statusCode}: ${response}`));
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Resend request timed out.'));
    });

    req.write(bodyString);
    req.end();
  });
}

function buildInternalNotification(record, insertedRecord) {
  const dashboardUrl = process.env.LEAD_MANAGER_SITE_URL
    ? `${process.env.LEAD_MANAGER_SITE_URL.replace(/\/+$/, '')}/dashboard`
    : 'https://lead-management.aiflowdeskpro.com/dashboard';

  const product = record.metadata?.selected_product || record.selected_product || record.service_needed || 'Not provided';
  const plan = record.metadata?.selected_plan || record.selected_plan || record.metadata?.purchase_plan_name || 'Not provided';
  const paymentStatus = record.metadata?.payment_status || record.payment_status || 'Not provided';
  const originSite = record.metadata?.origin_site || 'Unknown';

  const html = `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:680px;margin:0 auto;">
      <div style="color:#73E6FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">FlowDesk Pro Lead Manager</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">New Product Purchasing Intake Received</h2>
      <p style="line-height:1.7;color:#c9d6e5;margin:0 0 16px;">A new customer/product intake record has entered the Lead Manager.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <tr><td style="padding:8px;color:#90A3BC;">Contact</td><td style="padding:8px;color:#ffffff;font-weight:700;">${escapeHtml(record.contact_name)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Email</td><td style="padding:8px;color:#73E6FF;">${escapeHtml(record.email)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Phone</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.phone || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Business</td><td style="padding:8px;color:#ffffff;">${escapeHtml(record.company || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Product</td><td style="padding:8px;color:#ffffff;">${escapeHtml(product)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Plan</td><td style="padding:8px;color:#ffffff;">${escapeHtml(plan)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Payment Status</td><td style="padding:8px;color:#ffffff;">${escapeHtml(paymentStatus)}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Source Site</td><td style="padding:8px;color:#ffffff;">${escapeHtml(originSite)}</td></tr>
      </table>
      <div style="background:#0d1f34;border:1px solid rgba(115,230,255,.28);border-radius:14px;padding:16px;margin:18px 0;">
        <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Message</div>
        <div style="line-height:1.7;color:#c9d6e5;">${escapeHtml(record.message || record.details || 'No message provided.')}</div>
      </div>
      <a href="${dashboardUrl}" style="display:inline-block;background:linear-gradient(135deg,#F5F8FF,#73E6FF,#4A7FFF);color:#03101f;font-weight:900;text-decoration:none;border-radius:10px;padding:13px 20px;">Open Lead Dashboard</a>
      <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Record ID: ${escapeHtml(insertedRecord?.id || '')}</p>
    </div>
  `;

  const text = [
    'FlowDesk Pro Lead Manager — New Product Purchasing Intake',
    '',
    `Contact: ${record.contact_name}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Business: ${record.company || 'Not provided'}`,
    `Product: ${product}`,
    `Plan: ${plan}`,
    `Payment Status: ${paymentStatus}`,
    `Source Site: ${originSite}`,
    '',
    `Message: ${record.message || record.details || 'No message provided.'}`,
    `Dashboard: ${dashboardUrl}`
  ].join('\n');

  return {
    to: RESEND_TO_EMAIL,
    subject: `New Product Intake — ${record.contact_name} — ${product}`,
    html,
    text
  };
}

exports.handler = async (event) => {
  const origin = getRequestOrigin(event);

  if (event.httpMethod === 'OPTIONS') {
    return empty(204, origin);
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed. Use POST.' }, origin);
  }

  if (!isOriginAllowed(origin)) {
    return json(
      403,
      {
        ok: false,
        error: 'Origin is not allowed.',
        origin,
        allowed_origins: Array.from(getAllowedOrigins())
      },
      origin
    );
  }

  try {
    const body = parseJsonBody(event);
    const record = buildLeadRecord(body);

    const insertResult = await insertLeadRecord(record);
    const insertedRecord = insertResult.record || {};

    let notification = { skipped: true };
    try {
      notification = await sendResendEmail(
        buildInternalNotification(record, insertedRecord)
      );
    } catch (emailError) {
      console.warn('[submit-lead] Resend notification failed:', emailError.message);
      notification = { skipped: true, error: emailError.message };
    }

    return json(
      200,
      {
        ok: true,
        message: 'Lead received.',
        id: insertedRecord.id || null,
        record: insertedRecord,
        schema_fallback_used: insertResult.schemaFallbackUsed,
        notification
      },
      origin
    );
  } catch (error) {
    console.error('[submit-lead] error:', error);

    const statusCode = error.statusCode && Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;

    return json(
      statusCode,
      {
        ok: false,
        error: statusCode === 500
          ? 'Unable to submit lead right now.'
          : error.message,
        detail: process.env.NODE_ENV === 'development' ? error.message : undefined
      },
      origin
    );
  }
};
