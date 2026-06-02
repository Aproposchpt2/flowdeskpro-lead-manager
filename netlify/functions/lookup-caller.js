'use strict';

// GET /.netlify/functions/lookup-caller?phone=+15551234567
// Called by ElevenLabs voice agent Alex at the start of a conversation.
// Returns caller info from demo_requests if a matching phone exists.
// Returns { found: false } (not 404) when no match — ElevenLabs tools expect 2xx.
//
// Optional auth: set ELEVENLABS_SECRET env var; caller must send matching X-Agent-Secret header.

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error } = require('./lib/flowdesk-response-utils');

function normalizePhone(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 6) return `+${digits}`;
  return null;
}

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);
  if (event.httpMethod !== 'GET') {
    return error(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported', corsHeaders);
  }

  // Optional shared-secret check for ElevenLabs agent calls
  const secret = process.env.ELEVENLABS_SECRET;
  if (secret) {
    const provided = event.headers['x-agent-secret'] || event.headers['X-Agent-Secret'] || '';
    if (provided !== secret) {
      return error(401, 'UNAUTHORIZED', 'Invalid or missing agent secret', corsHeaders);
    }
  }

  const qs = event.queryStringParameters || {};
  const rawPhone = qs.phone || qs.caller_phone || '';
  const phone = normalizePhone(rawPhone);

  if (!phone) {
    return error(400, 'MISSING_PHONE', 'phone query parameter is required (E.164 or 10-digit US)', corsHeaders);
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    return error(500, 'CONFIG_ERROR', 'Service configuration error', corsHeaders);
  }

  const { data, error: dbErr } = await supabase
    .from('demo_requests')
    .select('id, business_name, contact_name, phone, email, industry, created_at')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (dbErr) {
    console.error('LOOKUP-CALLER DB ERROR:', dbErr.message);
    return error(500, 'DB_ERROR', 'Failed to look up caller', corsHeaders);
  }

  if (!data) {
    console.log(`LOOKUP-CALLER: not found phone=***${phone.slice(-4)}`);
    return json(200, { found: false, phone }, corsHeaders);
  }

  console.log(`LOOKUP-CALLER: found id=${data.id} phone=***${phone.slice(-4)}`);
  return json(200, {
    found: true,
    caller: {
      id:            data.id,
      business_name: data.business_name || null,
      contact_name:  data.contact_name  || null,
      email:         data.email         || null,
      industry:      data.industry      || null,
      first_seen_at: data.created_at,
    },
  }, corsHeaders);
};
