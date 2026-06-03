'use strict';

// POST /.netlify/functions/lookup-caller
// ElevenLabs Conversation Initiation Client Data webhook.
// Called at the START of every conversation — ElevenLabs expects back
// dynamic_variables to inject into the conversation context.
//
// Response shape must be:
// { type: "conversation_initiation_client_data", dynamic_variables: { ... } }

const crypto = require('crypto');
const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json } = require('./lib/flowdesk-response-utils');

const TENANT_ID = process.env.CLIENT_TENANT_ID || 'apropos-ai4-businesses';

// ElevenLabs signature: elevenlabs-signature: t=<ts>,v1=<hex>
function verifySignature(event) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured — allow (isolation mode)

  const sigHeader = event.headers['elevenlabs-signature'] || '';
  if (!sigHeader) return false;

  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signed   = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

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

async function lookupPhone(supabase, phone) {
  const { data } = await supabase
    .from('lead_manager_records')
    .select('id, contact_name, first_name, last_name, service_needed, created_at')
    .eq('phone', phone)
    .eq('tenant_id', TENANT_ID)
    .order('created_at', { ascending: false })
    .limit(5);

  if (data && data.length > 0) return data;

  // Try without +1 prefix
  const alt = phone.startsWith('+1') ? phone.slice(2) : null;
  if (alt) {
    const { data: d2 } = await supabase
      .from('lead_manager_records')
      .select('id, contact_name, first_name, last_name, service_needed, created_at')
      .eq('phone', alt)
      .eq('tenant_id', TENANT_ID)
      .order('created_at', { ascending: false })
      .limit(5);
    if (d2 && d2.length > 0) return d2;
  }
  return [];
}

exports.handler = async (event) => {
  const corsHeaders = buildCorsHeaders(event.headers?.origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(event.headers?.origin);

  // Log signature result but never block — a non-200 here kills the call
  if (!verifySignature(event)) {
    console.warn('LOOKUP-CALLER: invalid/missing signature — proceeding to avoid call abort');
  }

  // Extract caller phone from POST body (conversation initiation data)
  let callerPhone = null;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    const body = JSON.parse(rawBody);
    // ElevenLabs sends caller ID in dynamic_variables or conversation metadata
    callerPhone = body?.dynamic_variables?.system__caller_id
      || body?.metadata?.phone_call?.external_number
      || body?.caller_id
      || null;
  } catch {
    // ignore parse errors — return empty initiation data
  }

  const phone = normalizePhone(callerPhone);

  // Always return 200 with correct shape — ElevenLabs requires this
  const response = {
    type: 'conversation_initiation_client_data',
    dynamic_variables: {
      caller_first_name:    null,
      caller_last_name:     null,
      caller_full_name:     null,
      is_returning_caller:  false,
      previous_call_reason: null,
      total_calls:          0,
    },
  };

  if (phone) {
    try {
      const supabase = getSupabaseAdmin();
      const records  = await lookupPhone(supabase, phone);

      if (records.length > 0) {
        const latest = records[0];
        const firstName = latest.first_name || latest.contact_name?.split(' ')[0] || null;
        const lastName  = latest.last_name  || (latest.contact_name?.split(' ').slice(1).join(' ') || null);
        const fullName  = latest.contact_name || null;

        response.dynamic_variables = {
          caller_first_name:    firstName,
          caller_last_name:     lastName,
          caller_full_name:     fullName,
          is_returning_caller:  true,
          previous_call_reason: records[0].service_needed || null,
          total_calls:          records.length,
        };

        console.log(`LOOKUP-CALLER: returning caller "${fullName}" phone=***${phone.slice(-4)} calls=${records.length}`);
      } else {
        console.log(`LOOKUP-CALLER: new caller phone=***${phone.slice(-4)}`);
      }
    } catch (err) {
      console.error('LOOKUP-CALLER DB error:', err.message);
      // Return empty dynamic_variables — never block the call
    }
  }

  return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(response) };
};
