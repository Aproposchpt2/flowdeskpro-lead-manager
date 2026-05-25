'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — submit-lead
 * Public intake endpoint. Validates a lead, writes to Supabase through REST,
 * and sends internal/customer notifications through Resend when configured.
 */

const {
  json,
  safeString,
  normalizeEmail,
  isValidEmail,
  nowIso,
  escapeHtml,
  getServerConfig,
  parseEventBody,
  supabaseRequest,
  sendResendEmail,
  buildLeadDashboardUrl,
} = require('./config');

function splitName(fullName) {
  const parts = safeString(fullName).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function buildRecord(body, event) {
  const config = getServerConfig();
  const contactName = safeString(body.contact_name || body.full_name || body.name);
  const split = splitName(contactName);
  const email = normalizeEmail(body.email);
  const businessName = safeString(
    body.business_name ||
    body.company ||
    body.organization ||
    body.business ||
    config.clientBrandName
  );

  const referrer = safeString(event.headers?.referer || event.headers?.referrer || body.source_page);
  const sourceUrl = safeString(body.source_url || body.source_page || referrer);

  return {
    created_at: nowIso(),
    updated_at: nowIso(),
    tenant_id: safeString(body.tenant_id || config.tenantId),
    client_name: safeString(body.client_name || config.clientName),
    business_name: businessName,
    contact_name: contactName,
    first_name: safeString(body.first_name || split.firstName),
    last_name: safeString(body.last_name || split.lastName),
    email,
    phone: safeString(body.phone),
    company: safeString(body.company || body.organization || businessName),
    source: safeString(body.source || 'web_intake'),
    source_page: sourceUrl || 'intake.html',
    lead_status: safeString(body.lead_status || 'New / Needs Review'),
    urgency: safeString(body.urgency || 'Normal'),
    service_needed: safeString(body.service_needed || body.service || body.request_type),
    category: safeString(body.category),
    preferred_contact_method: safeString(body.preferred_contact_method || 'Email or phone'),
    preferred_callback_time: safeString(body.preferred_callback_time || body.callback_time),
    message: safeString(body.message || body.details),
    details: safeString(body.details || body.message),
    ai_summary: safeString(body.ai_summary),
    next_action: safeString(body.next_action || 'Review the new lead and decide the next follow-up step.'),
    internal_notes: safeString(body.internal_notes),
    follow_up_needed: body.follow_up_needed === undefined ? true : Boolean(body.follow_up_needed),
    assigned_to: safeString(body.assigned_to),
    customer_status_message: '',
    last_customer_update_at: null,
    appointment_requested: Boolean(body.appointment_requested),
    appointment_status: safeString(body.appointment_status),
    metadata: {
      intake_version: 'v1-platinum',
      user_agent: safeString(event.headers?.['user-agent'] || event.headers?.['User-Agent']),
      referrer,
      form_context: safeString(body.form_context || 'public_intake'),
      submitted_at: nowIso(),
    },
  };
}

function buildInternalNotification(record, insertedRecord) {
  const config = getServerConfig();
  const dashboardUrl = buildLeadDashboardUrl(insertedRecord?.id || '');
  const subject = `New Lead — ${record.business_name} — ${record.contact_name}`;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#06101f;color:#f5f8ff;padding:28px;border-radius:20px;max-width:680px;margin:0 auto;border:1px solid rgba(91,211,255,.24);">
    <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:900;margin-bottom:14px;">FlowDesk Pro Lead Manager</div>
    <h1 style="margin:0 0 10px;color:#ffffff;font-size:24px;">New lead received</h1>
    <p style="line-height:1.7;color:#c9d6e5;margin:0 0 18px;">A new lead entered the ${escapeHtml(config.clientBrandName)} command center.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;">
      <tr><td style="padding:9px;color:#90A3BC;width:170px;">Business</td><td style="padding:9px;color:#ffffff;font-weight:800;">${escapeHtml(record.business_name)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Contact</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.contact_name)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Email</td><td style="padding:9px;color:#5BD3FF;">${escapeHtml(record.email)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Phone</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.phone || 'Not provided')}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Service</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.service_needed || 'Not provided')}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Urgency</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.urgency)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Preferred Contact</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.preferred_contact_method || 'Not provided')}</td></tr>
    </table>
    <div style="background:#0d2037;border:1px solid rgba(91,211,255,.24);border-radius:16px;padding:16px;margin:18px 0;">
      <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Message</div>
      <div style="line-height:1.75;color:#d8e7f8;">${escapeHtml(record.message || 'No message provided.')}</div>
    </div>
    ${dashboardUrl ? `<a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:linear-gradient(135deg,#F5F8FF,#5BD3FF,#1EA7FF);color:#03101f;font-weight:900;text-decoration:none;border-radius:12px;padding:13px 20px;">Open Lead Record →</a>` : ''}
    <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Record ID: ${escapeHtml(insertedRecord?.id || '')}</p>
  </div>`;

  const text = [
    'FlowDesk Pro Lead Manager — New Lead Received',
    '',
    `Business: ${record.business_name}`,
    `Contact: ${record.contact_name}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Service: ${record.service_needed || 'Not provided'}`,
    `Urgency: ${record.urgency}`,
    `Preferred Contact: ${record.preferred_contact_method || 'Not provided'}`,
    '',
    `Message: ${record.message || 'No message provided.'}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : '',
  ].filter(Boolean).join('\n');

  return {
    to: config.resendTo,
    subject,
    html,
    text,
    replyTo: record.email,
  };
}

