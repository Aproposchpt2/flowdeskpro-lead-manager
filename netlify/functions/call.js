/**
 * FlowDesk — Call Handler
 * netlify/functions/call.js
 *
 * WHAT IT DOES:
 *   1. Receives incoming call webhook from Twilio
 *   2. Answers with a professional AI greeting (TwiML)
 *   3. Records the caller's voice response
 *   4. Sends the recording to Claude AI for transcription + analysis
 *   5. Extracts: name, intent, urgency, industry from the conversation
 *   6. Writes lead record to Supabase (leads table)
 *   7. Writes call log to Supabase (call_logs table)
 *   8. Fires email alert via Resend
 *   9. Responds to caller with next steps
 *
 * ENV VARIABLES REQUIRED:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   ANTHROPIC_API_KEY
 *   RESEND_API_KEY
 *   RESEND_FROM_EMAIL
 *   RESEND_TO_EMAIL
 *   FLOWDESK_SITE_URL
 *   TWILIO_ALERT_PHONE
 *   SUPABASE_URL          <- NEW
 *   SUPABASE_SERVICE_KEY  <- NEW
 */

'use strict';

const { Resend } = require('resend');
const { Anthropic } = require('@anthropic-ai/sdk');
const https = require('https');

const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ---------------------------------------------
   CONSTANTS
--------------------------------------------- */
const GATHER_STEP    = 'gather';
const PROCESS_STEP   = 'process';
const FALLBACK_STEP  = 'fallback';
const SPEECH_TIMEOUT = 5;

/* ---------------------------------------------
   UTILITIES
--------------------------------------------- */
function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function generateLeadId() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FD-${ts}-${rnd}`;
}

function formatTimestamp() {
  return new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  }) + ' PT';
}

function normalizeUrgency(value) {
  const v = safeString(value).toLowerCase();
  if (['high', 'urgent', 'emergency', 'hot', 'critical', 'immediate', 'asap', 'right away', 'right now', 'today', 'tonight', 'now'].includes(v)) return 'high';
  if (['medium', 'normal', 'warm', 'soon', 'moderate'].includes(v)) return 'medium';
  if (['low', 'routine', 'cold', 'info', 'exploring'].includes(v)) return 'low';
  return 'medium';
}

function escapeXml(str) {
  return safeString(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ---------------------------------------------
   PARSE TWILIO FORM BODY
--------------------------------------------- */
function parseTwilioBody(body) {
  const params = {};
  if (!body) return params;
  body.split('&').forEach(pair => {
    const [key, val] = pair.split('=').map(decodeURIComponent);
    if (key) params[key.replace(/\+/g, ' ')] = (val || '').replace(/\+/g, ' ');
  });
  return params;
}

/* ---------------------------------------------
   SUPABASE — DATABASE WRITES
--------------------------------------------- */
async function supabaseInsert(table, record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error('SUPABASE: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return null;
  }

  const body = JSON.stringify(record);

  return new Promise((resolve) => {
    const urlObj = new URL(`${url}/rest/v1/${table}`);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${key}`,
        'apikey':         key,
        'Prefer':         'return=representation',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          console.log(`SUPABASE INSERT OK — ${table}`);
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          console.error(`SUPABASE INSERT FAILED — ${table} — ${res.statusCode}:`, data);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`SUPABASE REQUEST ERROR — ${table}:`, err.message);
      resolve(null);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      console.error(`SUPABASE TIMEOUT — ${table}`);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

