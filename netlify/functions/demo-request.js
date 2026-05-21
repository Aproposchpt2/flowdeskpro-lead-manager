// netlify/functions/demo-request.js
// FlowDesk Pro — Demo Request Handler
// Captures prospect info → writes to Supabase → returns personalized ref slug
// Also sends email alert to owner so they know a demo was requested

const https = require('https');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── PARSE BODY ────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { firstName, lastName, businessName, phone, industry } = body;

  // ── VALIDATE ──────────────────────────────────────────────────────────
  if (!firstName || !lastName || !businessName || !phone || !industry) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'All fields are required' })
    };
  }

  // ── GENERATE REF SLUG ─────────────────────────────────────────────────
  // "Henderson Law Group" → "henderson-law-group"
  const refSlug = businessName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);

  const contactName = `${firstName} ${lastName}`;

  console.log('DEMO REQUEST:', contactName, '|', businessName, '| ref:', refSlug);

  // ── WRITE TO SUPABASE ─────────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      await supabaseInsert(supabaseUrl, supabaseKey, 'demo_requests', {
        business_name: businessName,
        contact_name:  contactName,
        phone:         phone,
        industry:      industry,
        ref_slug:      refSlug,
      });
      console.log('DEMO REQUEST SAVED TO SUPABASE:', refSlug);
    } catch (e) {
      console.error('Supabase write error:', e.message);
      // Non-fatal — continue anyway
    }
  }

  // ── SEND EMAIL ALERT TO OWNER ─────────────────────────────────────────
  const resendKey   = process.env.RESEND_API_KEY;
  const fromEmail   = process.env.RESEND_FROM_EMAIL || 'FlowDesk Pro <support@aiflowdeskpro.com>';
  const toEmail     = process.env.RESEND_TO_EMAIL   || 'jmitchell@aiflowdeskpro.com';
  const siteUrl     = process.env.FLOWDESK_SITE_URL || 'https://aiflowdeskpro.com';

  if (resendKey) {
    try {
      const industryLabels = {
        legal: 'Legal / Law Firm', medical: 'Medical Practice',
        dental: 'Dental Office', hvac: 'HVAC / Trades',
        real_estate: 'Real Estate', insurance: 'Insurance Agency',
        veterinary: 'Veterinary Clinic', financial: 'Financial Services',
        other: 'Other'
      };
      const industryLabel = industryLabels[industry] || industry;
      const demoLink = `${siteUrl}/demo.html?ref=${encodeURIComponent(refSlug)}`;

      const emailBody = JSON.stringify({
        from:    fromEmail,
        to:      [toEmail],
        subject: `🎯 New Demo Request — ${businessName}`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.1)">
            <div style="background:#161b22;padding:24px 28px;border-bottom:1px solid rgba(255,255,255,0.08)">
              <div style="font-family:monospace;font-size:11px;color:#2d9cdb;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">FlowDesk Pro · Demo Request</div>
              <div style="font-size:20px;font-weight:700;color:#f0f6fc">New Demo Request</div>
            </div>
            <div style="padding:24px 28px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;color:#8b949e;font-size:13px;width:140px">Contact</td><td style="padding:8px 0;color:#f0f6fc;font-size:13px;font-weight:600">${contactName}</td></tr>
                <tr><td style="padding:8px 0;color:#8b949e;font-size:13px">Business</td><td style="padding:8px 0;color:#f0f6fc;font-size:13px;font-weight:600">${businessName}</td></tr>
                <tr><td style="padding:8px 0;color:#8b949e;font-size:13px">Phone</td><td style="padding:8px 0;color:#2d9cdb;font-size:13px;font-weight:600">${phone}</td></tr>
                <tr><td style="padding:8px 0;color:#8b949e;font-size:13px">Industry</td><td style="padding:8px 0;color:#f0f6fc;font-size:13px">${industryLabel}</td></tr>
                <tr><td style="padding:8px 0;color:#8b949e;font-size:13px">Demo Link</td><td style="padding:8px 0;font-size:13px"><a href="${demoLink}" style="color:#2d9cdb">${demoLink}</a></td></tr>
              </table>
              <div style="margin-top:20px;padding:16px;background:#1c2128;border-radius:8px;border:1px solid rgba(45,156,219,0.15)">
                <div style="font-size:12px;color:#8b949e;margin-bottom:8px;font-family:monospace">NEXT STEP</div>
                <div style="font-size:13px;color:#c9d1d9">
                  ${contactName} is viewing their private demo right now. 
                  Follow up within 24 hours while the experience is fresh.
                </div>
              </div>
            </div>
          </div>
        `
      });

      await sendEmail(resendKey, emailBody);
      console.log('DEMO REQUEST EMAIL SENT to', toEmail);
    } catch (e) {
      console.error('Email send error:', e.message);
      // Non-fatal
    }
  }

  // ── RETURN SUCCESS ────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success:      true,
      ref_slug:     refSlug,
      contact_name: contactName,
      session_ts:   Date.now(),
      message:      'Demo request received'
    })
  };
};

// ── HELPERS ───────────────────────────────────────────────────────────────

function supabaseInsert(url, key, table, record) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(record);
    const urlObj   = new URL(`${url}/rest/v1/${table}`);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey':        key,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`Supabase error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

function sendEmail(apiKey, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Email timeout')); });
    req.write(body);
    req.end();
  });
}
