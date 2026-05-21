'use strict';

/**
 * FlowDesk Pro — Lead Manager Intake Handler
 * netlify/functions/lead-manager.js
 *
 * Handles inbound Twilio voice calls to (725) 330-5102 (demo number).
 * 1. Queries Supabase demo_requests for the most recent business name
 * 2. Greets caller with personalized business name
 * 3. Records their name and reason for calling
 * 4. Writes lead to flowdesk_intake_records
 * 5. Fires email alert via Resend
 *
 * ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
 *           RESEND_FROM_EMAIL, RESEND_TO_EMAIL
 */

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const twimlHeaders = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*',
};

// ── Helpers ───────────────────────────────────────────────────
function safe(v, fallback = '') {
  return String(v || '').trim() || fallback;
}

function generateIntakeId() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FD-LM-${ts}-${rnd}`;
}

async function supabaseFetch(url, serviceKey, method, body) {
  const opts = {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : undefined,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── Get most recent demo business name ───────────────────────
async function getLatestBusinessName(supabaseUrl, serviceKey) {
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/demo_requests?select=business_name&order=created_at.desc&limit=1`;
  try {
    const result = await supabaseFetch(endpoint, serviceKey, 'GET');
    if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
      return safe(result.data[0].business_name, 'FlowDesk Pro');
    }
  } catch (err) {
    console.error('Business name lookup failed:', err.message);
  }
  return 'FlowDesk Pro';
}

// ── Write lead to Supabase ───────────────────────────────────
async function writeLeadToSupabase(supabaseUrl, serviceKey, lead) {
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/flowdesk_intake_records`;
  return supabaseFetch(endpoint, serviceKey, 'POST', lead);
}

// ── Send Resend alert email ──────────────────────────────────
async function sendAlertEmail(lead) {
  const apiKey   = safe(process.env.RESEND_API_KEY);
  const fromEmail = safe(process.env.RESEND_FROM_EMAIL, 'FlowDesk Pro <support@aiflowdeskpro.com>');
  const toEmail  = safe(process.env.RESEND_TO_EMAIL, 'jmitchell@aiflowdeskpro.com');

  if (!apiKey) { console.error('RESEND_API_KEY not set'); return; }

  const html = `<!DOCTYPE html>
<html><body style="background:#0d1117;font-family:Arial,sans-serif;padding:32px;">
<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px;max-width:560px;">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:1px;color:#484f58;text-transform:uppercase;">FLOWDESK · DEMO CALL ALERT</p>
  <h2 style="margin:0 0 20px;color:#f0f6fc;font-size:18px;">📞 New Demo Lead — ${lead.business_name}</h2>
  <table style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;width:120px;">Intake ID</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;font-family:monospace;">${lead.intake_id}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Caller</td><td style="padding:8px 0;color:#f0f6fc;font-size:15px;font-weight:600;">${lead.customer_name}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Phone</td><td style="padding:8px 0;color:#2d9cdb;font-size:13px;">${lead.phone}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Business</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${lead.business_name}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Reason</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${lead.details}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Source</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${lead.source_page}</td></tr>
    <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;">Time</td><td style="padding:8px 0;color:#c9d1d9;font-size:13px;">${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</td></tr>
  </table>
</div>
</body></html>`;

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
        subject: `📞 Demo Call — ${lead.customer_name} / ${lead.business_name}`,
        html,
      }),
    });
    const data = await res.json();
    console.log('Resend alert result:', res.status, JSON.stringify(data));
  } catch (err) {
    console.error('Resend alert error:', err.message);
  }
}

// ── TwiML Builders ────────────────────────────────────────────
function twimlGather(businessName) {
  // Step 1: greet, ask for name and reason
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/.netlify/functions/lead-manager?step=record" method="POST" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna" rate="95%">Thank you for calling ${businessName}. There is no one available to take your call right now, but our AI assistant is here to help. Please state your first and last name, and then tell us the reason for your call. Go ahead after the tone.</Say>
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">We didn't catch that. Please try calling back and leave your name and reason for your call. Goodbye.</Say>
</Response>`;
}

