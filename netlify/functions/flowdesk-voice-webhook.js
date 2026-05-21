const xmlHeaders = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: xmlHeaders, body: '' };
  }

  const params = parseBody(event);
  const callerPhone = clean(params.get('From') || params.get('Caller'));
  const callSid = clean(params.get('CallSid'));

  const demoProfile = await lookupDemoProfileByPhone(callerPhone);
  const businessName =
    clean(demoProfile?.business_name) ||
    clean(process.env.FLOWDESK_DEMO_BUSINESS_NAME) ||
    'FlowDesk Pro';

  const voiceName = clean(process.env.FLOWDESK_TWILIO_VOICE) || 'Polly.Joanna';
  const businessNameForSpeech = makeBusinessNameSpeakable(businessName);
  const actionUrl = absoluteUrl(event, '/.netlify/functions/flowdesk-voice-intake');

  console.log('AI Voice Attendant webhook received', {
    callerPhone,
    callSid,
    businessName,
    businessNameForSpeech,
    demoRef: demoProfile?.ref_slug || null,
    matchedDemoProfile: Boolean(demoProfile)
  });

  return twiml(`
    <Response>
      <Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="9">
        <Say voice="${escapeXml(voiceName)}">Thank you for calling.</Say>
        <Pause length="1"/>
        <Say voice="${escapeXml(voiceName)}">You have reached ${escapeXml(businessNameForSpeech)}.</Say>
        <Pause length="1"/>
        <Say voice="${escapeXml(voiceName)}">Please say your first and last name, then briefly tell me the reason for your call.</Say>
      </Gather>
      <Say voice="${escapeXml(voiceName)}">
        We did not receive the request details. Please call back or submit the web demo form. Goodbye.
      </Say>
    </Response>
  `);
};

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

function absoluteUrl(event, path) {
  const configured = clean(process.env.FLOWDESK_SITE_URL).replace(/\/$/, '');
  if (configured) return `${configured}${path}`;

  const host = event.headers.host || event.headers.Host || '';
  return host ? `https://${host}${path}` : path;
}

function twiml(body) {
  return {
    statusCode: 200,
    headers: xmlHeaders,
    body: body.replace(/^\s+/gm, '').trim()
  };
}

function clean(value) {
  return String(value || '').trim();
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeBusinessNameSpeakable(name) {
  return clean(name)
    .replace(/&/g, ' and ')
    .replace(/\bLLC\b/gi, 'L. L. C.')
    .replace(/\bL\.L\.C\.\b/gi, 'L. L. C.')
    .replace(/\bINC\b/gi, 'Incorporated')
    .replace(/\bCO\b/gi, 'Company')
    .replace(/\bLTD\b/gi, 'Limited')
    .replace(/\bAI4\b/gi, 'A. I. 4')
    .replace(/\bAI\b/g, 'A. I.')
    .replace(/\s+/g, ' ')
    .trim();
}
