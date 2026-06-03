'use strict';

// sync-elevenlabs-calls.js
// Polls ElevenLabs Conversations API for new calls and writes records to Supabase.
// Runs on a schedule (every 5 min) AND can be triggered manually via POST.
// Bypasses ElevenLabs webhook delivery entirely — pull instead of push.

const https = require('https');
const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { json } = require('./lib/flowdesk-response-utils');

const AGENT_ID  = 'agent_6101ksv5amdpfqn90z89gtvh34a7';
const TENANT_ID = process.env.CLIENT_TENANT_ID || 'apropos-ai4-businesses';
const SYNC_TABLE = 'call_sync_cursor';

// Extract caller name from transcript — Alex says "Thank you, [Name]" after collecting it
function extractCallerName(transcript) {
  if (!Array.isArray(transcript)) return null;
  for (const turn of transcript) {
    if (turn.role !== 'agent' || !turn.message) continue;
    // Alex confirms the name: "Thank you, Jeffrey Mitchell" or "Got it, Jeffrey"
    const thankYou = turn.message.match(/(?:Thank you|Got it|Great|Perfect|Hi|Hello)[,.]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
    if (thankYou) return thankYou[1].trim();
  }
  // Fallback: look in user turns for a name pattern (2-3 capitalized words)
  for (const turn of transcript) {
    if (turn.role !== 'user' || !turn.message) continue;
    const nameMatch = turn.message.match(/\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2})\b/);
    if (nameMatch && nameMatch[1].split(' ').length >= 2) return nameMatch[1].trim();
  }
  return null;
}

// Extract reason from transcript — user's response after Alex asks why they're calling
function extractReasonFromTranscript(transcript) {
  if (!Array.isArray(transcript)) return null;
  const callKeywords = ['reason', 'help', 'calling about', 'calling to', 'what can i'];
  for (let i = 0; i < transcript.length - 1; i++) {
    const turn = transcript[i];
    if (turn.role !== 'agent' || !turn.message) continue;
    const msgLower = turn.message.toLowerCase();
    if (callKeywords.some(k => msgLower.includes(k))) {
      const next = transcript[i + 1];
      if (next?.role === 'user' && next.message && next.message.length > 5) {
        return next.message.replace(/^(uh,?\s*|um,?\s*)/i, '').trim();
      }
    }
  }
  return null;
}

function httpsGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

function clean(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : null;
}

function buildTranscriptSummary(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return null;
  return transcript
    .map(t => `${t.role === 'agent' ? 'Alex' : 'Caller'}: ${t.message || ''}`)
    .join('\n')
    .slice(0, 2000);
}

async function getLastSyncedAt(supabase) {
  try {
    const { data } = await supabase
      .from(SYNC_TABLE)
      .select('last_synced_at')
      .eq('agent_id', AGENT_ID)
      .single();
    return data?.last_synced_at || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } catch {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }
}

