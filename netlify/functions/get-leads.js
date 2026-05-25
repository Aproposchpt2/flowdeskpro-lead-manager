'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — get-leads
 * Private dashboard endpoint. Loads lead records for the configured tenant.
 */

const {
  json,
  safeString,
  getServerConfig,
  supabaseRequest,
} = require('./config');

function statusBucket(status = '') {
  const value = String(status || '').toLowerCase();
  if (value.includes('closed') || value.includes('resolved') || value.includes('not a fit')) return 'closed';
  if (value.includes('priority')) return 'priority';
  if (value.includes('progress') || value.includes('contacted') || value.includes('waiting') || value.includes('scheduled') || value.includes('appointment')) return 'active';
  return 'new';
}

function sourceBucket(source = '', sourcePage = '') {
  const value = `${source || ''} ${sourcePage || ''}`.toLowerCase();
  if (value.includes('voice') || value.includes('call') || value.includes('twilio')) return 'voice';
  if (value.includes('sms') || value.includes('text')) return 'sms';
  if (value.includes('appointment')) return 'appointment';
  if (value.includes('web') || value.includes('intake')) return 'web';
  return 'other';
}

function urgencyBucket(urgency = '') {
  const value = String(urgency || '').toLowerCase();
  if (value.includes('high') || value.includes('urgent') || value.includes('asap')) return 'high';
  if (value.includes('low')) return 'low';
  return 'normal';
}

function buildSummary(records) {
  const total = records.length;
  const open = records.filter((r) => statusBucket(r.lead_status) !== 'closed').length;
  const needsReview = records.filter((r) => ['new', 'priority'].includes(statusBucket(r.lead_status))).length;
  const priority = records.filter((r) => statusBucket(r.lead_status) === 'priority' || urgencyBucket(r.urgency) === 'high').length;
  const followUp = records.filter((r) => r.follow_up_needed === true).length;
  const voice = records.filter((r) => sourceBucket(r.source, r.source_page) === 'voice').length;
  const web = records.filter((r) => sourceBucket(r.source, r.source_page) === 'web').length;

  return { total, open, needsReview, priority, followUp, voice, web };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  try {
    const config = getServerConfig();
    const qs = event.queryStringParameters || {};
    const limitRaw = Number(qs.limit || 150);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 150;
    const leadId = safeString(qs.id || qs.lead || '');
    const tenantId = safeString(qs.tenant_id || config.tenantId);

    const params = new URLSearchParams();
    params.set('select', '*');
    if (tenantId) params.set('tenant_id', `eq.${tenantId}`);
    if (leadId) params.set('id', `eq.${leadId}`);
    params.set('order', 'created_at.desc');
    params.set('limit', String(limit));

    const records = await supabaseRequest('GET', `${config.tableName}?${params.toString()}`, null, {
      prefer: '',
    });

    const safeRecords = Array.isArray(records) ? records : [];

    return json(200, {
      ok: true,
      records: safeRecords,
      summary: buildSummary(safeRecords),
      tenant_id: tenantId,
      count: safeRecords.length,
      loaded_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('get-leads error:', error.message);
    return json(500, { ok: false, error: 'Unable to load lead records.' });
  }
};