/* ---------------------------------------------
   SUPABASE — LOOK UP CLIENT BY TWILIO NUMBER
--------------------------------------------- */
async function getClientIdByNumber(calledNumber) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key || !calledNumber) return null;

  // Normalize: strip whitespace, ensure E.164
  const normalized = calledNumber.replace(/\s+/g, '').trim();

  return new Promise((resolve) => {
    const path = `/rest/v1/clients?twilio_number=eq.${encodeURIComponent(normalized)}&status=eq.active&select=id&limit=1`;
    const urlObj = new URL(`${url}${path}`);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey':        key,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          if (Array.isArray(rows) && rows.length > 0) {
            console.log('CLIENT LOOKUP OK — id:', rows[0].id);
            resolve(rows[0].id);
          } else {
            console.warn('CLIENT LOOKUP: no match for number', normalized);
            resolve(null);
          }
        } catch (e) {
          console.error('CLIENT LOOKUP PARSE ERROR:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('CLIENT LOOKUP REQUEST ERROR:', err.message);
      resolve(null);
    });

    req.setTimeout(4000, () => {
      req.destroy();
      console.error('CLIENT LOOKUP TIMEOUT');
      resolve(null);
    });

    req.end();
  });
}

/* ---------------------------------------------
   SUPABASE — LOOK UP DEMO REF BY CALLER PHONE
   Matches phone from demo_requests table
   so the ref travels from form → call → dashboard
--------------------------------------------- */
async function getDemoRefByPhone(callerPhone) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key || !callerPhone) return null;

  // Normalize phone — strip non-digits
  const digits = callerPhone.replace(/\D/g, '');
  // Try last 10 digits for matching flexibility
  const last10 = digits.slice(-10);

  return new Promise((resolve) => {
    // Search for phone ending in last10 digits, most recent first
    const path = `/rest/v1/demo_requests?phone=ilike.*${last10}&order=created_at.desc&select=ref_slug&limit=1`;
    const urlObj = new URL(`${url}${path}`);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey':        key,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          if (Array.isArray(rows) && rows.length > 0) {
            console.log('DEMO REF LOOKUP OK — ref:', rows[0].ref_slug);
            resolve(rows[0].ref_slug);
          } else {
            console.log('DEMO REF LOOKUP: no match for phone', last10);
            resolve(null);
          }
        } catch (e) {
          console.error('DEMO REF PARSE ERROR:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('DEMO REF REQUEST ERROR:', err.message);
      resolve(null);
    });
    req.setTimeout(4000, () => {
      req.destroy();
      console.error('DEMO REF LOOKUP TIMEOUT');
      resolve(null);
    });
    req.end();
  });
}

async function writeLeadToSupabase(lead, callerPhone, calledNumber, transcript, callSid, clientId, isDemo, demoRef) {
  const record = {
    client_id:    clientId || null,
    lead_id:      lead.lead_id,
    caller_phone: callerPhone,
    caller_name:  lead.full_name,
    full_name:    lead.full_name,
    summary:      lead.intent,
    intent:       lead.intent,
    urgency:      lead.urgency,
    industry:     lead.industry,
    transcript:   transcript,
    language:     lead.language,
    call_sid:     callSid,
    is_demo:      isDemo === true,
    demo_ref:     isDemo ? (demoRef || 'direct') : null,
  };
  const result = await supabaseInsert('leads', record);
  if (result) console.log('LEAD SAVED TO SUPABASE:', lead.lead_id, '| demo:', isDemo === true, '| ref:', demoRef || 'direct');
  return result;
}

async function writeCallLogToSupabase(callSid, callerPhone, calledNumber, status, leadCreated, clientId, isDemo) {
  const record = {
    client_id:     clientId || null,
    call_sid:      callSid,
    twilio_call_sid: callSid,
    caller_phone:  callerPhone,
    called_number: calledNumber,
    call_status:   status,
    outcome:       status,
    lead_created:  leadCreated,
    is_demo:       isDemo === true,
  };
  const result = await supabaseInsert('call_logs', record);
  if (result) console.log('CALL LOG SAVED TO SUPABASE:', callSid, '| demo:', isDemo === true);
  return result;
}

