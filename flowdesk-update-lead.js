'use strict';

/**
 * FlowDesk Pro — Update Lead
 * netlify/functions/flowdesk-update-lead.js
 *
 * PATCH a lead record in flowdesk_intake_records.
 * Accepts: { id, intake_id, lead_status, internal_notes, next_action, follow_up_needed }
 */

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function clean(v) { return String(v || '').trim(); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: jsonHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { ok: false, error: 'Method not allowed' });
  }

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const serviceKey  = clean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const tableName   = clean(process.env.FLOWDESK_INTAKE_TABLE) || 'flowdesk_intake_records';

  if (!supabaseUrl || !serviceKey) {
    return response(500, { ok: false, error: 'Supabase environment variables are not configured.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { ok: false, error: 'Invalid JSON body.' });
  }

  const { id, intake_id, lead_status, internal_notes, next_action, follow_up_needed } = body;

  if (!id && !intake_id) {
    return response(400, { ok: false, error: 'id or intake_id is required.' });
  }

  // Build update payload — only defined fields
  const patch = {};
  if (lead_status   !== undefined) patch.lead_status     = lead_status;
  if (internal_notes !== undefined) patch.internal_notes = internal_notes;
  if (next_action   !== undefined) patch.next_action     = next_action;
  if (follow_up_needed !== undefined) patch.follow_up_needed = follow_up_needed;
  patch.updated_at = new Date().toISOString();

  // Build filter — prefer id (UUID), fall back to intake_id
  const filter = id
    ? `id=eq.${encodeURIComponent(id)}`
    : `intake_id=eq.${encodeURIComponent(intake_id)}`;

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}?${filter}`;

  try {
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!res.ok) {
      console.error('flowdesk-update-lead error:', res.status, data);
      return response(res.status, { ok: false, error: 'Failed to update lead.', details: data });
    }

    const updated = Array.isArray(data) ? data[0] : data;
    return response(200, { ok: true, record: updated });
  } catch (err) {
    console.error('flowdesk-update-lead exception:', err.message);
    return response(500, { ok: false, error: 'Unexpected server error.' });
  }
};

function response(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
