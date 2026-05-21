const xmlHeaders = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: xmlHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return twiml('<Response><Say voice="alice">Method not allowed.</Say></Response>');
  }

  const params = parseBody(event);
  const speech = clean(params.get('SpeechResult'));
  const from = clean(params.get('From') || params.get('Caller'));
  const to = clean(params.get('To') || params.get('Called'));
  const callSid = clean(params.get('CallSid'));
  const confidence = clean(params.get('Confidence'));

  const demoProfile = await lookupDemoProfileByPhone(from);

  const fullName =
    extractCallerName(speech) ||
    clean(demoProfile?.contact_name) ||
    (from ? `Voice caller ${from}` : 'Voice caller');

  const businessName =
    clean(demoProfile?.business_name) ||
    extractBusinessName(speech) ||
    (from ? `Voice call from ${from}` : 'AI Voice Attendant Call');

  const intakeUrgency = inferIntakeUrgency(speech);
  const leadUrgency = toLeadUrgency(intakeUrgency);
  const intent = speech || 'AI Voice Attendant call captured. Caller did not provide speech details.';
  const demoRef = clean(demoProfile?.ref_slug);

  const intakeRecord = {
    intake_id: uniqueId('fd-voice', callSid || from),
    created_at: new Date().toISOString(),
    full_name: fullName,
    email: phoneEmail(from, callSid),
    phone: from,
    business_name: businessName,
    industry: clean(demoProfile?.industry) || 'Voice Intake',
    request_type: 'AI Voice Attendant Call',
    service_needed: intent,
    urgency: intakeUrgency,
    preferred_contact_method: 'Phone Call',
    preferred_callback_time: intakeUrgency === 'Urgent' || intakeUrgency === 'Time-sensitive' ? 'As soon as possible' : 'Next available business window',
    sms_consent: false,
    sms_consent_text: '',
    details: intent,
    notes: [
      'AI Voice Attendant private demo call record.',
      `CallSid: ${callSid || 'not provided'}.`,
      `From: ${from || 'not provided'}.`,
      `To: ${to || 'not provided'}.`,
      `Speech confidence: ${confidence || 'not provided'}.`,
      demoRef ? `Demo ref: ${demoRef}.` : ''
    ].filter(Boolean).join(' '),
    ai_summary: buildSummary({ speech: intent, from, businessName, fullName, urgency: intakeUrgency }),
    category: 'AI Voice Attendant',
    lead_status: intakeUrgency === 'Urgent' || intakeUrgency === 'Time-sensitive' ? 'New / Priority Review' : 'New / Needs Review',
    follow_up_needed: true,
    next_action: from ? `Review AI Voice Attendant call record and call back ${from}.` : 'Review AI Voice Attendant call record and follow up.',
    source_page: 'ai_voice_attendant'
  };

  const leadRecord = {
    lead_id: uniqueId('FD', callSid || from),
    caller_phone: from,
    caller_name: fullName,
    full_name: fullName,
    summary: intent,
    intent,
    urgency: leadUrgency,
    industry: clean(demoProfile?.industry) || 'other',
    transcript: intent,
    language: 'en',
    call_sid: callSid,
    is_demo: true,
    demo_ref: demoRef || 'direct',
    created_at: new Date().toISOString()
  };

  console.log('AI Voice Attendant private demo record prepared', {
    callSid,
    from,
    businessName,
    fullName,
    demoRef: leadRecord.demo_ref,
    intakeUrgency,
    leadUrgency
  });

  const intakeSave = await insertRecord('flowdesk_intake_records', intakeRecord);
  if (!intakeSave.ok) {
    console.error('flowdesk_intake_records save failed:', intakeSave);
  }

  const leadSave = await insertRecord('leads', leadRecord);
  if (!leadSave.ok) {
    console.error('leads demo dashboard save failed:', leadSave);
  }

  if (!intakeSave.ok && !leadSave.ok) {
    return twiml(`
      <Response>
        <Say voice="alice">
          Thank you. Your request was received, but the dashboard record could not be saved automatically. A team member should review the call log.
        </Say>
      </Response>
    `);
  }

  sendVoiceNotification({
    ...intakeRecord,
    demo_ref: leadRecord.demo_ref
  }).catch((error) => {
    console.error('Voice notification failed:', error.message);
  });

  return twiml(`
    <Response>
      <Say voice="alice">
        Thank you. Your information has been captured and prepared for follow up. Goodbye.
      </Say>
    </Response>
  `);
};

async function insertRecord(tableName, record) {
  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseUrl || !serviceKey) {
    return { ok: false, status: 500, data: { error: 'Supabase environment variables are not configured.' } };
  }

  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(record)
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  return { ok: response.ok, status: response.status, data };
}

