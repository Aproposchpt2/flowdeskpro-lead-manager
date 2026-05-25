'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — Twilio voice intake webhook
 * Creates a voice lead in lead_manager_records and updates it when the
 * Twilio transcription callback arrives.
 */

const {
  json,
  safeString,
  nowIso,
  escapeHtml,
  escapeXml,
  formatPhone,
  getServerConfig,
  parseEventBody,
  supabaseRequest,
  sendResendEmail,
  buildLeadDashboardUrl,
} = require('./config');

function xml(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/xml',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body,
  };
}

function buildBaseUrl(event) {
  const config = getServerConfig();
  if (config.siteUrl) return config.siteUrl;
  const host = event.headers?.host || event.headers?.Host || '';
  if (!host) return '';
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function buildGreetingTwiML(event) {
  const config = getServerConfig();
  const baseUrl = buildBaseUrl(event);
  const brand = escapeXml(config.clientBrandName || config.clientName || 'FlowDesk Pro');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    Thank you for calling ${brand}. There is no one available to take your call at this time.
    Please leave your name, phone number, and the reason for your call after the tone.
    Press pound when you are finished.
  </Say>
  <Record
    action="${escapeXml(baseUrl)}/.netlify/functions/lead-manager?action=got_message"
    method="POST"
    maxLength="90"
    timeout="8"
    transcribe="true"
    transcribeCallback="${escapeXml(baseUrl)}/.netlify/functions/lead-manager?action=transcribe_message"
    playBeep="true"
    finishOnKey="#"
  />
  <Say voice="Polly.Joanna" language="en-US">
    We did not receive your message. Please call back and try again. Goodbye.
  </Say>
  <Hangup/>
</Response>`;
}

function buildConfirmTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    Thank you. Your message has been received and a team member will return your call shortly.
    Goodbye.
  </Say>
  <Hangup/>
</Response>`;
}

function fallbackEmail(callSid) {
  const safeSid = safeString(callSid || `call-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  return `voice-${safeSid}@leadmanager.flowdesk.local`;
}

function generateVoiceSummary(callerNumber) {
  const formatted = formatPhone(callerNumber) || 'Unknown caller';
  return `Inbound voice lead received from ${formatted}. Awaiting call transcription.`;
}

async function sendVoiceAlert(record) {
  const config = getServerConfig();
  if (!config.resendTo) return { skipped: true, reason: 'No notification recipient configured.' };

  const dashboardUrl = buildLeadDashboardUrl(record.id || '');
  const caller = formatPhone(record.phone) || record.phone || 'Unknown caller';
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;background:#06101f;color:#f5f8ff;padding:28px;border-radius:20px;max-width:660px;margin:0 auto;border:1px solid rgba(91,211,255,.24);">
    <div style="color:#5BD3FF;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:900;margin-bottom:14px;">FlowDesk Pro Voice Intake</div>
    <h1 style="margin:0 0 10px;color:#ffffff;font-size:24px;">New voice lead received</h1>
    <p style="line-height:1.75;color:#c9d6e5;margin:0 0 16px;">An inbound call entered the ${escapeHtml(config.clientBrandName)} Lead Manager.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;">
      <tr><td style="padding:9px;color:#90A3BC;width:150px;">Caller</td><td style="padding:9px;color:#ffffff;font-weight:800;">${escapeHtml(caller)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Status</td><td style="padding:9px;color:#ffffff;">${escapeHtml(record.lead_status)}</td></tr>
      <tr><td style="padding:9px;color:#90A3BC;">Call SID</td><td style="padding:9px;color:#5BD3FF;">${escapeHtml(record.call_sid || '')}</td></tr>
    </table>
    ${dashboardUrl ? `<a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:linear-gradient(135deg,#F5F8FF,#5BD3FF,#1EA7FF);color:#03101f;font-weight:900;text-decoration:none;border-radius:12px;padding:13px 20px;">Open Voice Lead →</a>` : ''}
  </div>`;

  const text = [
    'FlowDesk Pro Lead Manager — New Voice Lead',
    '',
    `Caller: ${caller}`,
    `Status: ${record.lead_status}`,
    `Call SID: ${record.call_sid || ''}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : '',
  ].filter(Boolean).join('\n');

  return sendResendEmail({
    to: config.resendTo,
    subject: `New Voice Lead — ${caller}`,
    html,
    text,
  });
}

async function createInitialVoiceLead(body) {
  const config = getServerConfig();
  const callSid = safeString(body.CallSid || body.CallSidParent || `manual-${Date.now()}`);
  const callerNumber = safeString(body.From || body.Caller || body.CalledFrom || 'Unknown');
  const formattedCaller = formatPhone(callerNumber) || callerNumber || 'Unknown caller';

  const record = {
    created_at: nowIso(),
    updated_at: nowIso(),
    tenant_id: config.tenantId,
    client_name: config.clientName,
    business_name: config.clientBrandName,
    contact_name: `Voice Lead — ${formattedCaller}`,
    first_name: 'Voice',
    last_name: 'Lead',
    email: fallbackEmail(callSid),
    phone: callerNumber,
    company: '',
    source: 'voice',
    source_page: 'twilio_voice',
    lead_status: 'New / Priority Review',
    urgency: 'High',
    service_needed: 'Voice lead — transcription pending',
    category: 'AI Voice Intake',
    preferred_contact_method: 'Phone',
    preferred_callback_time: 'As soon as possible',
    message: 'Inbound call received. Awaiting voice transcription.',
    details: 'Inbound call received. Awaiting voice transcription.',
    ai_summary: generateVoiceSummary(callerNumber),
    next_action: `Return call to ${formattedCaller}.`,
    internal_notes: `Twilio Call SID: ${callSid}`,
    follow_up_needed: true,
    assigned_to: '',
    customer_status_message: '',
    last_customer_update_at: null,
    call_sid: callSid,
    metadata: {
      channel: 'voice',
      provider: 'twilio',
      call_sid: callSid,
      from: callerNumber,
      to: safeString(body.To || body.Called),
      call_status: safeString(body.CallStatus),
      direction: safeString(body.Direction),
      received_at: nowIso(),
    },
  };

  const inserted = await supabaseRequest('POST', config.tableName, record, {
    prefer: 'return=representation',
  });

  const insertedRecord = Array.isArray(inserted) && inserted.length ? inserted[0] : record;

  try {
    await sendVoiceAlert(insertedRecord);
  } catch (error) {
    console.error('lead-manager voice alert error:', error.message);
  }

  return insertedRecord;
}

function deriveLikelyName(transcription, fallback) {
  const text = safeString(transcription);
  if (!text) return fallback;
  const cleaned = text
    .replace(/^(hi|hello|hey)[, ]+/i, '')
    .replace(/^(this is|my name is|i am|i'm)[ ]+/i, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 2);
  if (!words.length) return fallback;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

async function updateLeadTranscription(body) {
  const config = getServerConfig();
  const callSid = safeString(body.CallSid || body.CallSidParent || body.RecordingSid);
  const transcription = safeString(body.TranscriptionText || body.transcription || '');
  const recordingUrl = safeString(body.RecordingUrl || '');
  const recordingDuration = safeString(body.RecordingDuration || '');

  if (!callSid || !transcription) return null;

  const likelyName = deriveLikelyName(transcription, 'Voice Lead');

  const params = new URLSearchParams();
  params.set('call_sid', `eq.${callSid}`);
  params.set('tenant_id', `eq.${config.tenantId}`);

  const patch = {
    updated_at: nowIso(),
    contact_name: likelyName,
    details: transcription,
    message: transcription,
    service_needed: transcription.length > 180 ? `${transcription.slice(0, 177)}...` : transcription,
    ai_summary: `Caller said: "${transcription}"`,
    next_action: 'Review transcription and return the call.',
    internal_notes: `Twilio Call SID: ${callSid}${recordingUrl ? `\nRecording URL: ${recordingUrl}` : ''}${recordingDuration ? `\nRecording duration: ${recordingDuration}s` : ''}`,
    metadata: {
      channel: 'voice',
      provider: 'twilio',
      call_sid: callSid,
      recording_url: recordingUrl,
      recording_duration: recordingDuration,
      transcription_received_at: nowIso(),
    },
  };

  const updated = await supabaseRequest('PATCH', `${config.tableName}?${params.toString()}`, patch, {
    prefer: 'return=representation',
  });

  return Array.isArray(updated) && updated.length ? updated[0] : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (!['GET', 'POST'].includes(event.httpMethod)) return xml(405, '<Response></Response>');

  const qs = event.queryStringParameters || {};
  const action = safeString(qs.action || 'menu');

  let body = {};
  try {
    body = await parseEventBody(event);
  } catch (error) {
    console.error('lead-manager parse error:', error.message);
  }

  try {
    if (action === 'menu') {
      await createInitialVoiceLead(body);
      return xml(200, buildGreetingTwiML(event));
    }

    if (action === 'got_message') {
      return xml(200, buildConfirmTwiML());
    }

    if (action === 'transcribe_message') {
      await updateLeadTranscription(body);
      return xml(200, '<Response></Response>');
    }

    return xml(200, buildGreetingTwiML(event));
  } catch (error) {
    console.error('lead-manager error:', error.message);
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    We are sorry, but we could not process your message right now. Please call back shortly. Goodbye.
  </Say>
  <Hangup/>
</Response>`);
  }
};
