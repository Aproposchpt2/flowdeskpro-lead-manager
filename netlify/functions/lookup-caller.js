'use strict';

// GET /.netlify/functions/lookup-caller?phone=+15551234567
// Called by ElevenLabs Alex at the start of every conversation.
// Looks up caller in lead_manager_records by phone number.
// Returns caller name + call history so Alex can greet returning callers by name.

const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error } = require('./lib/flowdesk-response-utils');

const TENANT_ID = process.env.CLIENT_TENANT_ID || 'apropos-ai4-businesses';

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

  const qs = event.queryStringParameters || {};
  const rawPhone = qs.phone || qs.caller_phone || '';
  const phone = normalizePhone(rawPhone);

  if (!phone) {
    return json(200, { found: false, reason: 'no_phone' }, corsHeaders);
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    return error(500, 'CONFIG_ERROR', 'Service configuration error', corsHeaders);
  }

  // Look up by phone in lead_manager_records — find most recent record
  const { data: records, error: dbErr } = await supabase
    .from('lead_manager_records')
    .select('id, contact_name, first_name, last_name, phone, service_needed, created_at, call_count')
    .eq('phone', phone)
    .eq('tenant_id', TENANT_ID)
    .order('created_at', { ascending: false })
    .limit(5);

  if (dbErr) {
    console.error('LOOKUP-CALLER DB ERROR:', dbErr.message);
    return json(200, { found: false, reason: 'db_error' }, corsHeaders);
  }

  if (!records || records.length === 0) {
    // Also try without +1 prefix for normalization differences
    const altPhone = phone.startsWith('+1') ? phone.slice(2) : null;
    if (altPhone) {
      const { data: altRecords } = await supabase
        .from('lead_manager_records')
        .select('id, contact_name, first_name, last_name, phone, service_needed, created_at')
        .eq('phone', altPhone)
        .eq('tenant_id', TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(1);

      if (altRecords && altRecords.length > 0) {
        const r = altRecords[0];
        const firstName = r.first_name || r.contact_name?.split(' ')[0] || null;
        console.log(`LOOKUP-CALLER: found (alt format) name="${r.contact_name}" phone=***${phone.slice(-4)}`);
        return json(200, {
          found: true,
          caller: {
            name:          r.contact_name,
            first_name:    firstName,
            previous_call: r.service_needed,
            total_calls:   altRecords.length,
            first_seen_at: r.created_at,
          },
        }, corsHeaders);
      }
    }

    console.log(`LOOKUP-CALLER: new caller phone=***${phone.slice(-4)}`);
    return json(200, { found: false, phone }, corsHeaders);
  }

  const latest = records[0];
  const firstName = latest.first_name || latest.contact_name?.split(' ')[0] || null;
  const previousCalls = records.map(r => r.service_needed).filter(Boolean);

  console.log(`LOOKUP-CALLER: returning caller name="${latest.contact_name}" calls=${records.length} phone=***${phone.slice(-4)}`);

  return json(200, {
    found: true,
    caller: {
      name:           latest.contact_name,
      first_name:     firstName,
      last_name:      latest.last_name || null,
      previous_call:  previousCalls[0] || null,
      total_calls:    records.length,
      first_seen_at:  records[records.length - 1].created_at,
      last_seen_at:   latest.created_at,
    },
  }, corsHeaders);
};