async function updateLastSyncedAt(supabase, timestamp) {
  await supabase.from(SYNC_TABLE).upsert({
    agent_id: AGENT_ID,
    last_synced_at: timestamp,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent_id' });
}

async function fetchConversations(apiKey, after) {
  const url = `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${AGENT_ID}&cursor=&page_size=50`;
  const result = await httpsGet(url, {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
  });

  if (result.status !== 200) {
    console.error('[sync] ElevenLabs API error:', result.status, JSON.stringify(result.data).slice(0, 200));
    return [];
  }

  const conversations = result.data?.conversations || [];
  // Filter to only conversations after our last sync
  const afterMs = new Date(after).getTime();
  return conversations.filter(c => {
    const startMs = c.start_time_unix_secs ? c.start_time_unix_secs * 1000 : 0;
    return startMs > afterMs;
  });
}

async function fetchConversationDetail(apiKey, conversationId) {
  const url = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`;
  const result = await httpsGet(url, {
    'xi-api-key': apiKey,
    'Content-Type': 'application/json',
  });
  if (result.status !== 200) return null;
  return result.data;
}

async function processConversation(supabase, conv, apiKey) {
  const conversationId = conv.conversation_id || conv.id || null;

  if (!conversationId) {
    console.log('[sync] Skipping conversation with no ID:', JSON.stringify(conv).slice(0, 100));
    return false;
  }

  // Dedup: skip if call_record already exists for this conversation_id
  const { data: existingCall } = await supabase
    .from('call_records')
    .select('id')
    .eq('conversation_id', conversationId)
    .maybeSingle();

  if (existingCall) {
    console.log(`[sync] Already synced: ${conversationId}`);
    return false;
  }

  const detail = await fetchConversationDetail(apiKey, conversationId);

  if (detail) {
    console.log('[sync] Detail keys:', Object.keys(detail).join(', '));
    if (detail.metadata) console.log('[sync] Metadata:', JSON.stringify(detail.metadata).slice(0, 200));
    if (detail.conversation_initiation_client_data) console.log('[sync] Initiation data:', JSON.stringify(detail.conversation_initiation_client_data).slice(0, 200));
  }

  const transcript = detail?.transcript || conv.transcript || [];
  const collected  = detail?.data_collection_results || {};

  const callerPhone = clean(
    detail?.metadata?.phone_call?.external_number ||
    detail?.conversation_initiation_client_data?.dynamic_variables?.system__caller_id ||
    detail?.metadata?.phone_call?.caller_id ||
    conv.caller_id ||
    'Unknown',
    30
  );

  const summaryTitle = clean(conv.call_summary_title || conv.transcript_summary, 300);
  const durationSecs = conv.call_duration_secs ? Math.round(conv.call_duration_secs) : null;
  const startedAt    = conv.start_time_unix_secs ? new Date(conv.start_time_unix_secs * 1000).toISOString() : new Date().toISOString();

  const firstName      = clean(collected.first_name?.value, 60) || null;
  const lastName       = clean(collected.last_name?.value, 60) || null;
  const reasonRaw      = clean(collected.reason_for_call?.value, 500) || null;
  const contactType    = clean(collected.contact_type?.value, 30) || 'lead';
  const callerEmail    = clean(collected.email?.value, 200) || null;
  const leadPriority   = clean(collected.lead_priority?.value, 20) || null;
  const decisionTL     = clean(collected.decision_timeline?.value, 30) || null;
  const callerMessage  = clean(collected.caller_message?.value, 500) || null;
  const callbackNumber = clean(collected.callback_number?.value, 30) || null;

  const transcriptName   = extractCallerName(transcript);
  const transcriptReason = extractReasonFromTranscript(transcript);

  const reason       = reasonRaw || transcriptReason || summaryTitle || null;
  const resolvedName = [firstName, lastName].filter(Boolean).join(' ') || transcriptName || null;
  const contactName  = resolvedName || `Voice Lead — ${callerPhone !== 'Unknown' ? callerPhone : conversationId?.slice(-8)}`;

  const nameParts    = resolvedName ? resolvedName.split(' ') : [];
  const resolvedFirst = firstName || nameParts[0] || null;
  const resolvedLast  = lastName  || nameParts.slice(1).join(' ') || null;

  const summary = buildTranscriptSummary(transcript);

  console.log(`[sync] ${conversationId} | name="${contactName}" | phone="${callerPhone}" | reason="${reason?.slice(0,40)}"`);

  const now = new Date().toISOString();
  const CRM_CLIENT_ID   = process.env.CRM_CLIENT_ID || '10b8f727-cecd-4e20-9829-c0dfed181dde';
  const callerPhoneNorm = callerPhone !== 'Unknown' ? callerPhone : null;

  // ── contacts ─────────────────────────────────────────────────
  let crmContactId = null;
  if (callerPhoneNorm) {
    const { data: existingContact } = await supabase
      .from('contacts').select('id,lead_score').eq('caller_id', callerPhoneNorm).maybeSingle();
    if (existingContact) {
      crmContactId = existingContact.id;
      await supabase.from('contacts').update({
        updated_at: now, lead_score: (existingContact.lead_score || 0) + 1,
        ...(resolvedFirst  && !existingContact.first_name ? { first_name:        resolvedFirst  } : {}),
        ...(resolvedLast   && !existingContact.last_name  ? { last_name:         resolvedLast   } : {}),
        ...(callerEmail                                    ? { email:             callerEmail    } : {}),
        ...(leadPriority                                   ? { priority:          leadPriority   } : {}),
        ...(decisionTL                                     ? { decision_timeline: decisionTL    } : {}),
      }).eq('id', crmContactId);
    } else {
      const { data: nc } = await supabase.from('contacts').insert({
        caller_id: callerPhoneNorm, phone_primary: callerPhoneNorm, phone_normalized: callerPhoneNorm,
        first_name: resolvedFirst, last_name: resolvedLast,
        email: callerEmail, contact_type: contactType,
        priority: leadPriority, decision_timeline: decisionTL,
        lead_source: 'phone_call', lead_status: 'new',
        client_id: CRM_CLIENT_ID, created_at: startedAt, updated_at: now,
      }).select('id').single();
      if (nc) crmContactId = nc.id;
    }
  }

  // ── call_records ──────────────────────────────────────────────
  let crmCallId = null;
  const { data: cr, error: crErr } = await supabase.from('call_records').upsert({
    client_id: CRM_CLIENT_ID, contact_id: crmContactId, conversation_id: conversationId,
    caller_id: callerPhoneNorm, caller_phone_normalized: callerPhoneNorm,
    call_direction: 'inbound', call_status: 'completed',
    call_start_time: startedAt, call_duration_seconds: durationSecs,
    agent_name: 'Alex', agent_id: AGENT_ID,
    caller_first_name: resolvedFirst, caller_last_name: resolvedLast,
    reason_for_call: reason, caller_message: callerMessage || reason,
    callback_number: callbackNumber,
    call_summary: reason || callerMessage || summaryTitle || 'Inbound call',
    call_transcript: summary, lead_created: !!reason,
    follow_up_required: !!reason, created_at: startedAt,
  }, { onConflict: 'conversation_id', ignoreDuplicates: true }).select('id').single();
  if (crErr) console.error('[sync] call_records error:', crErr.message);
  else crmCallId = cr?.id;

  // ── leads ─────────────────────────────────────────────────────
  let crmLeadId = null;
  if (reason && crmContactId) {
    const { data: lead, error: leadErr } = await supabase.from('leads').insert({
      client_id: CRM_CLIENT_ID, contact_id: crmContactId, call_record_id: crmCallId,
      lead_title: `${resolvedFirst || 'Caller'} — ${reason.slice(0, 60)}`,
      lead_description: reason, service_interest: 'FlowDesk Pro — Contact Center',
      pipeline_stage: 'new_lead', lead_source: 'phone_call',
      assigned_at: startedAt, created_at: startedAt, updated_at: now,
    }).select('id').single();
    if (leadErr) console.error('[sync] leads error:', leadErr.message);
    else {
      crmLeadId = lead?.id;
      if (crmLeadId && crmCallId) {
        await supabase.from('call_records').update({ lead_id: crmLeadId }).eq('id', crmCallId);
      }
    }

    const followUp = new Date(new Date(startedAt).getTime() + 24*60*60*1000).toISOString();
    const { error: taskErr } = await supabase.from('tasks').insert({
      client_id: CRM_CLIENT_ID, contact_id: crmContactId, lead_id: crmLeadId, call_record_id: crmCallId,
      task_title: `Follow up: ${resolvedFirst || 'Caller'} — ${reason.slice(0, 60)}`,
      task_description: reason, task_type: 'follow_up', due_date: followUp,
      priority: 'normal', status: 'pending', created_at: startedAt,
    });
    if (taskErr) console.error('[sync] tasks error:', taskErr.message);
  }

  // ── activities ────────────────────────────────────────────────
  if (crmContactId) {
    const { error: actErr } = await supabase.from('activities').insert({
      client_id: CRM_CLIENT_ID, contact_id: crmContactId, lead_id: crmLeadId, call_record_id: crmCallId,
      activity_type: 'call', activity_direction: 'inbound',
      activity_subject: reason || 'Inbound call',
      activity_body: summary || reason || 'Call handled by Alex',
      activity_outcome: reason ? 'reason_captured' : 'no_reason_captured',
      performed_by: null, duration_seconds: durationSecs, created_at: startedAt,
    });
    if (actErr) console.error('[sync] activities error:', actErr.message);
  }

  console.log(`[sync] complete: contact=${crmContactId} call=${crmCallId} lead=${crmLeadId}`);
  return { wasNew: true, conversationId, callerPhone, crmContactId, crmCallId, crmLeadId };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: 'ELEVENLABS_API_KEY not configured' }, corsHeaders);

  // ?action=debug_detail — show raw detail for most recent conversation
  const qs = event.queryStringParameters || {};
  if (qs.action === 'debug_detail') {
    try {
      const listResult = await httpsGet(
        `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${AGENT_ID}&page_size=1`,
        { 'xi-api-key': apiKey }
      );
      const convs = (listResult.data?.conversations || listResult.data || []);
      if (!convs.length) return json(200, { ok: false, error: 'No conversations found' }, corsHeaders);
      const detail = await fetchConversationDetail(apiKey, convs[0].conversation_id);
      return json(200, {
        ok: true,
        conversation_id: convs[0].conversation_id,
        list_keys: Object.keys(convs[0]),
        detail_keys: detail ? Object.keys(detail) : [],
        metadata: detail?.metadata || null,
        conversation_initiation_client_data: detail?.conversation_initiation_client_data || null,
        custom_llm_extra_body: detail?.custom_llm_extra_body || null,
      }, corsHeaders);
    } catch (err) {
      return json(500, { ok: false, error: err.message }, corsHeaders);
    }
  }

  // Auth check for manual POST triggers (scheduled runs bypass this)
  const isScheduled = event.httpMethod === 'GET' || !event.httpMethod;
  if (!isScheduled && event.httpMethod === 'POST') {
    const patchSecret = process.env.PATCH_SECRET;
    if (patchSecret) {
      const provided = (event.headers['x-patch-secret'] || event.headers['X-Patch-Secret'] || '').trim();
      if (provided !== patchSecret) {
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
      }
    }
  }


  let supabase;
  try { supabase = getSupabaseAdmin(); }
  catch (e) { return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ ok: false, error: e.message }) }; }

  const lastSyncedAt = await getLastSyncedAt(supabase);
  console.log(`[sync] Syncing conversations after: ${lastSyncedAt}`);

  const conversations = await fetchConversations(apiKey, lastSyncedAt);
  console.log(`[sync] Found ${conversations.length} new conversations`);

  let synced = 0;
  const errors = [];
  for (const conv of conversations) {
    try {
      const result = await processConversation(supabase, conv, apiKey);
      if (result?.wasNew) {
        synced++;
      }
    } catch (err) {
      console.error('[sync] processConversation error:', err.message);
      errors.push({ error: err.message });
    }
  }

  // Update cursor to now
  await updateLastSyncedAt(supabase, new Date().toISOString());

  // Include first raw conversation for structure debugging
  const sample = conversations[0] ? {
    keys: Object.keys(conversations[0]),
    sample: JSON.stringify(conversations[0]).slice(0, 500)
  } : null;

  return json(200, {
    ok: true,
    synced,
    checked: conversations.length,
    last_synced_after: lastSyncedAt,
    message: `Synced ${synced} new call(s) from ElevenLabs`,
    errors: errors.length > 0 ? errors.slice(0, 3) : undefined,
    debug_sample: sample,
  }, corsHeaders);
};
