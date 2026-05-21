/**
 * FlowDesk — Netlify Serverless Function
 * netlify/functions/submit.js
 *
 * Retargeted from Apropos Group debt intake → FlowDesk AI lead capture intake.
 *
 * What this function does:
 *   1. Receives a POST from FlowDesk's AI call handler (or the waitlist form)
 *   2. Validates and normalizes the incoming lead payload
 *   3. Sends a structured internal alert email to the business owner (Jeffery)
 *   4. Sends a confirmation email to the caller/lead if an email was captured
 *   5. Returns a structured JSON lead record
 *
 * KEPT from original:
 *   - Resend email infrastructure (same API key, same pattern)
 *   - safeString / safeNumber / filenameSafe / formatDate helpers
 *   - Bilingual EN/ES support
 *   - Dual email send (client confirmation + internal alert)
 *   - Error handling and logging pattern
 *
 * REMOVED from original:
 *   - All debt/financial data logic
 *   - Adobe PDF Services SDK (not needed for lead intake)
 *   - JSZip / DOCX template rendering
 *   - amortize(), buildFreeMergeData(), buildComprehensiveMergeData()
 *   - All debt template filename logic
 *
 * ADDED for FlowDesk:
 *   - Lead qualification fields (intent, urgency, industry, notes)
 *   - Urgency-based alert subject lines
 *   - Structured HTML alert email with lead card design
 *   - Lead ID generation for dashboard tracking
 *   - SMS-ready alert body (Twilio-compatible, wired later)
 *   - Waitlist / founding member form handling
 *
 * ENV VARIABLES REQUIRED (set in Netlify → Site Settings → Environment Variables):
 *   RESEND_API_KEY          — your Resend API key (already configured)
 *   RESEND_FROM_EMAIL       — e.g. FlowDesk <intake@aproposgroupllc.com>
 *   RESEND_TO_EMAIL         — your alert destination, e.g. support@ai4businesses.org
 *   FLOWDESK_SITE_URL       — e.g. https://flowdeskpro.aproposgroupllc.com (optional, for email links)
 */

'use strict';

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/* ─────────────────────────────────────────────
   URGENCY CONFIG
   Maps urgency strings to email subject prefixes
   and priority labels shown in the alert.
───────────────────────────────────────────── */
const URGENCY_CONFIG = {
  high:   { label: '🔴 HIGH PRIORITY',   prefix: '🔴 HOT LEAD',    color: '#ef4444' },
  medium: { label: '🟡 MEDIUM PRIORITY', prefix: '🟡 NEW LEAD',    color: '#f59e0b' },
  low:    { label: '🟢 ROUTINE',         prefix: '🟢 NEW LEAD',    color: '#22c55e' },
  unknown:{ label: '⚪ UNCLASSIFIED',    prefix: '⚪ NEW LEAD',    color: '#8b949e' },
};

/* ─────────────────────────────────────────────
   INDUSTRY LABELS
───────────────────────────────────────────── */
const INDUSTRY_LABELS = {
  legal:      'Legal / Law Firm',
  medical:    'Medical Practice',
  dental:     'Dental Office',
  hvac:       'HVAC / Contractor',
  realestate: 'Real Estate',
  insurance:  'Insurance Agency',
  veterinary: 'Veterinary',
  financial:  'Financial Services',
  other:      'Other',
};

/* ─────────────────────────────────────────────
   UTILITY HELPERS  (kept from original)
───────────────────────────────────────────── */
function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function safeNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = safeString(value).replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function filenameSafe(value, fallback = 'Lead') {
  const cleaned = safeString(value, fallback).replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned || fallback;
}

function normalizeLanguage(value) {
  return safeString(value).toLowerCase() === 'es' ? 'es' : 'en';
}

function normalizeUrgency(value) {
  const v = safeString(value).toLowerCase();
  if (['high', 'urgent', 'emergency', 'hot'].includes(v))  return 'high';
  if (['medium', 'normal', 'warm'].includes(v))             return 'medium';
  if (['low', 'routine', 'cold'].includes(v))               return 'low';
  return 'unknown';
}