/* ---------------------------------------------
   TWIML BUILDERS
--------------------------------------------- */
function buildGreetingTwiML(businessName = 'this business') {
  const greeting = `Thank you for calling ${businessName}. To get started, could I have your first and last name, and how can I help you today?`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="${SPEECH_TIMEOUT}" speechTimeout="auto"
          action="${safeString(process.env.FLOWDESK_SITE_URL, 'https://aiflowdeskpro.com')}/.netlify/functions/call?step=${PROCESS_STEP}"
          method="POST">
    <Say voice="Polly.Joanna" language="en-US">${escapeXml(greeting)}</Say>
  </Gather>
  <Redirect method="POST">${safeString(process.env.FLOWDESK_SITE_URL, 'https://aiflowdeskpro.com')}/.netlify/functions/call?step=${FALLBACK_STEP}</Redirect>
</Response>`;
}

function buildGreetingTwiMLSpanish(businessName = 'este negocio') {
  const greeting = `Gracias por llamar a ${businessName}. Para comenzar, puede decirme su nombre completo y en que le puedo ayudar hoy?`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="${SPEECH_TIMEOUT}" speechTimeout="auto" language="es-US"
          action="${safeString(process.env.FLOWDESK_SITE_URL, 'https://aiflowdeskpro.com')}/.netlify/functions/call?step=${PROCESS_STEP}&amp;lang=es"
          method="POST">
    <Say voice="Polly.Lupe" language="es-US">${escapeXml(greeting)}</Say>
  </Gather>
  <Redirect method="POST">${safeString(process.env.FLOWDESK_SITE_URL, 'https://aiflowdeskpro.com')}/.netlify/functions/call?step=${FALLBACK_STEP}</Redirect>
</Response>`;
}

function buildConfirmationTwiML(isUrgent = false) {
  const message = isUrgent
    ? `Thank you. I've flagged your request as urgent and someone from our team will be reaching out to you very shortly. We appreciate your call and we'll be in touch soon. Goodbye.`
    : `Thank you. I've captured your information and someone from our team will follow up with you shortly. We appreciate your call. Have a great day.`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

function buildFallbackTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">I'm sorry, I didn't catch that. Please call back and we'll be happy to assist you. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

/* ---------------------------------------------
   CLAUDE AI — LEAD EXTRACTION (using @anthropic-ai/sdk)
--------------------------------------------- */
async function extractLeadFromTranscript(transcript, callerPhone, language = 'en') {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not configured');
    return { full_name: 'Caller', intent: transcript, urgency: 'medium', industry: 'other', notes: transcript, language };
  }

  const systemPrompt = `You are FlowDesk, an AI intake specialist for small businesses.
Your job is to analyze a caller's spoken message and extract structured lead information.
CRITICAL: The caller was asked for their FULL NAME first. Always extract the full name from their response.
If they say "My name is John Smith" or "This is Sarah Jones" — capture that exactly.
If no name is clearly stated, use 'Caller' as the default.
Always respond with valid JSON only. No explanation. No markdown. Just the JSON object.`;

  const userPrompt = `A caller left this message when they called a business:

"${transcript}"

Their phone number is: ${callerPhone}

IMPORTANT: The AI asked the caller for their full name first. Extract it carefully from the transcript.
Look for patterns like: "My name is X", "This is X", "I'm X", "It's X speaking", or just a name stated at the start.

Extract the following fields and return ONLY a JSON object:
{
  "full_name": "caller's FULL name — first priority extraction. Use 'Caller' only if truly no name given",
  "intent": "one sentence describing why they called",
  "urgency": "high, medium, or low based on their words and tone",
  "industry": "one of: legal, medical, dental, hvac, realestate, insurance, veterinary, financial, other",
  "notes": "any additional context from the transcript worth noting",
  "language": "${language}"
}

Urgency rules:
- high = words like emergency, urgent, accident, right away, tonight, today, hurt, broken, leak, no AC, no heat
- medium = appointment, question, interested, looking for, need help soon
- low = just browsing, general info, no rush mentioned`;

  try {
    console.log('SENDING TO CLAUDE:', transcript.substring(0, 100));
    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = message.content[0]?.type === 'text' ? message.content[0].text : '{}';
    console.log('CLAUDE RAW:', text);
    
    const clean = text.replace(/```json|```/g, '').trim();
    const lead = JSON.parse(clean);
    console.log('CLAUDE EXTRACTION:', JSON.stringify(lead));
    
    return {
      full_name: safeString(lead.full_name, 'Caller'),
      intent:    safeString(lead.intent,    transcript.substring(0, 200)),
      urgency:   normalizeUrgency(lead.urgency),
      industry:  safeString(lead.industry,  'other'),
      notes:     safeString(lead.notes,     ''),
      language:  safeString(lead.language,  language),
    };
  } catch (err) {
    console.error('CLAUDE ERROR:', err.message);
    return { full_name: 'Caller', intent: transcript.substring(0, 300), urgency: 'medium', industry: 'other', notes: transcript, language };
  }
}

