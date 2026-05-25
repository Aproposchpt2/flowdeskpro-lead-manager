'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — email-lead
 * Sends a controlled follow-up/status email to a lead through Resend.
 */

const {
  json,
  safeString,
  isValidEmail,
  escapeHtml,
  getServerConfig,
  parseEventBody,
  supabaseRequest,
  sendResendEmail,
  leadName,
  leadBusiness,
  nowIso,
} = require('./config');

async function fetchLeadById(id, tenantId) {
  const config = getServerConfig();
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('id', `eq.${id}`);
  if (tenantId) params.set('tenant_id', `eq.${tenantId}`);
  params.set('limit', '1');

  const result = await supabaseRequest('GET', `${config.tableName}?${params.toString()}`, null, {
    prefer: '',
  });

  return Array.isArray(result) && result.length ? result[0] : null;
}

function buildFollowUpEmail(record, message) {
  const config = getServerConfig();
  const name = leadName(record);
  const firstName = name && name !== 'Unknown Contact' ? name.split(/\s+/)[0] : '';
  const brand = config.clientBrandName;
  const service = safeString(record.service_needed || record.category || 'your request');

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#06101f;color:#f5f8ff;padding:28px;border-radius:20px;max-width:640px;margin:0 auto;border:1px solid rgba(91,211,255,.24);">
    <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:900;margin-bottom:14px;">${escapeHtml(brand)}</div>
    <h1 style="margin:0 0 10px;color:#ffffff;font-size:24px;">Update on your request</h1>
    <p style="line-height:1.75;color:#c9d6e5;margin:0 0 14px;">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
    <p style="line-height:1.75;color:#c9d6e5;margin:0 0 16px;">${escapeHtml(message)}</p>
    <div style="background:#0d2037;border:1px solid rgba(91,211,255,.24);border-radius:16px;padding:16px;margin:18px 0;">
      <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Request</div>
      <div style="line-height:1.75;color:#d8e7f8;">${escapeHtml(service)}</div>
    </div>
    <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Powered by FlowDesk Pro Lead Manager.</p>
  </div>`;

  const text = [
    `Update from ${brand}`,
    '',
    firstName ? `Hi ${firstName},` : 'Hi,',
    message,
    '',
    `Request: ${service}`,
    '',
    'Powered by FlowDesk Pro Lead Manager.',
  ].join('\n');

  return {
    to: record.email,
    subject: `Update from ${brand}`,
    html,
    text,
    replyTo: config.resendTo || undefined,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  let body;
  try {
    body = await parseEventBody(event);
  } catch (error) {
    return json(400, { ok: false, error: error.message });
  }

  try {
    const config = getServerConfig();
    const tenantId = safeString(body.tenant_id || config.tenantId);
    const id = safeString(body.id || body.record_id || body.lead?.id);
    let record = body.lead && typeof body.lead === 'object' ? body.lead : null;

    if (!record && id) record = await fetchLeadById(id, tenantId);

    if (!record) {
      return json(404, { ok: false, error: 'Lead record was not found.' });
    }

    const email = safeString(record.email);
    if (!isValidEmail(email)) {
      return json(400, { ok: false, error: 'Lead record does not have a valid email address.' });
    }

    const message = safeString(
      body.message ||
      body.customer_status_message ||
      record.customer_status_message ||
      `Thank you for contacting ${config.clientBrandName}. We reviewed your request and will follow up with next steps.`
    );

    await sendResendEmail(buildFollowUpEmail(record, message));

    let updatedRecord = record;
    if (record.id) {
      const params = new URLSearchParams();
      params.set('id', `eq.${record.id}`);
      if (tenantId) params.set('tenant_id', `eq.${tenantId}`);

      const patch = {
        customer_status_message: message,
        last_customer_update_at: nowIso(),
        lead_status: safeString(body.lead_status || record.lead_status || 'Contacted'),
        updated_at: nowIso(),
      };

      const updated = await supabaseRequest('PATCH', `${config.tableName}?${params.toString()}`, patch, {
        prefer: 'return=representation',
      });
      updatedRecord = Array.isArray(updated) && updated.length ? updated[0] : record;
    }

    return json(200, {
      ok: true,
      message: 'Lead email sent successfully.',
      email,
      business: leadBusiness(record),
      record: updatedRecord,
    });
  } catch (error) {
    console.error('email-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to send lead email right now.' });
  }
};
