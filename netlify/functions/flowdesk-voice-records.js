const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const tableName = clean(process.env.FLOWDESK_INTAKE_TABLE) || 'flowdesk_intake_records';

  if (!supabaseUrl || !serviceKey) {
    return json(500, { ok: false, error: 'Supabase environment variables are not configured.' });
  }

  const limit = clamp(new URLSearchParams(event.rawQuery || '').get('limit'), 1, 50, 20);

  const query = [
    'select=id,intake_id,created_at,full_name,email,phone,business_name,request_type,service_needed,urgency,details,notes,ai_summary,category,lead_status,next_action,source_page',
    'source_page=eq.ai_voice_attendant',
    'order=created_at.desc',
    `limit=${limit}`
  ].join('&');

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}?${query}`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      return json(response.status, { ok: false, error: 'Unable to load AI Voice Attendant records.', details: data });
    }

    return json(200, { ok: true, records: Array.isArray(data) ? data : [] });
  } catch (error) {
    return json(500, { ok: false, error: 'Unexpected server error while loading AI Voice Attendant records.', details: error.message });
  }
};

function clean(value) { return String(value || '').trim(); }

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function json(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