/* ---------------------------------------------
   SMS ALERT — HOT LEADS ONLY
--------------------------------------------- */
async function sendSmsAlert(lead, callerPhone) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const alertPhone = process.env.TWILIO_ALERT_PHONE;
  const fromPhone  = process.env.TWILIO_FROM_PHONE || '+17027102622';

  if (!accountSid || !authToken || !alertPhone) {
    console.log('SMS ALERT SKIPPED: missing credentials');
    return;
  }

  const message = [
    `FLOWDESK HOT LEAD`,
    `Name: ${lead.full_name}`,
    `Phone: ${callerPhone}`,
    `Intent: ${lead.intent}`,
    `Industry: ${lead.industry}`,
    `ID: ${lead.lead_id}`,
  ].join('\n');

  const body = new URLSearchParams({ To: alertPhone, From: fromPhone, Body: message }).toString();

  return new Promise((resolve) => {
    const auth    = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log('SMS RESULT:', res.statusCode, data.substring(0, 100));
        resolve();
      });
    });

    req.on('error', (err) => { console.error('SMS ERROR:', err.message); resolve(); });
    req.write(body);
    req.end();
  });
}

/* ---------------------------------------------
   EMAIL ALERT
--------------------------------------------- */
const URGENCY_CONFIG = {
  high:   { label: 'HOT LEAD - CALL BACK NOW', color: '#ef4444', prefix: 'HOT LEAD' },
  medium: { label: 'NEW LEAD',                  color: '#f59e0b', prefix: 'NEW LEAD' },
  low:    { label: 'ROUTINE LEAD',              color: '#22c55e', prefix: 'NEW LEAD' },
};