function normalizeIndustry(value) {
  const v = safeString(value).toLowerCase();
  if (v in INDUSTRY_LABELS) return v;
  // fuzzy match
  if (v.includes('law') || v.includes('legal') || v.includes('attorney')) return 'legal';
  if (v.includes('med') || v.includes('clinic') || v.includes('doctor'))  return 'medical';
  if (v.includes('dent'))                                                   return 'dental';
  if (v.includes('hvac') || v.includes('plumb') || v.includes('electr'))  return 'hvac';
  if (v.includes('real') || v.includes('estate') || v.includes('realt'))  return 'realestate';
  if (v.includes('insur'))                                                  return 'insurance';
  if (v.includes('vet'))                                                    return 'veterinary';
  if (v.includes('financ') || v.includes('invest'))                        return 'financial';
  return 'other';
}

function formatDate(value) {
  const raw = safeString(value);
  const dt = raw ? new Date(raw) : new Date();
  const valid = Number.isFinite(dt.getTime()) ? dt : new Date();
  return valid.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }) + ' PT';
}

function generateLeadId() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FD-${ts}-${rnd}`;
}

/* ─────────────────────────────────────────────
   PAYLOAD NORMALIZATION
   Accepts data from:
     (a) FlowDesk AI call handler (POST from Twilio/Telnyx webhook → your function)
     (b) FlowDesk waitlist / founding member form (landing page form submit)
     (c) Manual test POST
───────────────────────────────────────────── */
function normalizeLead(raw) {
  const source = safeString(raw?.source, 'web_form');

  // Caller / lead identity
  const fullName  = safeString(raw?.full_name   || raw?.caller_name || raw?.name, 'Unknown Caller');
  const email     = safeString(raw?.email       || raw?.caller_email, '');
  const phone     = safeString(raw?.phone       || raw?.caller_phone || raw?.From, '');
  const language  = normalizeLanguage(raw?.language);

  // Lead qualification
  const intent    = safeString(raw?.intent      || raw?.call_reason || raw?.reason, 'Not specified');
  const urgency   = normalizeUrgency(raw?.urgency || raw?.priority);
  const industry  = normalizeIndustry(raw?.industry || raw?.business_type || raw?.vertical);
  const notes     = safeString(raw?.notes       || raw?.transcript_summary || raw?.summary, '');
  const callDuration = safeNumber(raw?.call_duration || raw?.duration, 0);

  // Business context (for white-label / agency use later)
  const businessName = safeString(raw?.business_name || raw?.account_name, 'FlowDesk Client');

  return {
    lead_id:       generateLeadId(),
    source,
    full_name:     fullName,
    email,
    phone,
    language,
    intent,
    urgency,
    industry,
    notes,
    call_duration: callDuration,
    business_name: businessName,
    timestamp:     new Date().toISOString(),
    timestamp_fmt: formatDate(),
  };
}

/* ─────────────────────────────────────────────
   EMAIL CONTENT — BILINGUAL
───────────────────────────────────────────── */
function getContent(language = 'en') {
  if (language === 'es') {
    return {
      // Internal alert to owner
      internalSubject:     (urgency, name) => `${URGENCY_CONFIG[urgency]?.prefix || '⚪ NUEVO LEAD'} — ${name}`,
      internalHeading:     'Nueva Solicitud de Contacto — FlowDesk',
      // Confirmation to caller (if email captured)
      confirmSubject:      'Gracias por contactarnos — Le llamaremos pronto',
      confirmGreeting:     (name) => `Hola ${name},`,
      confirmBody:         'Hemos recibido su mensaje y un miembro de nuestro equipo se comunicará con usted a la brevedad posible.',
      confirmUrgent:       'Su solicitud ha sido marcada como URGENTE y será atendida con prioridad.',
      confirmSignature:    '— El equipo de FlowDesk',
      // Labels
      labels: {
        leadId:      'ID de Lead',
        name:        'Nombre',
        phone:       'Teléfono',
        email:       'Correo',
        intent:      'Motivo de Contacto',
        urgency:     'Urgencia',
        industry:    'Industria',
        notes:       'Notas / Resumen',
        source:      'Fuente',
        received:    'Recibido',
        notProvided: 'No proporcionado',
      },
    };
  }

  return {
    internalSubject:  (urgency, name) => `${URGENCY_CONFIG[urgency]?.prefix || '⚪ NEW LEAD'} — ${name}`,
    internalHeading:  'New Lead Captured — FlowDesk',
    confirmSubject:   'We received your message — we\'ll be in touch shortly',
    confirmGreeting:  (name) => `Hi ${name},`,
    confirmBody:      'We\'ve received your inquiry and a member of our team will follow up with you as soon as possible.',
    confirmUrgent:    'Your request has been flagged as URGENT and will be handled with priority.',
    confirmSignature: '— The FlowDesk Team',
    labels: {
      leadId:      'Lead ID',
      name:        'Name',
      phone:       'Phone',
      email:       'Email',
      intent:      'Reason for Contact',
      urgency:     'Urgency',
      industry:    'Industry',
      notes:       'Notes / Summary',
      source:      'Source',
      received:    'Received',
      notProvided: 'Not provided',
    },
  };
}

/* ─────────────────────────────────────────────
   INTERNAL ALERT EMAIL  (to Jeffery / business owner)
   Styled lead card — readable in any email client
───────────────────────────────────────────── */
function buildInternalAlertHtml(lead) {
  const urgCfg = URGENCY_CONFIG[lead.urgency] || URGENCY_CONFIG.unknown;
  const industryLabel = INDUSTRY_LABELS[lead.industry] || lead.industry;
  const siteUrl = safeString(process.env.FLOWDESK_SITE_URL, 'https://flowdeskpro.aproposgroupllc.com');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowDesk Lead Alert</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,Helvetica,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="padding-bottom:24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;
                               padding:4px 10px;border-radius:4px;letter-spacing:1px;">fd</span>
                  <span style="color:#8b949e;font-size:13px;margin-left:10px;letter-spacing:1px;">
                    FLOWDESK · INTAKE ALERT
                  </span>
                </td>
                <td align="right">
                  <span style="font-family:monospace;font-size:11px;color:#484f58;">${lead.lead_id}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Urgency Banner -->
        <tr>
          <td style="background:${urgCfg.color}18;border:1px solid ${urgCfg.color}44;
                     border-radius:8px;padding:14px 20px;margin-bottom:20px;">
            <span style="font-size:15px;font-weight:700;color:${urgCfg.color};">${urgCfg.label}</span>
            <span style="font-size:13px;color:#c9d1d9;margin-left:12px;">
              ${industryLabel} · ${lead.timestamp_fmt}
            </span>
          </td>
        </tr>

        <tr><td style="height:16px;"></td></tr>

        <!-- Lead Card -->
        <tr>
          <td style="background:#161b22;border:1px solid #30363d;border-radius:10px;
                     padding:28px 28px 20px;">

            <table width="100%" cellpadding="0" cellspacing="0">
              <!-- Name row -->
              <tr>
                <td style="padding-bottom:20px;border-bottom:1px solid #21262d;">
                  <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;
                             color:#484f58;">Contact</p>
                  <p style="margin:6px 0 0;font-size:22px;font-weight:700;color:#f0f6fc;">
                    ${safeString(lead.full_name, 'Unknown Caller')}
                  </p>
                </td>
              </tr>

              <tr><td style="height:16px;"></td></tr>

              <!-- Contact details grid -->
              <tr>
                <td>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="50%" style="padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Phone</p>
                        <p style="margin:4px 0 0;font-size:15px;color:#2d9cdb;font-weight:600;">
                          ${lead.phone ? `<a href="tel:${lead.phone}" style="color:#2d9cdb;text-decoration:none;">${lead.phone}</a>` : '<span style="color:#484f58;">Not captured</span>'}
                        </p>
                      </td>
                      <td width="50%" style="padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Email</p>
                        <p style="margin:4px 0 0;font-size:15px;color:#c9d1d9;">
                          ${lead.email ? `<a href="mailto:${lead.email}" style="color:#2d9cdb;text-decoration:none;">${lead.email}</a>` : '<span style="color:#484f58;">Not captured</span>'}
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td width="50%" style="padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Industry</p>
                        <p style="margin:4px 0 0;font-size:15px;color:#c9d1d9;">${industryLabel}</p>
                      </td>
                      <td width="50%" style="padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Source</p>
                        <p style="margin:4px 0 0;font-size:15px;color:#c9d1d9;">${lead.source}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Intent -->
              <tr>
                <td style="padding:14px 0;border-top:1px solid #21262d;">
                  <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Reason for Contact</p>
                  <p style="margin:6px 0 0;font-size:15px;color:#f0f6fc;line-height:1.5;">${lead.intent}</p>
                </td>
              </tr>

              ${lead.notes ? `
              <!-- Notes -->
              <tr>
                <td style="padding:14px 0;border-top:1px solid #21262d;">
                  <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Notes / Call Summary</p>
                  <p style="margin:6px 0 0;font-size:14px;color:#8b949e;line-height:1.6;">${lead.notes}</p>
                </td>
              </tr>` : ''}

              <!-- Lead ID footer -->
              <tr>
                <td style="padding-top:16px;border-top:1px solid #21262d;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td>
                        <p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">
                          Lead ID: ${lead.lead_id}
                        </p>
                      </td>
                      <td align="right">
                        <p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">
                          ${lead.timestamp_fmt}
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <tr><td style="height:24px;"></td></tr>

        <!-- Footer -->
        <tr>
          <td style="text-align:center;">
            <p style="margin:0;font-size:11px;color:#484f58;letter-spacing:1px;">
              FLOWDESK · APROPOS GROUP LLC · ${new Date().getFullYear()}
            </p>
            <p style="margin:6px 0 0;font-size:11px;color:#484f58;">
              <a href="${siteUrl}" style="color:#484f58;text-decoration:none;">${siteUrl}</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

function buildInternalAlertText(lead) {
  const urgCfg = URGENCY_CONFIG[lead.urgency] || URGENCY_CONFIG.unknown;
  const industryLabel = INDUSTRY_LABELS[lead.industry] || lead.industry;
  return [
    `FLOWDESK LEAD ALERT — ${urgCfg.label}`,
    '─'.repeat(50),
    `Lead ID:   ${lead.lead_id}`,
    `Received:  ${lead.timestamp_fmt}`,
    '',
    `Name:      ${lead.full_name}`,
    `Phone:     ${lead.phone || 'Not captured'}`,
    `Email:     ${lead.email || 'Not captured'}`,
    `Industry:  ${industryLabel}`,
    `Urgency:   ${urgCfg.label}`,
    `Source:    ${lead.source}`,
    '',
    `Intent:    ${lead.intent}`,
    lead.notes ? `Notes:     ${lead.notes}` : '',
    '',
    '─'.repeat(50),
    'FlowDesk · Apropos Group LLC',
  ].filter(line => line !== null).join('\n');
}

/* ─────────────────────────────────────────────
   CALLER CONFIRMATION EMAIL  (to the lead, if email captured)
───────────────────────────────────────────── */
function buildConfirmationHtml(lead) {
  const c = getContent(lead.language);
  const isUrgent = lead.urgency === 'high';

  return `<!DOCTYPE html>
