// netlify/functions/lead-manager.js
// FlowDesk Pro — Lead Manager
// Greeting: "Thank you for calling {Business Name}..."
// Single recording — caller leaves name + reason
// Logs to Supabase, transcription updates record

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BASE_URL = process.env.FLOWDESK_SITE_URL || "https://lead-management.aiflowdeskpro.com";

// Business name — pulled from env or default
// When multi-tenant is built this will be dynamic per client
const BUSINESS_NAME = process.env.BUSINESS_NAME || "FlowDesk Pro";

// ─── TwiML ─────────────────────────────────────────────────────────────────

function buildGreetingTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">
    Thank you for calling ${escapeXml(BUSINESS_NAME)}.
    There is no one available to take your call at this time.
    Please leave your name and the reason for your call after the tone,
    and the next available staff member will return your call.
    Press pound when you are finished.
  </Say>
  <Record
    action="${BASE_URL}/.netlify/functions/lead-manager?action=got_message"
    method="POST"
    maxLength="60"
    timeout="8"
    transcribe="true"
    transcribeCallback="${BASE_URL}/.netlify/functions/lead-manager?action=transcribe_message"
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
    Thank you. Your message has been received and a staff member will return your call shortly.
    Have a wonderful day!
  </Say>
  <Hangup/>
</Response>`;
}

function formatPhone(number) {
  if (!number) return "Unknown";
  const digits = number.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1"))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10)
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return number;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Supabase ──────────────────────────────────────────────────────────────

function generateIntakeId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `LM-${ts}-${rand}`;
}

async function createInitialLead(callerNumber, callSid) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const displayNumber = formatPhone(callerNumber);
    const { data, error } = await supabase
      .from("flowdesk_intake_records")
      .insert({
        intake_id: generateIntakeId(),
        full_name: `Voice Lead — ${displayNumber}`,
        email: `caller-${callSid}@flowdesk.local`,
        phone: callerNumber || "Unknown",
        business_name: BUSINESS_NAME,
        urgency: "Normal",
        details: "Inbound call — transcription pending.",
        notes: `Call SID: ${callSid}`,
        internal_notes: `Caller number: ${callerNumber} | Business: ${BUSINESS_NAME}`,
        lead_status: "New / Needs Review",
        follow_up_needed: true,
        source_page: "lead-manager-voice",
        service_needed: "Pending — transcription in progress",
        request_type: "Voice Lead",
        ai_summary: "Inbound call received. Awaiting voice transcription.",
        sms_consent: false,
      })
      .select()
      .single();
    if (error) { console.error("[Supabase] insert error:", error.message); return null; }
    console.log("[Supabase] lead created:", data.intake_id);
    return data;
  } catch (err) {
    console.error("[Supabase] error:", err);
    return null;
  }
}

async function updateLeadTranscription(callSid, transcription) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Extract likely name from first 2 words of transcription
    const words = transcription.trim().split(" ");
    const likelyName = words.length >= 2
      ? words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
      : words[0]
        ? words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase()
        : "Voice Lead";

    const { error } = await supabase
      .from("flowdesk_intake_records")
      .update({
        full_name: likelyName,
        details: transcription,
        service_needed: transcription,
        ai_summary: `Caller said: "${transcription}"`,
        updated_at: new Date().toISOString(),
      })
      .ilike("notes", `%${callSid}%`);

    if (error) console.error("[Supabase] update error:", error.message);
    else console.log("[Supabase] transcription saved. Name:", likelyName);
  } catch (err) {
    console.error("[Supabase] update error:", err);
  }
}

// ─── Parse body ────────────────────────────────────────────────────────────

function parseBody(body) {
  const params = {};
  if (!body) return params;
  body.split("&").forEach((pair) => {
    const [k, v] = pair.split("=").map(decodeURIComponent);
    params[k] = v;
  });
  return params;
}

// ─── Handler ───────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { "Content-Type": "text/xml" };

  try {
    const qs = event.queryStringParameters || {};
    const action = qs.action || "menu";
    const body = parseBody(event.body || "");

    const callerNumber = body.From || body.Caller || "Unknown";
    const callSid = body.CallSid || qs.sid || "unknown";
    const transcription = body.TranscriptionText || "";

    console.log(`[lead-manager] action=${action} caller=${callerNumber} SID=${callSid}`);

    // ── Initial call
    if (action === "menu") {
      await createInitialLead(callerNumber, callSid);
      return { statusCode: 200, headers, body: buildGreetingTwiML() };
    }

    // ── Recording complete — play confirmation
    if (action === "got_message") {
      return { statusCode: 200, headers, body: buildConfirmTwiML() };
    }

    // ── Transcription callback
    if (action === "transcribe_message") {
      if (transcription) {
        const sid = body.CallSid || qs.sid || callSid;
        await updateLeadTranscription(sid, transcription.trim());
      }
      return { statusCode: 204, body: "" };
    }

    return { statusCode: 200, headers, body: buildGreetingTwiML() };

  } catch (err) {
    console.error("[lead-manager] fatal error:", err);
    return {
      statusCode: 200,
      headers,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling. We will be in touch shortly. Goodbye.</Say>
  <Hangup/>
</Response>`,
    };
  }
};
