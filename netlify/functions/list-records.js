'use strict';
// list-records.js — reads from lead_manager_records (the live dashboard source)
const { getSupabaseAdmin } = require('./lib/flowdesk-supabase-admin');
const { buildCorsHeaders, handleOptions } = require('./lib/flowdesk-cors');
const { json } = require('./lib/flowdesk-response-utils');

const TABLE = 'lead_manager_records';
const PAGE_SIZE = 50;

exports.handler = async (event) => {
  const cors = buildCorsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return handleOptions(cors);
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' }, cors);

  const p = event.queryStringParameters || {};
  const page    = Math.max(0, parseInt(p.page || '0', 10));
  const search  = (p.search || '').trim();
  const status  = (p.status || '').trim();
  const urgency = (p.urgency || '').trim();
  const source  = (p.source || '').trim();

  try {
    const sb = getSupabaseAdmin();

    // Main query — select display columns only
    let q = sb.from(TABLE).select(
      'id, created_at, contact_name, first_name, last_name, email, phone, ' +
      'business_name, company, source, channel, source_page, lead_status, ' +
      'urgency, service_needed, category, ai_summary, next_action, ' +
      'follow_up_needed, appointment_requested, assigned_to, metadata',
      { count: 'exact' }
    );

    if (status)  q = q.eq('lead_status', status);
    if (urgency) q = q.eq('urgency', urgency);
    if (source)  q = q.eq('source', source);
    if (search)  q = q.or(
      `contact_name.ilike.%${search}%,` +
      `business_name.ilike.%${search}%,` +
      `email.ilike.%${search}%,` +
      `phone.ilike.%${search}%`
    );

    q = q.order('created_at', { ascending: false })
         .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    // Stats (always unfiltered for the metric bar)
    const { data: stats } = await sb.from(TABLE).select(
      'lead_status, urgency, follow_up_needed'
    );
    const all = stats || [];
    const metrics = {
      total:      all.length,
      new_review: all.filter(r => !r.lead_status || r.lead_status.toLowerCase().includes('new') || r.lead_status.toLowerCase().includes('review')).length,
      follow_up:  all.filter(r => r.follow_up_needed === true).length,
      high:       all.filter(r => (r.urgency || '').toLowerCase() === 'high' || (r.urgency || '').toLowerCase() === 'urgent').length,
    };

    return json(200, {
      records: data || [],
      total: count || 0,
      page,
      page_size: PAGE_SIZE,
      metrics,
    }, cors);

  } catch (err) {
    console.error('list-records error:', err.message);
    return json(500, { error: err.message }, cors);
  }
};