<html lang="${lead.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px;">
  <tr>
    <td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;
             background:#ffffff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;">

        <!-- Header bar -->
        <tr>
          <td style="background:#0d1117;padding:20px 28px;">
            <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;
                         padding:4px 10px;border-radius:4px;">fd</span>
            <span style="color:#8b949e;font-size:13px;margin-left:10px;">FlowDesk</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 28px;">
            <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#24292f;">
              ${c.confirmGreeting(lead.full_name)}
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#57606a;line-height:1.6;">
              ${c.confirmBody}
            </p>
            ${isUrgent ? `
            <p style="margin:0 0 16px;padding:12px 16px;background:#fff3cd;border:1px solid #f59e0b;
                       border-radius:6px;font-size:14px;color:#92400e;">
              ⚡ ${c.confirmUrgent}
            </p>` : ''}
            <p style="margin:0;font-size:15px;color:#57606a;line-height:1.6;">
              ${c.confirmSignature}
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f6f8fa;border-top:1px solid #d0d7de;padding:16px 28px;
                     text-align:center;">
            <p style="margin:0;font-size:11px;color:#8b949e;letter-spacing:1px;">
              FLOWDESK · APROPOS GROUP LLC
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildConfirmationText(lead) {
  const c = getContent(lead.language);
  return [
    c.confirmGreeting(lead.full_name),
    '',
    c.confirmBody,
    lead.urgency === 'high' ? c.confirmUrgent : '',
    '',
    c.confirmSignature,
    '',
    '— FlowDesk · Apropos Group LLC',
  ].filter(l => l !== null).join('\n');
}