function buildCustomerConfirmation(record) {
  const config = getServerConfig();
  const firstName = record.first_name || (record.contact_name ? record.contact_name.split(/\s+/)[0] : '');
  const brand = config.clientBrandName;

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#06101f;color:#f5f8ff;padding:28px;border-radius:20px;max-width:640px;margin:0 auto;border:1px solid rgba(91,211,255,.24);">
    <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:900;margin-bottom:14px;">${escapeHtml(brand)}</div>
    <h1 style="margin:0 0 10px;color:#ffffff;font-size:24px;">We received your request</h1>
    <p style="line-height:1.75;color:#c9d6e5;margin:0 0 14px;">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
    <p style="line-height:1.75;color:#c9d6e5;margin:0 0 16px;">Thank you for contacting ${escapeHtml(brand)}. Your request has been received and will be reviewed for follow-up.</p>
    <div style="background:#0d2037;border:1px solid rgba(91,211,255,.24);border-radius:16px;padding:16px;margin:18px 0;">
      <div style="font-size:12px;color:#90A3BC;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;">Request Summary</div>
      <div style="line-height:1.75;color:#d8e7f8;">${escapeHtml(record.service_needed || record.message || 'General inquiry')}</div>
    </div>
    <p style="font-size:12px;line-height:1.6;color:#90A3BC;margin-top:22px;">Powered by FlowDesk Pro Lead Manager.</p>
  </div>`;

  const text = [
    `We received your request — ${brand}`,
    '',
    firstName ? `Hi ${firstName},` : 'Hi,',
    `Thank you for contacting ${brand}. Your request has been received and will be reviewed for follow-up.`,
    '',
    `Request summary: ${record.service_needed || record.message || 'General inquiry'}`,
    '',
    'Powered by FlowDesk Pro Lead Manager.',
  ].join('\n');

  return {
    to: record.email,
    subject: `Request received — ${brand}`,
    html,
    text,
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

  const record = buildRecord(body, event);

  if (!record.contact_name) {
    return json(400, { ok: false, error: 'Contact name is required.' });
  }

  if (!isValidEmail(record.email)) {
    return json(400, { ok: false, error: 'A valid email address is required.' });
  }

  if (!record.message && !record.service_needed) {
    return json(400, { ok: false, error: 'Please include a message or service needed.' });
  }

  try {
    const config = getServerConfig();
    const inserted = await supabaseRequest('POST', config.tableName, record, {
      prefer: 'return=representation',
    });
    const insertedRecord = Array.isArray(inserted) && inserted.length ? inserted[0] : null;

    let internalEmailSent = false;
    let customerEmailSent = false;

    try {
      if (config.resendTo) {
        await sendResendEmail(buildInternalNotification(record, insertedRecord));
        internalEmailSent = true;
      }
    } catch (error) {
      console.error('submit-lead internal email error:', error.message);
    }

    try {
      if (record.email && body.send_customer_confirmation !== false) {
        await sendResendEmail(buildCustomerConfirmation(record));
        customerEmailSent = true;
      }
    } catch (error) {
      console.error('submit-lead customer email error:', error.message);
    }

    return json(200, {
      ok: true,
      message: 'Lead submitted successfully.',
      record: insertedRecord,
      record_id: insertedRecord?.id || null,
      internal_email_sent: internalEmailSent,
      customer_email_sent: customerEmailSent,
    });
  } catch (error) {
    console.error('submit-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to submit lead right now.' });
  }
};