async function lookupDemoProfileByPhone(phone) {
  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceKey || !phone) return null;

  const digits = String(phone || '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (!last10) return null;

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/demo_requests?phone=ilike.*${encodeURIComponent(last10)}&select=business_name,contact_name,phone,industry,ref_slug,created_at&order=created_at.desc&limit=1`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(data) || !data.length) return null;
    return data[0];
  } catch (error) {
    console.error('Demo profile lookup failed:', error.message);
    return null;
  }
}

async function sendVoiceNotification(record) {
  const apiKey = clean(process.env.RESEND_API_KEY);
  const fromEmail = clean(process.env.RESEND_FROM_EMAIL) || 'FlowDesk Pro <notifications@aiflowdeskpro.com>';
  const toEmail = clean(process.env.RESEND_TO_EMAIL);

  if (!apiKey || !toEmail) return { ok: false, skipped: true };

  const subject = `FlowDesk AI Voice Call: ${record.business_name || record.phone || 'New call'}`;
  const text = [
    'New FlowDesk Pro AI Voice Attendant record captured',
    '',
    `Business: ${record.business_name || 'Not provided'}`,
    `Caller: ${record.full_name || 'Not provided'}`,
    `Phone: ${record.phone || 'Not provided'}`,
    `Urgency: ${record.urgency || 'Not provided'}`,
    `Demo Ref: ${record.demo_ref || 'Not provided'}`,
    '',
    `Summary: ${record.ai_summary || 'Not provided'}`,
    '',
    `Details: ${record.details || 'Not provided'}`,
    '',
    `Next action: ${record.next_action || 'Not provided'}`
  ].join('\n');

  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
    <h2>FlowDesk Pro AI Voice Attendant Record</h2>
    <p><strong>Business:</strong> ${escapeHtml(record.business_name || 'Not provided')}</p>
    <p><strong>Caller:</strong> ${escapeHtml(record.full_name || 'Not provided')}</p>
    <p><strong>Phone:</strong> ${escapeHtml(record.phone || 'Not provided')}</p>
    <p><strong>Urgency:</strong> ${escapeHtml(record.urgency || 'Not provided')}</p>
    <p><strong>Demo Ref:</strong> ${escapeHtml(record.demo_ref || 'Not provided')}</p>
    <p><strong>Summary:</strong> ${escapeHtml(record.ai_summary || 'Not provided')}</p>
    <p><strong>Details:</strong> ${escapeHtml(record.details || 'Not provided')}</p>
    <p><strong>Next Action:</strong> ${escapeHtml(record.next_action || 'Not provided')}</p>
  </div>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: String(toEmail).split(',').map((email) => email.trim()).filter(Boolean),
      subject,
      html,
      text
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error('Resend voice notification error:', response.status, responseText);
    return { ok: false, status: response.status, data: responseText };
  }

  return { ok: true };
}

function parseBody(event) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
  if (contentType.includes('application/json')) {
    try {
      const body = JSON.parse(event.body || '{}');
      return new URLSearchParams(Object.entries(body));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(event.body || '');
}

function inferIntakeUrgency(text) {
  const value = String(text || '').toLowerCase();
  if (/emergency|urgent|as soon as possible|asap|immediately|right away|critical/.test(value)) return 'Urgent';
  if (/today|time sensitive|this week|soon|missed call|after hours|appointment/.test(value)) return 'Time-sensitive';
  if (/whenever|not urgent|low priority/.test(value)) return 'Low';
  return 'Normal';
}

function toLeadUrgency(value) {
  if (value === 'Urgent') return 'high';
  if (value === 'Time-sensitive') return 'medium';
  if (value === 'Low') return 'low';
  return 'medium';
}

function buildSummary({ speech, from, businessName, fullName, urgency }) {
  return `AI Voice Attendant captured a ${urgency} call record for ${businessName || 'unknown business'} from ${fullName || from || 'unknown caller'}. Caller request: ${speech || 'No request details captured.'}`;
}

function extractBusinessName(speech) {
  const text = clean(speech);
  const match = text.match(/(?:business name is|company name is|from|with)\s+([a-z0-9&' .-]{2,60})/i);
  return match && match[1] ? clean(match[1]).replace(/[.?!]+$/, '') : '';
}

function extractCallerName(speech) {
  const text = clean(speech);
  const patterns = [
    /(?:my name is|this is|i am|i'm)\s+([a-z' .-]{2,60})/i,
    /^([a-z' .-]{2,60})(?:,|\s+and\s+|\s+i\s+|\s+calling\s+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return clean(match[1]).replace(/[.?!]+$/, '');
  }

  return '';
}

function phoneEmail(phone, fallback) {
  const digits = String(phone || '').replace(/\D/g, '');
  const suffix = digits || String(fallback || Date.now()).replace(/\W/g, '').toLowerCase();
  return `voice-${suffix}@flowdesk.local`;
}

function uniqueId(prefix, value) {
  const cleanValue = String(value || Date.now()).replace(/\W/g, '').toLowerCase();
  return `${prefix}-${cleanValue.slice(-18)}`;
}

function twiml(body) {
  return { statusCode: 200, headers: xmlHeaders, body: body.replace(/^\s+/gm, '').trim() };
}

function clean(value) { return String(value || '').trim(); }

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