function twimlRecord(businessName) {
  // Fallback: use <Record> if speech gather not available
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" rate="95%">Thank you for calling ${businessName}. Please leave your name and the reason for your call after the beep.</Say>
  <Record action="/.netlify/functions/lead-manager?step=recorded" method="POST" maxLength="60" playBeep="true" transcribe="true" transcribeCallback="/.netlify/functions/lead-manager?step=transcription"/>
  <Say voice="Polly.Joanna">Thank you. We have received your message and will follow up shortly. Goodbye.</Say>
</Response>`;
}

function twimlConfirm() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" rate="95%">Thank you. We have received your information and will follow up with you shortly. Have a great day. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// ── MAIN HANDLER ──────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: twimlHeaders, body: '' };
  }

  const supabaseUrl = safe(process.env.SUPABASE_URL);
  const serviceKey  = safe(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

  const step = (new URLSearchParams(event.queryStringParameters || {})).get('step') || 'greet';

  // ── STEP: greet — initial call comes in ──────────────────
  if (step === 'greet' || !step) {
    const businessName = (supabaseUrl && serviceKey)
      ? await getLatestBusinessName(supabaseUrl, serviceKey)
      : 'FlowDesk Pro';
    console.log(`Greeting caller for business: ${businessName}`);
    return {
      statusCode: 200,
      headers: twimlHeaders,
      body: twimlGather(businessName),
    };
  }

  // ── Parse Twilio POST body ────────────────────────────────
  const body = {};
  if (event.body) {
    const params = new URLSearchParams(event.body);
    for (const [k, v] of params.entries()) body[k] = v;
  }

  // ── STEP: record — speech gathered ───────────────────────
  if (step === 'record') {
    const speechResult  = safe(body.SpeechResult, '');
    const callerPhone   = safe(body.From || body.Caller, 'Unknown');
    const callSid       = safe(body.CallSid, '');
    const intakeId      = generateIntakeId();

    // Get business name again for lead record
    const businessName = (supabaseUrl && serviceKey)
      ? await getLatestBusinessName(supabaseUrl, serviceKey)
      : 'FlowDesk Pro';

    const lead = {
      intake_id:     intakeId,
      customer_name: speechResult || 'Voice Caller',
      phone:         callerPhone,
      business_name: businessName,
      details:       speechResult || 'No speech captured',
      source_page:   'twilio-voice-demo',
      lead_status:   'New / Needs Review',
      urgency:       'unknown',
      source:        'voice',
      call_sid:      callSid,
      created_at:    new Date().toISOString(),
    };

    // Write to Supabase
    if (supabaseUrl && serviceKey) {
      try {
        const result = await writeLeadToSupabase(supabaseUrl, serviceKey, lead);
        console.log('Supabase write result:', result.status, JSON.stringify(result.data));
      } catch (err) {
        console.error('Supabase write error:', err.message);
      }
    } else {
      console.warn('Supabase env vars not set — skipping DB write');
    }

    // Fire email alert (non-blocking)
    sendAlertEmail(lead).catch(err => console.error('Email alert failed:', err.message));

    return {
      statusCode: 200,
      headers: twimlHeaders,
      body: twimlConfirm(),
    };
  }

  // ── STEP: recorded — <Record> verb callback ───────────────
  if (step === 'recorded') {
    const callerPhone  = safe(body.From || body.Caller, 'Unknown');
    const callSid      = safe(body.CallSid, '');
    const recordingUrl = safe(body.RecordingUrl, '');
    const intakeId     = generateIntakeId();

    const businessName = (supabaseUrl && serviceKey)
      ? await getLatestBusinessName(supabaseUrl, serviceKey)
      : 'FlowDesk Pro';

    const lead = {
      intake_id:     intakeId,
      customer_name: 'Voice Caller (Recording)',
      phone:         callerPhone,
      business_name: businessName,
      details:       `Recording: ${recordingUrl} — Transcription pending.`,
      source_page:   'twilio-voice-demo-record',
      lead_status:   'New / Needs Review',
      urgency:       'unknown',
      source:        'voice',
      call_sid:      callSid,
      recording_url: recordingUrl,
      created_at:    new Date().toISOString(),
    };

    if (supabaseUrl && serviceKey) {
      try {
        await writeLeadToSupabase(supabaseUrl, serviceKey, lead);
      } catch (err) {
        console.error('Supabase write error:', err.message);
      }
    }
    sendAlertEmail(lead).catch(() => {});
    return { statusCode: 200, headers: twimlHeaders, body: twimlConfirm() };
  }

  // ── STEP: transcription — async transcription callback ────
  if (step === 'transcription') {
    const transcription = safe(body.TranscriptionText, '');
    const callSid       = safe(body.CallSid, '');
    console.log(`Transcription for ${callSid}:`, transcription);

    // Update the lead record in Supabase with transcription
    if (supabaseUrl && serviceKey && transcription && callSid) {
      try {
        const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/flowdesk_intake_records?call_sid=eq.${encodeURIComponent(callSid)}`;
        await supabaseFetch(endpoint, serviceKey, 'PATCH', {
          details: transcription,
          customer_name: transcription.split(' ').slice(0, 3).join(' ') || 'Voice Caller',
        });
      } catch (err) {
        console.error('Transcription update error:', err.message);
      }
    }
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
  }

  // Unknown step
  return { statusCode: 200, headers: twimlHeaders, body: twimlConfirm() };
};
