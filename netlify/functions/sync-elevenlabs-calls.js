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
const SYNC_TABLE = 'call_sync_cursor'; // tracks last synced timestamp

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
  // ElevenLabs API returns conversation_id at top level
  const conversationId = conv.conversation_id || conv.id || null;

  if (!conversationId) {
    console.log('[sync] Skipping conversation with no ID:', JSON.stringify(conv).slice(0, 100));
    return false;
  }

  // Check if already synced
  const { data: existing } = await supabase
    .from('call_logs')
    .select('id')
    .eq('call_sid', conversationId)
    .maybeSingle();

  if (existing) {
    console.log(`[sync] Already synced: ${conversationId}`);
    return false;
  }

  // Fetch full conversation detail for transcript + data collection
  const detail = await fetchConversationDetail(apiKey, conversationId);

  // Log detail structure for phone number field discovery
  if (detail) {
    console.log('[sync] Detail keys:', Object.keys(detail).join(', '));
    if (detail.metadata) console.log('[sync] Metadata:', JSON.stringify(detail.metadata).slice(0, 200));
    if (detail.conversation_initiation_client_data) console.log('[sync] Initiation data:', JSON.stringify(detail.conversation_initiation_client_data).slice(0, 200));
  }

  const transcript = detail?.transcript || conv.transcript || [];
  const collected  = detail?.data_collection_results || {};

  // Phone number: search full detail object for phone/caller fields
  const callerPhone = clean(
    detail?.metadata?.phone_number ||
    detail?.metadata?.caller_id ||
    detail?.metadata?.caller_phone_number ||
    detail?.call_metadata?.caller_phone_number ||
    detail?.conversation_initiation_client_data?.metadata?.phone_number ||
    detail?.conversation_initiation_client_data?.conversation?.phone_number ||
    conv.caller_id ||
    'Unknown',
    30
  );

  // call_summary_title from list is the best available reason for call
  const summaryTitle = clean(conv.call_summary_title || conv.transcript_summary, 300);
  const durationSecs = conv.call_duration_secs ? Math.round(conv.call_duration_secs) : null;
  const startedAt  = conv.start_time_unix_secs ? new Date(conv.start_time_unix_secs * 1000).toISOString() : new Date().toISOString();

  // Extract data-collected fields from conversation detail
  const firstName  = clean(collected.caller_first_name?.value, 60) || null;
  const lastName   = clean(collected.caller_last_name?.value, 60) || null;
  const reason     = clean(collected.reason_for_call?.value, 500) || summaryTitle || null;
  const contactName = [firstName, lastName].filter(Boolean).join(' ') || null;
  const summary    = buildTranscriptSummary(transcript);

  console.log(`[sync] Processing: ${conversationId} | name="${contactName}" | phone="${callerPhone}" | reason="${reason?.slice(0,40)}"`);

  const now = new Date().toISOString();

  const [callLogResult, leadResult] = await Promise.allSettled([
    supabase.from('call_logs').insert({
      caller_phone:     callerPhone,
      call_sid:         conversationId,
      call_status:      'completed',
      duration_seconds: durationSecs,
      outcome:          'completed',
      lead_created:     true,
      is_demo:          false,
      created_at:       startedAt,
    }).select('id').single(),

    supabase.from('lead_manager_records').insert({
      tenant_id:             TENANT_ID,
      contact_name:          contactName || `Voice Lead — ${callerPhone !== 'Unknown' ? callerPhone : conversationId?.slice(-8) || 'Unknown'}`,
      first_name:            firstName,
      last_name:             lastName,
      phone:                 callerPhone,
      call_sid:              conversationId,
      source:                'voice_agent',
      source_page:           'ElevenLabs Alex — Contact Center',
      channel:               'voice',
      lead_status:           reason ? 'New / Needs Review' : 'New / Priority Review',
      service_needed:        reason || 'Inbound call — Contact Center',
      message:               reason || null,
      details:               reason
                               ? `${contactName || 'Caller'} called about: ${reason}`
                               : summary || `Inbound call. Phone: ${callerPhone}.`,
      call_status:           'completed',
      call_duration_seconds: durationSecs,
      missed_call:           false,
      follow_up_needed:      true,
      ai_call_summary:       summary,
      transcript:            summary,
      campaign_source:       'voice_agent',
      campaign_medium:       'voice',
      campaign_name:         'FlowDesk Pro Contact Center',
      next_action:           reason
                               ? `Follow up with ${contactName || 'caller'} regarding: ${reason.slice(0,100)}`
                               : 'Review call and follow up.',
      created_at:            startedAt,
      updated_at:            now,
      metadata: {
        conversation_id: conversationId,
        agent:           'Alex',
        platform:        'ElevenLabs',
        sync_method:     'api_poll',
      },
    }).select('id').single(),
  ]);

  const callLogErr = callLogResult.status === 'rejected'
    ? (callLogResult.reason?.message || JSON.stringify(callLogResult.reason))
    : (callLogResult.value?.error?.message || null);
  const leadErr = leadResult.status === 'rejected'
    ? (leadResult.reason?.message || JSON.stringify(leadResult.reason))
    : (leadResult.value?.error?.message || null);

  if (callLogErr) console.error('[sync] call_logs error:', callLogErr);
  if (leadErr)    console.error('[sync] lead_manager_records error:', leadErr);

  // Return errors for debugging
  return { wasNew: true, callLogErr, leadErr, conversationId, callerPhone };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin;
  const corsHeaders = buildCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return handleOptions(origin);

  // Auth check for manual triggers
  if (event.httpMethod === 'POST') {
    const patchSecret = process.env.PATCH_SECRET;
    if (patchSecret) {
      const provided = (event.headers['x-patch-secret'] || event.headers['X-Patch-Secret'] || '').trim();
      if (provided !== patchSecret) {
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
      }
    }
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ ok: false, error: 'ELEVENLABS_API_KEY not configured' }) };
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
        if (result.callLogErr || result.leadErr) {
          errors.push({ id: result.conversationId, callLogErr: result.callLogErr, leadErr: result.leadErr });
        }
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
