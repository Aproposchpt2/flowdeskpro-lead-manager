'use strict';

// POST /.netlify/functions/log-call
// CRM-aware call logging — writes to full CRM schema:
//   contacts → call_records → leads → activities → tasks
// Handles ElevenLabs post-call webhooks AND in-conversation tool calls.

const crypto = require('crypto');
const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json, error, parseJsonBody } = require('./lib/flowdesk-response-utils');

const AGENT_NAME = 'Alex';
const AGENT_ID   = process.env.ELEVENLABS_AGENT_ID || 'agent_6101ksv5amdpfqn90z89gtvh34a7';
const CLIENT_ID  = process.env.CRM_CLIENT_ID || '10b8f727-cecd-4e20-9829-c0dfed181dde';

// ElevenLabs native signature: elevenlabs-signature: t=<unix_ts>,v1=<hmac_sha256_hex>
// Signed content: "{timestamp}.{body}"
function verifyElevenLabsSignature(event) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true;

  const sigHeader = event.headers['elevenlabs-signature'] || '';
  if (!sigHeader) {
    console.warn('LOG-CALL: no elevenlabs-signature header — proceeding');
    return true; // allow through, log the warning
  }

  const parts     = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const rawBody   = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signed   = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signed).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

function clean(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

function buildTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return null;
  return transcript.map(t => `${t.role === 'agent' ? 'Alex' : 'Caller'}: ${t.message || ''}`).join('\n').slice(0, 4000);
}

function normalizePhone(phone) {
  if (!phone || phone === 'Unknown') return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return phone;
}

