'use strict';

/**
 * FlowDesk Pro — Email Lead
 * netlify/functions/flowdesk-email-lead.js
 *
 * Sends a follow-up email to a lead using Resend.
 * Accepts: { lead: { email, full_name, customer_name, ... } }
 */

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function clean(v) { return String(v || '').trim(); }

function safeName(lead) {
  return clean(lead.full_name || lead.customer_name || lead.name) || 'there';
}

function buildEmailHtml(lead) {
  const name = safeName(lead);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:32px 16px;">
  <tr>
    <td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#0d1117;padding:20px 28px;">
            <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;padding:4px 10px;border-radius:4px;">fd</span>
            <span style="color:#8b949e;font-size:13px;margin-left:10px;">FlowDesk Pro</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px;">
            <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#24292f;">Hi ${name},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#57606a;line-height:1.65;">
              Thank you for reaching out. A member of our team has reviewed your inquiry and we want
              to make sure we connect with you as quickly as possible.
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#57606a;line-height:1.65;">
              If you have any additional details or questions in the meantime, feel free to reply directly
              to this email — we're here to help.
            </p>
            <p style="margin:0;font-size:15px;color:#57606a;">— The FlowDesk Pro Team</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f6f8fa;border-top:1px solid #d0d7de;padding:16px 28px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#8b949e;letter-spacing:1px;">FLOWDESK PRO · APROPOS GROUP LLC</p>
            <p style="margin:4px 0 0;font-size:11px;color:#8b949e;">
              <a href="https://aiflowdeskpro.com" style="color:#2d9cdb;text-decoration:none;">aiflowdeskpro.com</a>
              &nbsp;·&nbsp;
              <a href="mailto:support@aiflowdeskpro.com" style="color:#8b949e;text-decoration:none;">support@aiflowdeskpro.com</a>
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { ok: false, error: 'Method not allowed' });
  }

  const apiKey    = clean(process.env.RESEND_API_KEY);
  const fromEmail = clean(process.env.RESEND_FROM_EMAIL) || 'FlowDesk Pro <support@aiflowdeskpro.com>';
  const replyTo   = clean(process.env.RESEND_TO_EMAIL)   || 'jmitchell@aiflowdeskpro.com';

  if (!apiKey) {
    return response(500, { ok: false, error: 'RESEND_API_KEY is not configured.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { ok: false, error: 'Invalid JSON body.' }); }

  const lead = body.lead || body;
  const toEmail = clean(lead.email);

  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return response(400, { ok: false, error: 'A valid lead email address is required.' });
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        replyTo: replyTo,
        subject: `Following up on your inquiry — FlowDesk Pro`,
        html: buildEmailHtml(lead),
        text: `Hi ${safeName(lead)},\n\nThank you for reaching out. Our team will follow up with you shortly.\n\n— The FlowDesk Pro Team\nsupport@aiflowdeskpro.com`,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('flowdesk-email-lead Resend error:', res.status, JSON.stringify(data));
      return response(res.status, { ok: false, error: data.message || 'Failed to send email.' });
    }

    console.log('flowdesk-email-lead sent to:', toEmail, JSON.stringify(data));
    return response(200, { ok: true, email: toEmail, id: data.id });
  } catch (err) {
    console.error('flowdesk-email-lead exception:', err.message);
    return response(500, { ok: false, error: 'Unexpected server error sending email.' });
  }
};

function response(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
