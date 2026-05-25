'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — update-lead
 * Updates CRM workflow fields for a single lead record.
 */

const {
  json,
  safeString,
  nowIso,
  getServerConfig,
  parseEventBody,
  supabaseRequest,
} = require('./config');

const ALLOWED_FIELDS = new Set([
  'lead_status',
  'urgency',
  'service_needed',
  'category',
  'preferred_contact_method',
  'preferred_callback_time',
  'message',
  'details',
  'ai_summary',
  'next_action',
  'internal_notes',
  'follow_up_needed',
  'assigned_to',
  'customer_status_message',
  'appointment_requested',
  'appointment_status',
  'external_crm_id',
  'metadata',
]);

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function normalizePatch(body) {
  const patch = {};

  Object.entries(body).forEach(([key, value]) => {
    if (!ALLOWED_FIELDS.has(key)) return;

    if (key === 'follow_up_needed' || key === 'appointment_requested') {
      patch[key] = parseBoolean(value);
      return;
    }

    if (key === 'metadata') {
      if (value && typeof value === 'object' && !Array.isArray(value)) patch[key] = value;
      return;
    }

    patch[key] = safeString(value);
  });

  if (Object.prototype.hasOwnProperty.call(patch, 'customer_status_message')) {
    patch.last_customer_update_at = patch.customer_status_message ? nowIso() : null;
  }

  patch.updated_at = nowIso();
  return patch;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (!['POST', 'PATCH'].includes(event.httpMethod)) {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  let body;
  try {
    body = await parseEventBody(event);
  } catch (error) {
    return json(400, { ok: false, error: error.message });
  }

  const id = safeString(body.id || body.record_id);
  if (!id) {
    return json(400, { ok: false, error: 'Lead record id is required.' });
  }

  const patch = normalizePatch(body);
  if (Object.keys(patch).length <= 1) {
    return json(400, { ok: false, error: 'No supported fields were provided for update.' });
  }

  try {
    const config = getServerConfig();
    const tenantId = safeString(body.tenant_id || config.tenantId);
    const params = new URLSearchParams();
    params.set('id', `eq.${id}`);
    if (tenantId) params.set('tenant_id', `eq.${tenantId}`);

    const updated = await supabaseRequest('PATCH', `${config.tableName}?${params.toString()}`, patch, {
      prefer: 'return=representation',
    });

    const record = Array.isArray(updated) && updated.length ? updated[0] : null;
    if (!record) {
      return json(404, { ok: false, error: 'Lead record was not found for this tenant.' });
    }

    return json(200, {
      ok: true,
      message: 'Lead updated successfully.',
      record,
    });
  } catch (error) {
    console.error('update-lead error:', error.message);
    return json(500, { ok: false, error: 'Unable to update lead record.' });
  }
};
