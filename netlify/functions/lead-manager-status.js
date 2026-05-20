// netlify/functions/lead-manager-status.js
// FlowDesk Pro — Lead Manager Status Callback
// Handles Twilio status webhooks, fires Resend email alert on new leads

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;

function parseBody(body) {
  const params = {};
  if (!body) return params;
  body.split("&").forEach((pair) => {
    const [k, v] = pair.split("=").map(decodeURIComponent);
    params[k] = v;
  });
  return params;
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

async function getLeadByCallSid(callSid) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase
      .from("flowdesk_intake_records")
      .select("*")
      .ilike("notes", `%${callSid}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (error) return null;
    return data;
  } catch (err) {
    return null;
  }
}

async function sendLeadAlert(lead, callerNumber, callDuration) {
  if (!RESEND_API_KEY) {
    console.warn("[Resend] RESEND_API_KEY not set — skipping alert");
    return;
  }

  const callerFormatted = formatPhone(callerNumber);
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const service = lead?.service_needed || "Unknown";
  const intakeId = lead?.intake_id || "N/A";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>New Lead — FlowDesk Pro</title></head>
<body style="font-family:Inter,sans-serif;background:#050b14;color:#f2f8ff;padding:32px;">
  <div style="max-width:520px;margin:0 auto;background:#071423;border-radius:12px;border:1px solid rgba(142,184,222,0.18);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#27aefb,#4bd89d);padding:24px 32px;">
      <h1 style="margin:0;font-size:20px;font-weight:700;color:#021323;">
        🎯 New Lead — FlowDesk Pro Lead Manager
      </h1>
      <p style="margin:6px 0 0;color:rgba(2,19,35,0.75);font-size:14px;">Inbound call captured · (725) 330-5102</p>
    </div>
    <div style="padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;color:#7088a1;font-size:13px;width:140px;">Lead ID</td>
          <td style="padding:10px 0;font-weight:600;font-size:14px;color:#6fdcff;">${intakeId}</td>
        </tr>
        <tr style="border-top:1px solid rgba(142,184,222,0.18);">
          <td style="padding:10px 0;color:#7088a1;font-size:13px;">Caller</td>
          <td style="padding:10px 0;font-weight:600;font-size:15px;">${callerFormatted}</td>
        </tr>
        <tr style="border-top:1px solid rgba(142,184,222,0.18);">
          <td style="padding:10px 0;color:#7088a1;font-size:13px;">Interest</td>
          <td style="padding:10px 0;">
            <span style="background:rgba(39,174,251,0.15);color:#27aefb;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600;">
              ${service}
            </span>
          </td>
        </tr>
        <tr style="border-top:1px solid rgba(142,184,222,0.18);">
          <td style="padding:10px 0;color:#7088a1;font-size:13px;">Status</td>
          <td style="padding:10px 0;font-weight:600;color:#4bd89d;">New / Needs Review</td>
        </tr>
        <tr style="border-top:1px solid rgba(142,184,222,0.18);">
          <td style="padding:10px 0;color:#7088a1;font-size:13px;">Call Duration</td>
          <td style="padding:10px 0;font-weight:600;">${callDuration || 0}s</td>
        </tr>
        <tr style="border-top:1px solid rgba(142,184,222,0.18);">
          <td style="padding:10px 0;color:#7088a1;font-size:13px;">Time (PST)</td>
          <td style="padding:10px 0;font-size:13px;color:#7088a1;">${timestamp}</td>
        </tr>
      </table>
    </div>
    <div style="padding:16px 32px 24px;">
      <a href="https://lm.aiflowdeskpro.com" style="display:inline-block;background:linear-gradient(135deg,#27aefb,#4bd89d);color:#021323;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">
        Open Lead Manager Dashboard →
      </a>
    </div>
    <div style="padding:16px 32px;background:#030712;border-top:1px solid rgba(142,184,222,0.12);">
      <p style="margin:0;font-size:12px;color:#7088a1;">
        FlowDesk Pro Lead Manager · <a href="https://aiflowdeskpro.com" style="color:#27aefb;text-decoration:none;">aiflowdeskpro.com</a>
        · <a href="mailto:support@aproposgroupllc.com" style="color:#27aefb;text-decoration:none;">support@aproposgroupllc.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL || "alerts@aiflowdeskpro.com",
        to: [RESEND_TO_EMAIL || "support@aproposgroupllc.com"],
        subject: `🎯 New Lead — ${callerFormatted} · ${service}`,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) console.error("[Resend] error:", JSON.stringify(data));
    else console.log("[Resend] lead alert sent:", data.id);
  } catch (err) {
    console.error("[Resend] fetch error:", err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = parseBody(event.body || "");
    const callSid = body.CallSid || "unknown";
    const callStatus = body.CallStatus || "unknown";
    const callDuration = parseInt(body.CallDuration || "0", 10);
    const callerNumber = body.From || body.Caller || "Unknown";

    console.log(`[lead-manager-status] SID=${callSid} status=${callStatus} duration=${callDuration}s`);

    if (callStatus === "completed") {
      const lead = await getLeadByCallSid(callSid);
      await sendLeadAlert(lead, callerNumber, callDuration);
    }

    return { statusCode: 204, body: "" };
  } catch (err) {
    console.error("[lead-manager-status] fatal error:", err);
    return { statusCode: 500, body: "Internal Server Error" };
  }
};