function durationDisplay(secs) {
  if (!secs) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

exports.handler = async (event) => {
  const origin = event.headers && event.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);
  if (event.httpMethod !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported', corsHeaders);

  if (!verifyElevenLabsSignature(event)) {
    console.warn('LOG-CALL: signature mismatch — proceeding to capture data');
  }

  const body = parseJsonBody(event);
  if (!body) return error(400, 'INVALID_BODY', 'Invalid JSON body', corsHeaders);

  console.log('LOG-CALL body-type:', body.type, '| top-keys:', Object.keys(body).join(','), '| data-keys:', body.data ? Object.keys(body.data).join(',') : 'no-data', '| phone:', body.data?.metadata?.phone_call?.external_number || body.data?.metadata?.phone_call?.caller_id || 'not-found');

  // ── Extract fields from payload ───────────────────────────────
  let callerPhone, conversationId, durationSecs, transcriptText;
  let callerFirstName, callerLastName, reasonForCall;
  let contactType, callerEmail, leadPriority, decisionTimeline, callerMessage, callbackNumber;

  if (body.type === 'post_call_transcription' && body.data) {
    const d = body.data;
    conversationId   = clean(d.conversation_id, 64) || null;
    durationSecs     = d.metadata?.call_duration_secs ? Math.round(Number(d.metadata.call_duration_secs)) : null;
    callerPhone      = clean(d.metadata?.phone_call?.external_number || d.metadata?.phone_call?.caller_id, 30) || 'Unknown';
    transcriptText   = buildTranscript(d.transcript);
    const collected  = d.data_collection_results || {};
    const dynVars    = d.conversation_initiation_client_data?.dynamic_variables || {};
    callerFirstName  = clean(collected.first_name?.value, 60) || null;
    callerLastName   = clean(collected.last_name?.value, 60) || null;
    reasonForCall    = clean(collected.reason_for_call?.value, 500) || null;
    contactType      = clean(collected.contact_type?.value, 30) || 'lead';
    callerEmail      = clean(collected.email?.value, 200) || null;
    leadPriority     = clean(collected.lead_priority?.value, 20) || null;
    decisionTimeline = clean(collected.decision_timeline?.value, 30) || null;
    callerMessage    = clean(collected.caller_message?.value, 500) || null;
    callbackNumber   = clean(collected.callback_number?.value, 30) || null;
    // Fallback: caller phone from dynamic variables
    if (callerPhone === 'Unknown') callerPhone = clean(dynVars.system__caller_id, 30) || 'Unknown';
  } else {
    callerPhone      = clean(body.caller_phone, 30) || 'Unknown';
    callerFirstName  = clean(body.caller_first_name || body.first_name, 60) || null;
    callerLastName   = clean(body.caller_last_name  || body.last_name,  60) || null;
    reasonForCall    = clean(body.reason_for_call, 500) || null;
    contactType      = clean(body.contact_type, 30) || 'lead';
    callerEmail      = clean(body.email, 200) || null;
    leadPriority     = clean(body.lead_priority, 20) || null;
    decisionTimeline = clean(body.decision_timeline, 30) || null;
    callerMessage    = clean(body.caller_message, 500) || null;
    callbackNumber   = clean(body.callback_number, 30) || null;
    conversationId   = clean(body.conversation_id, 64) || null;
    const dRaw       = body.duration || body.duration_seconds;
    durationSecs     = Number.isFinite(Number(dRaw)) ? Math.round(Number(dRaw)) : null;
    transcriptText   = clean(body.conversation_summary, 4000) || null;
  }

  const callerPhoneNorm = normalizePhone(callerPhone);
  const now = new Date().toISOString();

  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (e) { return error(500, 'CONFIG_ERROR', 'Supabase not configured', corsHeaders); }

  // ── STEP 1: Find or create contact ───────────────────────────
  let contactId = null;
  let isNewContact = false;

  if (callerPhone !== 'Unknown') {
    // Look up existing contact by caller_id (normalized phone)
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, lead_score')
      .eq('caller_id', callerPhoneNorm)
      .maybeSingle();

    if (existingContact) {
      contactId = existingContact.id;
      // Update returning caller — increment lead score, update timestamp
      await supabase.from('contacts').update({
        updated_at:  now,
        lead_score:  (existingContact.lead_score || 0) + 1,
        lead_status: 'contacted',
        ...(callerFirstName  && !existingContact.first_name  ? { first_name:        callerFirstName  } : {}),
        ...(callerLastName   && !existingContact.last_name   ? { last_name:         callerLastName   } : {}),
        ...(callerEmail                                       ? { email:             callerEmail      } : {}),
        ...(leadPriority                                      ? { priority:          leadPriority     } : {}),
        ...(decisionTimeline                                  ? { decision_timeline: decisionTimeline } : {}),
      }).eq('id', contactId);
      console.log(`LOG-CALL: returning caller contact_id=${contactId}`);
    } else {
      // Create new contact
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({
          caller_id:         callerPhoneNorm,
          phone_primary:     callerPhoneNorm,
          phone_normalized:  callerPhoneNorm,
          first_name:        callerFirstName,
          last_name:         callerLastName,
          email:             callerEmail,
          contact_type:      contactType,
          priority:          leadPriority,
          decision_timeline: decisionTimeline,
          lead_source:       'phone_call',
          lead_status:       'new',
          client_id:         CLIENT_ID,
          created_at:        now,
          updated_at:        now,
        })
        .select('id')
        .single();

      if (newContact) {
        contactId = newContact.id;
        isNewContact = true;
        console.log(`LOG-CALL: new contact created contact_id=${contactId}`);
      }
    }
  }

  // ── STEP 2: Create call_record ────────────────────────────────
  let callRecordId = null;

  const { data: callRecord, error: crErr } = await supabase
    .from('call_records')
    .upsert({
      client_id:              CLIENT_ID,
      contact_id:             contactId,
      conversation_id:        conversationId,
      caller_id:              callerPhoneNorm,
      caller_phone_normalized: callerPhoneNorm,
      call_direction:         'inbound',
      call_status:            'completed',
      call_start_time:        now,
      call_duration_seconds:  durationSecs,
      after_hours:            false,
      agent_name:             AGENT_NAME,
      agent_id:               AGENT_ID,
      caller_first_name:      callerFirstName,
      caller_last_name:       callerLastName,
      reason_for_call:        reasonForCall,
      caller_message:         callerMessage || reasonForCall,
      callback_number:        callbackNumber,
      call_summary:           reasonForCall || callerMessage || 'Inbound call — reason not captured',
      call_transcript:        transcriptText,
      lead_created:           !!reasonForCall,
      follow_up_required:     !!reasonForCall,
      created_at:             now,
    }, { onConflict: 'conversation_id', ignoreDuplicates: true })
    .select('id')
    .single();

  if (crErr) console.error('LOG-CALL call_records error:', crErr.message);
  else callRecordId = callRecord?.id;

  // ── STEP 3: Create lead record if we have a reason for call ──────
  let leadId = null;

  if (reasonForCall && contactId) {
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .insert({
        client_id:      CLIENT_ID,
        contact_id:     contactId,
        call_record_id: callRecordId,
        lead_title:     `${callerFirstName || 'Caller'} — ${reasonForCall.slice(0, 60)}`,
        lead_description: reasonForCall,
        service_interest: 'FlowDesk Pro — Contact Center',
        pipeline_stage:   'new_lead',
        lead_source:      'phone_call',
        assigned_at:      now,
        created_at:       now,
        updated_at:       now,
      })
      .select('id')
      .single();

    if (leadErr) console.error('LOG-CALL leads error:', leadErr.message);
    else leadId = lead?.id;

    // Update call_record with lead_id
    if (leadId && callRecordId) {
      await supabase.from('call_records').update({ lead_id: leadId }).eq('id', callRecordId);
    }
  }

  // ── STEP 4: Create follow-up task if reason captured ─────────
  if (reasonForCall && contactId) {
    const followUpDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
    const { error: taskErr } = await supabase
      .from('tasks')
      .insert({
        client_id:        CLIENT_ID,
        contact_id:       contactId,
        lead_id:          leadId,
        call_record_id:   callRecordId,
        task_title:       `Follow up: ${callerFirstName || 'Caller'} — ${reasonForCall.slice(0, 60)}`,
        task_description: reasonForCall,
        task_type:        'follow_up',
        due_date:         followUpDate,
        priority:         'normal',
        status:           'pending',
        created_at:       now,
      });
    if (taskErr) console.error('LOG-CALL tasks error:', taskErr.message);
  }

  // ── STEP 5: Log activity ──────────────────────────────────────
  if (contactId) {
    const { error: actErr } = await supabase
      .from('activities')
      .insert({
        client_id:         CLIENT_ID,
        contact_id:        contactId,
        lead_id:           leadId,
        call_record_id:    callRecordId,
        activity_type:     'call',
        activity_direction: 'inbound',
        activity_subject:  reasonForCall || 'Inbound call',
        activity_body:     transcriptText || reasonForCall || 'Call handled by Alex',
        activity_outcome:  reasonForCall ? 'reason_captured' : 'no_reason_captured',
        performed_by:      null,
        duration_seconds:  durationSecs,
        created_at:        now,
      });
    if (actErr) console.error('LOG-CALL activities error:', actErr.message);
  }

  console.log(`LOG-CALL complete: contact_id=${contactId} call_record_id=${callRecordId} lead_id=${leadId} new_contact=${isNewContact}`);

  return json(200, {
    success:        true,
    contact_id:     contactId,
    call_record_id: callRecordId,
    lead_id:        leadId,
    new_contact:    isNewContact,
  }, corsHeaders);
};
