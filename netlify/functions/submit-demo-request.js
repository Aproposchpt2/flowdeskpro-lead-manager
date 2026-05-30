'use strict';

/**
 * FlowDesk Pro Lead Manager — Demo Request Handler
 * POST /.netlify/functions/submit-demo-request
 *
 * Accepts: first_name, last_name, email, business_name, sms_consent, demo_site
 * Actions:
 *   1. Saves lead to Supabase lead_manager_records + demo_requests
 *   2. Sends internal notification to owner email
 *   3. Sends confirmation email to user
 *   4. If sms_consent=yes → sends Twilio SMS with compliant footer
 * Returns: { ok, lead_id, business_name }
 */

const {
  json,
  safeString,
  normalizeEmail,
  isValidEmail,
  nowIso,
  escapeHtml,
  getServerConfig,
  supabaseRequest,
  sendResendEmail,
} = require('./config');

const https = require('https');

function asBoolean(value) {
  if (value === true || value === 'yes' || value === '1' || value === 1) return true;
  if (typeof value === 'string') return ['true','yes','y','on'].includes(value.toLowerCase().trim());
  return false;
}

function twilioRequest(accountSid, authToken, to, from, body) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const payload = new URLSearchParams({ To: to, From: from, Body: body }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Twilio request timed out')));
    req.write(payload);
    req.end();
  });
}

const TWILIO_COMPLIANCE_FOOTER = '\nReply STOP to unsubscribe. Reply HELP for help. Msg & data rates may apply. AI4 Businesses aiflowdeskpro.com';

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER || '+17253305102';

  if (!accountSid || !authToken) {
    console.warn('[submit-demo-request] Twilio not configured — SMS skipped.');
    return { skipped: true };
  }

  const fullBody = body + TWILIO_COMPLIANCE_FOOTER;

  try {
    const result = await twilioRequest(accountSid, authToken, to, fromNumber, fullBody);
    if (result.statusCode >= 200 && result.statusCode < 300) {
      return { sent: true, sid: result.data?.sid };
    }
    console.error('[submit-demo-request] Twilio error:', result.data);
    return { sent: false, error: JSON.stringify(result.data) };
  } catch (err) {
    console.error('[submit-demo-request] Twilio exception:', err.message);
    return { sent: false, error: err.message };
  }
}