/* ─────────────────────────────────────────────
   WAITLIST / FOUNDING MEMBER HANDLER
   Triggered when someone submits the landing page
   "Reserve Access" / "Secure My Spot" form.
   Payload shape: { email, source: 'waitlist', full_name? }
───────────────────────────────────────────── */
function buildWaitlistInternalHtml(lead) {
  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#0d1117;padding:32px;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;
            padding:24px;max-width:500px;">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:1px;color:#484f58;text-transform:uppercase;">
    FLOWDESK · WAITLIST SIGNUP
  </p>
  <h2 style="margin:0 0 20px;color:#f0f6fc;font-size:18px;">New Founding Member Request</h2>
  <p style="margin:0 0 8px;color:#c9d1d9;font-size:14px;">
    <strong style="color:#8b949e;">Email:</strong>
    <a href="mailto:${lead.email}" style="color:#2d9cdb;text-decoration:none;">${lead.email}</a>
  </p>
  <p style="margin:0 0 8px;color:#c9d1d9;font-size:14px;">
    <strong style="color:#8b949e;">Name:</strong> ${lead.full_name !== 'Unknown Caller' ? lead.full_name : 'Not provided'}
  </p>
  <p style="margin:0 0 20px;color:#c9d1d9;font-size:14px;">
    <strong style="color:#8b949e;">Received:</strong> ${lead.timestamp_fmt}
  </p>
  <p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">${lead.lead_id}</p>
</div>
</body>
</html>`;
}

function buildWaitlistConfirmHtml(lead) {
  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f8fa;padding:32px 16px;">
<div style="background:#fff;border:1px solid #d0d7de;border-radius:10px;
            max-width:520px;margin:0 auto;overflow:hidden;">
  <div style="background:#0d1117;padding:20px 28px;">
    <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;
                 padding:4px 10px;border-radius:4px;">fd</span>
    <span style="color:#8b949e;font-size:13px;margin-left:10px;">FlowDesk</span>
  </div>
  <div style="padding:32px 28px;">
    <h2 style="margin:0 0 16px;font-size:20px;color:#24292f;">You're on the list. 🎉</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#57606a;line-height:1.6;">
      Welcome to FlowDesk, founding member. We'll be in touch within 24 hours
      to get your account set up and your 60-day free access activated.
    </p>
    <p style="margin:0;font-size:15px;color:#57606a;">— The FlowDesk Team</p>
  </div>
  <div style="background:#f6f8fa;border-top:1px solid #d0d7de;padding:14px 28px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#8b949e;">FLOWDESK · APROPOS GROUP LLC</p>
  </div>
</div>
</body>
</html>`;
}