function buildCallAlertHtml(lead, callerPhone, transcript) {
  const urg = URGENCY_CONFIG[lead.urgency] || URGENCY_CONFIG.medium;
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

    <tr><td style="padding-bottom:20px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <span style="background:#2d9cdb;color:#fff;font-weight:700;font-size:13px;padding:4px 10px;border-radius:4px;">fd</span>
          <span style="color:#8b949e;font-size:13px;margin-left:10px;letter-spacing:1px;">FLOWDESK - INBOUND CALL</span>
        </td>
        <td align="right">
          <span style="font-family:monospace;font-size:11px;color:#484f58;">${lead.lead_id}</span>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="background:${urg.color}18;border:1px solid ${urg.color}44;border-radius:8px;padding:14px 20px;">
      <span style="font-size:16px;font-weight:700;color:${urg.color};">${urg.label}</span>
      <span style="font-size:13px;color:#c9d1d9;margin-left:12px;">${lead.timestamp_fmt}</span>
    </td></tr>

    <tr><td style="height:16px;"></td></tr>

    <tr><td style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px;">
      <table width="100%" cellpadding="0" cellspacing="0">

        <tr><td style="padding-bottom:20px;border-bottom:1px solid #21262d;">
          <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Caller</p>
          <p style="margin:6px 0 0;font-size:22px;font-weight:700;color:#f0f6fc;">${safeString(lead.full_name, 'Unknown Caller')}</p>
        </td></tr>

        <tr><td style="height:16px;"></td></tr>

        <tr><td style="padding-bottom:16px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="50%" style="vertical-align:top;">
              <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Phone</p>
              <p style="margin:4px 0 0;font-size:16px;font-weight:600;">
                <a href="tel:${callerPhone}" style="color:#2d9cdb;text-decoration:none;">${callerPhone}</a>
              </p>
            </td>
            <td width="50%" style="vertical-align:top;">
              <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Industry</p>
              <p style="margin:4px 0 0;font-size:15px;color:#c9d1d9;">${lead.industry}</p>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:14px 0;border-top:1px solid #21262d;">
          <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Reason for Call</p>
          <p style="margin:6px 0 0;font-size:15px;color:#f0f6fc;line-height:1.5;">${lead.intent}</p>
        </td></tr>

        ${transcript ? `
        <tr><td style="padding:14px 0;border-top:1px solid #21262d;">
          <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#484f58;">Caller's Exact Words</p>
          <p style="margin:6px 0 0;font-size:13px;color:#8b949e;line-height:1.6;font-style:italic;">"${safeString(transcript)}"</p>
        </td></tr>` : ''}

        <tr><td style="padding-top:16px;border-top:1px solid #21262d;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">Lead ID: ${lead.lead_id}</p></td>
            <td align="right"><p style="margin:0;font-family:monospace;font-size:11px;color:#484f58;">Source: inbound_call</p></td>
          </tr></table>
        </td></tr>

      </table>
    </td></tr>

    <tr><td style="height:24px;"></td></tr>
    <tr><td style="text-align:center;">
      <p style="margin:0;font-size:11px;color:#484f58;letter-spacing:1px;">FLOWDESK - APROPOS GROUP LLC - ${new Date().getFullYear()}</p>
    </td></tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

/* ---------------------------------------------
   MAIN HANDLER
--------------------------------------------- */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const queryParams  = event.queryStringParameters || {};
  const step         = safeString(queryParams.step, GATHER_STEP);
  const lang         = safeString(queryParams.lang, 'en');
  const body         = parseTwilioBody(event.body);

  const callerPhone  = safeString(body.From    || body.Caller, 'Unknown');
  const calledNumber = safeString(body.To      || body.Called, '');
  const speechResult = safeString(body.SpeechResult, '');
  const callSid      = safeString(body.CallSid, '');

  // Demo flag — all calls to 17027102622 are flagged as demo
  const DEMO_NUMBER = '17027102622';
  const isDemo = calledNumber.replace(/\D/g, '') === DEMO_NUMBER;

  // Demo ref — look up by caller phone number from demo_requests table
  // This bridges the gap between form submission and inbound call
  let demoRef = safeString(queryParams.ref, '');
  if (isDemo && !demoRef) {
    demoRef = await getDemoRefByPhone(callerPhone) || '';
  }

  console.log('CALL STEP:', step, '| CALLER:', callerPhone, '| SID:', callSid, '| DEMO:', isDemo, '| REF:', demoRef || 'none');
  console.log('SPEECH:', speechResult || '(none yet)');

  // ── GATHER ─────────────────────────────────
  if (step === GATHER_STEP) {
    const twiml = lang === 'es' ? buildGreetingTwiMLSpanish() : buildGreetingTwiML();
    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: twiml };
  }

  // ── FALLBACK ───────────────────────────────
  if (step === FALLBACK_STEP || !speechResult) {
    console.log('FALLBACK: No speech result received');

    if (callSid) {
      const clientId = await getClientIdByNumber(calledNumber);
      await writeCallLogToSupabase(callSid, callerPhone, calledNumber, 'no_speech', false, clientId, isDemo);
    }

    const alertTo   = process.env.RESEND_TO_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk <support@aiflowdeskpro.com>';

    if (alertTo && callerPhone !== 'Unknown') {
      await resend.emails.send({
        from:    fromEmail,
        to:      [alertTo],
        subject: `MISSED CALL - ${callerPhone}`,
        html: `<div style="font-family:Arial;background:#0d1117;padding:24px;color:#c9d1d9;">
          <h2 style="color:#f0f6fc;">Missed Call - No Message Left</h2>
          <p><strong>Phone:</strong> <a href="tel:${callerPhone}" style="color:#2d9cdb;">${callerPhone}</a></p>
          <p><strong>Called number:</strong> ${calledNumber}</p>
          <p><strong>Time:</strong> ${formatTimestamp()}</p>
          <p><strong>Call SID:</strong> ${callSid}</p>
          <p style="color:#8b949e;font-size:13px;">Caller did not speak. Consider calling back.</p>
        </div>`,
        text: `Missed Call - No Message\nPhone: ${callerPhone}\nTime: ${formatTimestamp()}`,
      }).catch(err => console.error('MISSED CALL EMAIL ERROR:', err.message));
    }

    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: buildFallbackTwiML() };
  }

  // ── PROCESS ────────────────────────────────
  try {
    console.log('SENDING TO CLAUDE:', speechResult);
    const extracted = await extractLeadFromTranscript(speechResult, callerPhone, lang);

    const lead = {
      lead_id:       generateLeadId(),
      source:        'inbound_call',
      full_name:     extracted.full_name,
      email:         '',
      phone:         callerPhone,
      language:      extracted.language || lang,
      intent:        extracted.intent,
      urgency:       extracted.urgency,
      industry:      extracted.industry,
      notes:         extracted.notes,
      call_sid:      callSid,
      called_number: calledNumber,
      transcript:    speechResult,
      timestamp:     new Date().toISOString(),
      timestamp_fmt: formatTimestamp(),
    };

    console.log('LEAD:', lead.lead_id, '| URGENCY:', lead.urgency, '| INDUSTRY:', lead.industry);

    // Look up client_id by the Twilio number that was called
    const clientId = await getClientIdByNumber(calledNumber);
    console.log('CLIENT ID:', clientId || 'not found — lead will be unlinked');

    const [leadResult, callLogResult] = await Promise.allSettled([
      writeLeadToSupabase(lead, callerPhone, calledNumber, speechResult, callSid, clientId, isDemo, demoRef),
      writeCallLogToSupabase(callSid, callerPhone, calledNumber, 'completed', true, clientId, isDemo),
    ]);

    console.log('SUPABASE LEAD:', leadResult.status, '| CALL LOG:', callLogResult.status);

    const alertTo   = process.env.RESEND_TO_EMAIL;
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'FlowDesk <support@aiflowdeskpro.com>';
    const urgCfg    = URGENCY_CONFIG[lead.urgency] || URGENCY_CONFIG.medium;

    if (alertTo) {
      const emailResult = await resend.emails.send({
        from:    fromEmail,
        to:      [alertTo],
        subject: `${urgCfg.prefix} - ${lead.full_name} - ${callerPhone}`,
        html:    buildCallAlertHtml(lead, callerPhone, speechResult),
        text: [
          `FLOWDESK CALL ALERT - ${urgCfg.label}`,
          '----------------------------------------',
          `Lead ID:  ${lead.lead_id}`,
          `Name:     ${lead.full_name}`,
          `Phone:    ${callerPhone}`,
          `Industry: ${lead.industry}`,
          `Intent:   ${lead.intent}`,
          `Urgency:  ${lead.urgency}`,
          `Time:     ${lead.timestamp_fmt}`,
          '',
          `Transcript: "${speechResult}"`,
        ].join('\n'),
      });
      console.log('EMAIL SENT:', JSON.stringify(emailResult));
    }

    if (lead.urgency === 'high') {
      console.log('HOT LEAD - FIRING SMS ALERT');
      await sendSmsAlert(lead, callerPhone);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: buildConfirmationTwiML(lead.urgency === 'high'),
    };

  } catch (error) {
    console.error('CALL HANDLER ERROR:', error?.message || error);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling. We have noted your call and someone will follow up with you shortly. Goodbye.</Say>
  <Hangup/>
</Response>`,
    };
  }
};
