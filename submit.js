'use strict';

/**
 * FlowDesk Pro — Demo Request Intake Handler
 * netlify/functions/submit.js
 *
 * Handles the demo-request.html form submit.
 * 1. Validates required fields
 * 2. Writes to Supabase demo_requests table
 * 3. Returns { ok, ref_slug } for client-side redirect to page-2.html
 */

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function clean(v) { return String(v || '').trim(); }

function generateSlug(businessName) {
  return businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60);
}

async function writeToSupabase(supabaseUrl, serviceKey, record) {
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/demo_requests`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(record),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function sendAlertEmail(record) {
  const apiKey   = clean(process.env.RESEND_API_KEY);
  const fromEmail = clean(process.env.RESEND_FROM_EMAIL) || 'FlowDesk Pro <support@aiflowdeskpro.com>';
  const toEmail  = clean(process.env.RESEND_TO_EMAIL) || 'jmitchell@aiflowdeskpro.com';

  if (!apiKey) return;

  const html = `<!DOCTYPE html>
<html><body style="background:#0d1117;font-family:Arial,sans-serif;padding:32px;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px;max-width:520px;">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:1px;color:#484f58;text-transform:uppercase;">FLOWDESK · DEMO REQUEST</p>
  <h2 style="margin:0 0 20px;color:#f0f6fc;font-size:18px;">🎯 New Demo Request — ${record.business_name}</h2>
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;width:120px;">Name</td><td style="padding:8px 0;color:#f0f6fc;font-size:15px;font-weight:600;">${record.first_name} ${record.last_name}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Business</td><td style="padding:8px 0;color:#2d9cdb;font-size:14px;font-weight:600;">${record.business_name}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Phone</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${record.phone}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Industry</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${record.industry}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Ref Slug</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;font-family:monospace;">${record.ref_slug}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Time</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</td></tr>
  </table>
  <div style="margin-top:20px;padding-top:16px;border-top:1px solid #30363d;">
    <p style="margin:0;font-size:13px;color:#8b949e;">Demo link: <a href="https://lead-management.aiflowdeskpro.com/page-2.html?business=${encodeURIComponent(record.business_name)}" style="color:#2d9cdb;">View demo page</a></p>
  </div>
</div>
</body></html>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `🎯 Demo Request — ${record.business_name} / ${record.first_name} ${record.last_name}`,
        html,
      }),
    });
  } catch (err) {
    console.error('Demo alert email error:', err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return resp(405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return resp(400, { ok: false, error: 'Invalid JSON body.' }); }

  const firstName    = clean(body.firstName || body.first_name);
  const lastName     = clean(body.lastName  || body.last_name);
  const businessName = clean(body.businessName || body.business_name);
  const phone        = clean(body.phone);
  const industry     = clean(body.industry);

  // Validate
  const missing = [];
  if (!firstName)    missing.push('firstName');
  if (!lastName)     missing.push('lastName');
  if (!businessName) missing.push('businessName');
  if (!phone)        missing.push('phone');
  if (!industry)     missing.push('industry');

  if (missing.length) {
    return resp(400, { ok: false, error: `Missing required fields: ${missing.join(', ')}` });
  }

  const refSlug  = generateSlug(businessName);
  const record = {
    first_name:    firstName,
    last_name:     lastName,
    business_name: businessName,
    phone,
    industry,
    ref_slug:      refSlug,
    created_at:    new Date().toISOString(),
  };

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey  = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Write to Supabase
  if (supabaseUrl && serviceKey) {
    try {
      const result = await writeToSupabase(supabaseUrl, serviceKey, record);
      console.log('demo_requests insert:', result.status, JSON.stringify(result.data));
      if (!result.ok) {
        console.error('Supabase insert failed:', result.status, result.data);
        // Non-fatal — still redirect the user
      }
    } catch (err) {
      console.error('Supabase exception:', err.message);
    }
  } else {
    console.warn('SUPABASE_URL or SUPABASE_SERVICE_KEY not set — skipping DB write');
  }

  // Send alert email (non-blocking)
  sendAlertEmail(record).catch(() => {});

  return resp(200, {
    ok: true,
    ref_slug: refSlug,
    business_name: businessName,
    message: 'Demo request received.',
  });
};

function resp(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
