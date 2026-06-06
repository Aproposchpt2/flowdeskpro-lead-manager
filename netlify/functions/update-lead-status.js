'use strict';
// update-lead-status.js — updates lead_manager_records by id
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { json } = require('./lib/flowdesk-response-utils');

const TABLE = 'lead_manager_records';

const VALID_STATUSES = [
  'New / Needs Review',
  'New / Priority Review',
  'In Progress',
  'Closed / Resolved',
];

exports.handler = async (event) => {
  const cors = buildCorsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return handleOptions(cors);
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' }, cors);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }, cors); }

  const { id, lead_status, urgency, next_action, internal_notes, assigned_to, follow_up_needed } = body;

  if (!id) return json(400, { error: 'id is required' }, cors);

  const update = { updated_at: new Date().toISOString() };
  if (lead_status !== undefined) update.lead_status = lead_status;
  if (urgency     !== undefined) update.urgency = urgency;
  if (next_action !== undefined) update.next_action = next_action;
  if (internal_notes !== undefined) update.internal_notes = internal_notes;
  if (assigned_to !== undefined) update.assigned_to = assigned_to;
  if (follow_up_needed !== undefined) update.follow_up_needed = follow_up_needed;

  if (Object.keys(update).length === 1) {
    return json(400, { error: 'No fields to update' }, cors);
  }

  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.from(TABLE)
      .update(update)
      .eq('id', id)
      .select('id, lead_status, urgency, next_action, updated_at')
      .single();

    if (error) throw error;
    return json(200, { ok: true, record: data }, cors);

  } catch (err) {
    console.error('update-lead-status error:', err.message);
    return json(500, { error: err.message }, cors);
  }
};
