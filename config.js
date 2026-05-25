'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — shared server configuration + public config endpoint.
 * Secrets are read only inside Netlify Functions. The handler below returns safe public
 * branding and feature-flag values for frontend pages.
 */

const DEFAULT_TABLE = 'lead_manager_records';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value);
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeEmail(value = '') {
  return safeString(value).toLowerCase();
}

function isValidEmail(value = '') {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatPhone(number) {
  const raw = safeString(number);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function getServerConfig() {
  const supabaseUrl = env('SUPABASE_URL');
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  const clientName = env('CLIENT_NAME', 'Apropos Group LLC');
  const clientBrandName = env('CLIENT_BRAND_NAME', 'AI4 Businesses');
  const tenantId = env('CLIENT_TENANT_ID', 'apropos-ai4-businesses');

  return {
    supabaseUrl,
    supabaseKey,
    tableName: env('LEAD_MANAGER_TABLE', DEFAULT_TABLE),
    siteUrl: env('LEAD_MANAGER_SITE_URL', '').replace(/\/$/, ''),
    clientName,
    clientBrandName,
    tenantId,
    resendKey: env('RESEND_API_KEY'),
    resendFrom: env('RESEND_FROM_EMAIL', 'FlowDesk Pro <notifications@aiflowdeskpro.com>'),
    resendTo: env('CLIENT_NOTIFICATION_EMAIL') || env('RESEND_TO_EMAIL'),
    twilioPhoneNumber: env('TWILIO_PHONE_NUMBER'),
    twilioAlertPhone: env('TWILIO_ALERT_PHONE'),
    flags: {
      sms: boolEnv('SMS_ENABLED', false),
      voice: boolEnv('VOICE_ENABLED', false),
      appointments: boolEnv('APPOINTMENTS_ENABLED', false),
      billing: boolEnv('BILLING_ENABLED', false),
      aiSummary: boolEnv('AI_SUMMARY_ENABLED', false),
    },
  };
}

function requireSupabaseConfig() {
  const config = getServerConfig();
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Supabase environment variables are not configured.');
  }
  return config;
}

function publicConfig() {
  const config = getServerConfig();
  return {
    ok: true,
    product: {
      name: 'FlowDesk Pro Lead Manager',
      version: '1.0.0',
      edition: 'V1 Platinum Command Center',
      poweredBy: 'FlowDesk Pro',
    },
    tenant: {
      id: config.tenantId,
      clientName: config.clientName,
      brandName: config.clientBrandName,
    },
    siteUrl: config.siteUrl,
    intakePath: '/intake',
    dashboardPath: '/dashboard',
    supportEmail: 'support@aproposgroupllc.com',
    twilioPhoneNumber: config.twilioPhoneNumber || '',
    flags: config.flags,
    statuses: [
      'New / Needs Review',
      'New / Priority Review',
      'Contacted',
      'In Progress',
      'Waiting on Customer',
      'Follow-Up Scheduled',
      'Appointment Requested',
      'Closed / Resolved',
      'Not a Fit',
    ],
    urgencies: ['High', 'Normal', 'Low'],
    sources: [
      { value: 'web_intake', label: 'Web Intake' },
      { value: 'voice', label: 'Voice Lead' },
      { value: 'sms', label: 'SMS Lead' },
      { value: 'appointment', label: 'Appointment' },
      { value: 'manual', label: 'Manual' },
    ],
    serviceTypes: [
      'AI Website Design',
      'Lead Response System',
      'AI Voice Assistant',
      'CRM / Workflow Automation',
      'SMS Follow-Up',
      'Appointment Workflow',
      'General Business Automation',
    ],
  };
}

async function parseEventBody(event) {
  const raw = event.body || '';
  const contentType = safeString(event.headers?.['content-type'] || event.headers?.['Content-Type']).toLowerCase();

  if (!raw) return {};

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('Invalid JSON body.');
  }
}

function encodeFilter(value) {
  return encodeURIComponent(safeString(value));
}

async function supabaseRequest(method, path, body = null, options = {}) {
  const config = requireSupabaseConfig();
  const base = config.supabaseUrl.replace(/\/$/, '');
  const url = `${base}/rest/v1/${path}`;
  const requestBody = body === null || body === undefined ? null : JSON.stringify(body);

  const headers = {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    'Content-Type': 'application/json',
  };

  if (options.prefer || requestBody) {
    headers.Prefer = options.prefer || 'return=representation';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: requestBody,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = text;
  }

  if (!response.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`Supabase ${method} failed ${response.status}: ${detail}`);
  }

  return parsed;
}

async function sendResendEmail({ to, subject, html, text, replyTo }) {
  const config = getServerConfig();

  if (!config.resendKey || !to) {
    return { skipped: true, reason: 'Resend is not configured or no recipient was provided.' };
  }

  const payload = {
    from: config.resendFrom,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  };

  if (replyTo) payload.reply_to = replyTo;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let parsed = null;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch (_) {
    parsed = responseText;
  }

  if (!response.ok) {
    throw new Error(`Resend failed ${response.status}: ${responseText}`);
  }

  return parsed || { ok: true };
}

function leadName(record = {}) {
  return safeString(
    record.contact_name ||
    record.full_name ||
    [record.first_name, record.last_name].filter(Boolean).join(' '),
    'Unknown Contact'
  );
}

function leadBusiness(record = {}) {
  return safeString(record.business_name || record.company || record.client_name, 'Unknown Business');
}

function buildLeadDashboardUrl(recordId = '') {
  const config = getServerConfig();
  if (!config.siteUrl) return '';
  const id = recordId ? `?lead=${encodeURIComponent(recordId)}` : '';
  return `${config.siteUrl}/dashboard${id}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  return json(200, publicConfig());
};

exports.CORS_HEADERS = CORS_HEADERS;
exports.DEFAULT_TABLE = DEFAULT_TABLE;
exports.json = json;
exports.env = env;
exports.boolEnv = boolEnv;
exports.safeString = safeString;
exports.normalizeEmail = normalizeEmail;
exports.isValidEmail = isValidEmail;
exports.nowIso = nowIso;
exports.escapeHtml = escapeHtml;
exports.escapeXml = escapeXml;
exports.formatPhone = formatPhone;
exports.getServerConfig = getServerConfig;
exports.requireSupabaseConfig = requireSupabaseConfig;
exports.publicConfig = publicConfig;
exports.parseEventBody = parseEventBody;
exports.encodeFilter = encodeFilter;
exports.supabaseRequest = supabaseRequest;
exports.sendResendEmail = sendResendEmail;
exports.leadName = leadName;
exports.leadBusiness = leadBusiness;
exports.buildLeadDashboardUrl = buildLeadDashboardUrl;
