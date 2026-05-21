// netlify/functions/flowdesk-email-lead.js
// FlowDesk Pro — Lead Manager
// Called by the dashboard to send a follow-up email to a lead via Resend

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "hello@aiflowdeskpro.com";

function value(v, fallback) {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildEmailHtml(lead) {
  const name = value(lead.full_name, "there");
  const firstName = name.split(" ")[0];
  const business = value(lead.business_name, "your business");
  const service = value(lead.service_needed || lead.request_type, "business automation");
  const intakeId = value(lead.intake_id, "N/A");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>FlowDesk Pro — Follow Up</title></head>
<body style="font-family:Inter,sans-serif;background:#050b14;color:#f2f8ff;padding:32px;margin:0;">
  <div style="max-width:560px;margin:0 auto;background:#071423;border-radius:12px;border:1px solid rgba(142,184,222,0.18);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#27aefb,#4bd89d);padding:28px 32px;">
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#021323;letter-spacing:-0.5px;">
        Hi ${escapeHtml(firstName)}, thanks for reaching out!
      </h1>
      <p style="margin:8px 0 0;color:rgba(2,19,35,0.75);font-size:14px;">FlowDesk Pro · Intelligent Business Automation</p>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 20px;line-height:1.7;color:#a7bbcf;font-size:15px;">
        We received your inquiry about <strong style="color:#f2f8ff;">${escapeHtml(service)}</strong> for 
        <strong style="color:#f2f8ff;">${escapeHtml(business)}</strong>. 
        Our team has reviewed your request and we're excited to connect with you.
      </p>
      <p style="margin:0 0 28px;line-height:1.7;color:#a7bbcf;font-size:15px;">
        A FlowDesk Pro specialist will be reaching out to you shortly to discuss how our 
        automation systems can help streamline your business operations.
      </p>
      <div style="background:rgba(39,174,251,0.08);border:1px solid rgba(39,174,251,0.2);border-radius:10px;padding:20px;margin-bottom:28px;">
        <p style="margin:0 0 8px;font-size:12px;color:#7088a1;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Your Reference Number</p>
        <p style="margin:0;font-size:20px;font-weight:800;color:#6fdcff;letter-spacing:1px;">${escapeHtml(intakeId)}</p>
      </div>
      <p style="margin:0 0 24px;line-height:1.7;color:#a7bbcf;font-size:14px;">
        In the meantime, feel free to explore our automation solutions at 
        <a href="https://aiflowdeskpro.com" style="color:#27aefb;text-decoration:none;">aiflowdeskpro.com</a>.
      </p>
      <a href="https://aiflowdeskpro.com" style="display:inline-block;background:linear-gradient(135deg,#27aefb,#4bd89d);color:#021323;font-weight:700;font-size:14px;padding:14px 28px;border-radius:8px;text-decoration:none;">
        Explore FlowDesk Pro →
      </a>
    </div>
    <div style="padding:20px 32px;background:#030712;border-top:1px solid rgba(142,184,222,0.12);">
      <p style="margin:0;font-size:12px;color:#7088a1;line-height:1.6;">
        FlowDesk Pro by Apropos Group LLC · 2780 S Jones Blvd, Las Vegas, NV 89146<br>
        <a href="mailto:support@aproposgroupllc.com" style="color:#27aefb;text-decoration:none;">support@aproposgroupllc.com</a> · 
        <a href="https://aiflowdeskpro.com" style="color:#27aefb;text-decoration:none;">aiflowdeskpro.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  if (!RESEND_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "RESEND_API_KEY not configured." }),
    };
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const { lead } = payload;

    if (!lead) {
      return { statusCode: 400, body: JSON.stringify({ error: "lead object is required." }) };
    }

    const email = value(lead.email, "");
    if (!email || email.endsWith("@flowdesk.local") || email.endsWith("@example.com")) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "This lead does not have a sendable email address." }),
      };
    }

    const name = value(lead.full_name, "there");
    const service = value(lead.service_needed || lead.request_type, "your inquiry");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [email],
        subject: `${name}, thank you for contacting FlowDesk Pro!`,
        html: buildEmailHtml(lead),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("[flowdesk-email-lead] Resend error:", JSON.stringify(data));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data.message || "Failed to send email." }),
      };
    }

    console.log("[flowdesk-email-lead] sent to:", email, "id:", data.id);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, email, resend_id: data.id }),
    };
  } catch (err) {
    console.error("[flowdesk-email-lead] fatal error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
