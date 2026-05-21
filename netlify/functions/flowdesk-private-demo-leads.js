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

  const qs = new URLSearchParams(event.rawQuery || '');
  const demoRef = clean(qs.get('ref'));
  const since = clean(qs.get('since'));
  const limit = clamp(qs.get('limit'), 1, 50, 20);

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseUrl || !serviceKey) {
    return json(500, {
      ok: false,
      error: 'Supabase environment variables are not configured.'
    });
  }

  if (!demoRef) {
    return json(400, {
      ok: false,
      error: 'Missing demo ref.'
    });
  }

  const select = 'caller_name,full_name,summary,intent,urgency,language,caller_phone,created_at,demo_ref,call_sid,is_demo';

  const query = [
    'is_demo=eq.true',
    `demo_ref=eq.${encodeURIComponent(demoRef)}`,
    since ? `created_at=gte.${encodeURIComponent(since)}` : '',
    'order=created_at.desc',
    `limit=${limit}`,
    `select=${select}`
  ].filter(Boolean).join('&');

  const result = await supabaseGet('leads', query, { supabaseUrl, serviceKey });

  if (!result.ok) {
    return json(result.status || 500, {
      ok: false,
      error: 'Unable to load private demo call records.',
      details: result.data
    });
  }

  return json(200, {
    ok: true,
    ref: demoRef,
    since: since || null,
    matchedBy: since ? 'demo_ref_and_current_session_start' : 'demo_ref_only',
    records: Array.isArray(result.data) ? result.data : []
  });
};

async function supabaseGet(table, query, config) {
  const endpoint = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?${query}`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
        'Content-Type': 'application/json'
      }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 500, data: error.message };
  }
}

function clean(value) {
  return String(value || '').trim();
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}