function buildOwnerEmailHtml({ firstName, lastName, email, businessName, phone, smsConsent, demoSite, leadId }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:28px;border-radius:18px;max-width:640px;margin:0 auto;">
      <div style="color:#73E6FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:16px;">FlowDesk Pro — New Demo Request</div>
      <h2 style="margin:0 0 12px;color:#ffffff;">New Demo Sign-Up: ${escapeHtml(businessName)}</h2>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;">
        <tr style="border-bottom:1px solid rgba(115,230,255,.15)"><td style="padding:8px;color:#90A3BC;width:130px;">Name</td><td style="padding:8px;color:#fff;font-weight:700;">${escapeHtml(firstName)} ${escapeHtml(lastName)}</td></tr>
        <tr style="border-bottom:1px solid rgba(115,230,255,.15)"><td style="padding:8px;color:#90A3BC;">Email</td><td style="padding:8px;color:#73E6FF;">${escapeHtml(email)}</td></tr>
        <tr style="border-bottom:1px solid rgba(115,230,255,.15)"><td style="padding:8px;color:#90A3BC;">Business</td><td style="padding:8px;color:#fff;">${escapeHtml(businessName)}</td></tr>
        <tr style="border-bottom:1px solid rgba(115,230,255,.15)"><td style="padding:8px;color:#90A3BC;">Demo Site</td><td style="padding:8px;color:#fff;">${escapeHtml(demoSite)}</td></tr>
        <tr style="border-bottom:1px solid rgba(115,230,255,.15)"><td style="padding:8px;color:#90A3BC;">SMS Consent</td><td style="padding:8px;color:${smsConsent ? '#55E6A5' : '#90A3BC'};">${smsConsent ? 'Yes — SMS sent' : 'No'}</td></tr>
        <tr><td style="padding:8px;color:#90A3BC;">Lead ID</td><td style="padding:8px;color:#90A3BC;font-size:11px;">${escapeHtml(leadId || 'N/A')}</td></tr>
      </table>
      <a href="https://lead-management.aiflowdeskpro.com/dashboard" style="display:inline-block;margin-top:22px;background:linear-gradient(135deg,#f5f8ff,#73e6ff,#4a7fff);color:#03101f;font-weight:900;text-decoration:none;border-radius:10px;padding:13px 22px;font-size:13px;">Open Lead Dashboard →</a>
    </div>
  `;
}

function buildUserConfirmationHtml({ firstName, businessName }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#07111f;color:#f5f8ff;padding:32px;border-radius:18px;max-width:580px;margin:0 auto;">
      <div style="color:#73E6FF;font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;margin-bottom:18px;">FlowDesk Pro Lead Manager</div>
      <h2 style="margin:0 0 10px;color:#fff;font-size:1.6rem;">Your dashboard is ready, ${escapeHtml(firstName)}.</h2>
      <p style="color:#a8b8d0;line-height:1.75;margin-bottom:20px;">Your <strong style="color:#73E6FF;">${escapeHtml(businessName)}</strong> Lead Manager dashboard has been configured. You can explore the full system now.</p>
      <a href="https://lead-management.aiflowdeskpro.com/dashboard?business_name=${encodeURIComponent(businessName)}" style="display:inline-block;background:linear-gradient(135deg,#f5f8ff,#73e6ff,#4a7fff);color:#03101f;font-weight:900;text-decoration:none;border-radius:10px;padding:14px 24px;font-size:14px;">Open ${escapeHtml(businessName)} Dashboard →</a>
      <p style="font-size:12px;color:#586880;margin-top:24px;line-height:1.6;">Questions? Reply to this email or visit <a href="https://aiflowdeskpro.com" style="color:#73e6ff;">aiflowdeskpro.com</a><br>FlowDesk Pro · Apropos Group LLC · Las Vegas, NV</p>
    </div>
  `;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '{}')); }
  catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const firstName   = safeString(body.first_name);
  const lastName    = safeString(body.last_name);
  const email       = normalizeEmail(body.email);
  const businessName = safeString(body.business_name);
  const phone       = safeString(body.phone);
  const smsConsent  = asBoolean(body.sms_consent);
  const demoSite    = safeString(body.demo_site, 'lead-management.aiflowdeskpro.com');

  if (!firstName)    return json(400, { ok: false, error: 'First name is required' });
  if (!lastName)     return json(400, { ok: false, error: 'Last name is required' });
  if (!email || !isValidEmail(email)) return json(400, { ok: false, error: 'Valid email is required' });
  if (!businessName) return json(400, { ok: false, error: 'Business name is required' });

  const config = getServerConfig();
  const now = nowIso();
  const contactName = `${firstName} ${lastName}`;

  // Build Supabase record
  const record = {
    created_at: now,
    updated_at: now,
    tenant_id: process.env.CLIENT_TENANT_ID || 'apropos-ai4-businesses',
    client_name: process.env.CLIENT_NAME || 'Apropos Group LLC',
    business_name: businessName,
    contact_name: contactName,
    first_name: firstName,
    last_name: lastName,
    email,
    phone: phone || null,
    source: 'demo_request',
    channel: 'web',
    source_page: 'demo-request',
    source_url: demoSite,
    lead_status: 'New / Demo Requested',
    urgency: 'Normal',
    service_needed: 'FlowDesk Pro Lead Manager Demo',
    category: 'Demo Request',
    preferred_contact_method: 'Email',
    message: `Demo requested for ${businessName}. SMS consent: ${smsConsent ? 'Yes' : 'No'}.`,
    details: `Demo request from ${businessName} via ${demoSite}.`,
    follow_up_needed: true,
    appointment_requested: true,
    sms_consent: smsConsent,
    next_action: 'Welcome to demo — follow up within 24 hours.',
    metadata: {
      demo_site: demoSite,
      sms_consent: smsConsent,
      origin: 'demo-request-form',
    },
  };

  let leadId = null;

  // Save to Supabase
  try {
    const result = await supabaseRequest('POST', '/rest/v1/lead_manager_records', record, {
      Prefer: 'return=representation',
    });
    const inserted = Array.isArray(result) ? result[0] : result;
    leadId = inserted?.id || null;
    console.log('[submit-demo-request] Lead saved:', leadId);
  } catch (err) {
    console.error('[submit-demo-request] Supabase error:', err.message);
    // Continue — don't fail the user experience on DB error
  }

  const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL || 'jmitchell@aproposgroupllc.com';
  const fromEmail  = process.env.RESEND_FROM_EMAIL || 'FlowDesk Pro <notifications@aiflowdeskpro.com>';

  // Send owner notification
  try {
    await sendResendEmail({
      from: fromEmail,
      to: ownerEmail,
      subject: `New Demo Request: ${businessName}`,
      html: buildOwnerEmailHtml({ firstName, lastName, email, businessName, phone, smsConsent, demoSite, leadId }),
    });
  } catch (err) {
    console.error('[submit-demo-request] Owner email failed:', err.message);
  }

  // Send user confirmation email
  try {
    await sendResendEmail({
      from: fromEmail,
      to: email,
      subject: `Your ${businessName} Lead Dashboard is ready`,
      html: buildUserConfirmationHtml({ firstName, businessName }),
    });
  } catch (err) {
    console.error('[submit-demo-request] User confirmation email failed:', err.message);
  }

  // Send SMS if consented
  if (smsConsent && phone) {
    const smsBody = `Hi ${firstName}, your FlowDesk Pro Lead Manager demo is confirmed. Your ${businessName} branded dashboard is ready. Check your email for access details.`;
    const smsResult = await sendSms(phone, smsBody);
    console.log('[submit-demo-request] SMS result:', smsResult);
  }

  return json(200, {
    ok: true,
    lead_id: leadId,
    business_name: businessName,
    redirect: `/dashboard?business_name=${encodeURIComponent(businessName)}${leadId ? `&lead_id=${leadId}` : ''}`,
  });
};