/* ─────────────────────────────────────────────
   MAIN HANDLER
───────────────────────────────────────────── */
exports.handler = async (event) => {
  let lead = null;

  try {
    // ── Method guard ──────────────────────────
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method Not Allowed' }),
      };
    }

    // ── Content-Type guard ────────────────────
    const contentType = safeString(
      event.headers?.['content-type'] || event.headers?.['Content-Type']
    ).toLowerCase();

    if (!contentType.includes('application/json')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Content-Type must be application/json' }),
      };
    }

    // ── Parse ─────────────────────────────────
    const raw = JSON.parse(event.body || '{}');

    // ── Normalize into unified lead object ────
    lead = normalizeLead(raw);

    // ── Validate minimum required fields ──────
    // At minimum we need either a phone number OR an email to do anything useful.
    if (!lead.phone && !lead.email) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'At least one of phone or email is required to process a lead.',
          lead_id: lead.lead_id,
        }),
      };
    }

    // ── Env vars ──────────────────────────────
    const alertTo   = process.env.RESEND_TO_EMAIL || process.env.NOTIFICATION_EMAIL || process.env.TO_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk <intake@aproposgroupllc.com>';

    if (!alertTo) {
      throw new Error('RESEND_TO_EMAIL environment variable is not configured.');
    }

    // ── Determine flow ────────────────────────
    const isWaitlist = safeString(raw?.source).toLowerCase() === 'waitlist'
      || safeString(raw?.form_type).toLowerCase() === 'waitlist';

    const urgCfg = URGENCY_CONFIG[lead.urgency] || URGENCY_CONFIG.unknown;

    // ── Send emails ───────────────────────────
    const emailPromises = [];

    if (isWaitlist) {
      // Waitlist flow: internal notification + confirmation to submitter
      emailPromises.push(
        resend.emails.send({
          from: fromEmail,
          to: [alertTo],
          replyTo: lead.email || alertTo,
          subject: `🎯 New Founding Member Signup — ${lead.email}`,
          html: buildWaitlistInternalHtml(lead),
          text: `New Founding Member: ${lead.email}\nName: ${lead.full_name}\nReceived: ${lead.timestamp_fmt}\nID: ${lead.lead_id}`,
        })
      );

      if (lead.email) {
        emailPromises.push(
          resend.emails.send({
            from: fromEmail,
            to: [lead.email],
            replyTo: alertTo,
            subject: `You\'re on the FlowDesk founding list ✓`,
            html: buildWaitlistConfirmHtml(lead),
            text: `Welcome to FlowDesk! You're confirmed as a founding member.\nWe'll be in touch within 24 hours.\n\n— The FlowDesk Team`,
          })
        );
      }
    } else {
      // Lead intake flow: internal alert + optional caller confirmation
      emailPromises.push(
        resend.emails.send({
          from: fromEmail,
          to: [alertTo],
          replyTo: lead.email || alertTo,
          subject: getContent(lead.language).internalSubject(lead.urgency, lead.full_name),
          html: buildInternalAlertHtml(lead),
          text: buildInternalAlertText(lead),
        })
      );

      if (lead.email) {
        emailPromises.push(
          resend.emails.send({
            from: fromEmail,
            to: [lead.email],
            replyTo: alertTo,
            subject: getContent(lead.language).confirmSubject,
            html: buildConfirmationHtml(lead),
            text: buildConfirmationText(lead),
          })
        );
      }
    }

    const results = await Promise.allSettled(emailPromises);

    // Log outcomes without throwing if confirmation email failed
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`EMAIL [${i}] SENT:`, JSON.stringify(r.value));
      } else {
        console.error(`EMAIL [${i}] FAILED:`, r.reason?.message || r.reason);
      }
    });

    const internalSent = results[0]?.status === 'fulfilled';

    // ── Console log for Netlify function logs ─
    console.log('LEAD ID:', lead.lead_id);
    console.log('SOURCE:', lead.source);
    console.log('URGENCY:', lead.urgency, urgCfg.label);
    console.log('INDUSTRY:', lead.industry);
    console.log('PHONE:', lead.phone || 'none');
    console.log('EMAIL:', lead.email || 'none');
    console.log('INTENT:', lead.intent);
    console.log('ALERT TO:', alertTo);
    console.log('INTERNAL ALERT SENT:', internalSent);

    // ── Response ──────────────────────────────
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success: true,
        lead_id: lead.lead_id,
        message: 'Lead captured and alert dispatched.',
        urgency: lead.urgency,
        urgency_label: urgCfg.label,
        industry: lead.industry,
        alert_sent_to: alertTo,
        confirmation_sent: lead.email ? results[1]?.status === 'fulfilled' : false,
        timestamp: lead.timestamp,
      }),
    };

  } catch (error) {
    console.error('FLOWDESK SUBMIT ERROR:', error?.message || error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Internal Server Error',
        details: safeString(error?.message),
        lead_id: lead?.lead_id || null,
      }),
    };
  }
};
