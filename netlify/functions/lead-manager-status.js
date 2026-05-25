'use strict';

/**
 * FlowDesk Pro Lead Manager V1 — Twilio status callback
 * Safely records latest call status against lead_manager_records by call_sid.
 */

const {
  json,
  safeString,
  nowIso,
  getServerConfig,
  parseEventBody,
  supabaseRequest,
} = require('./config');

async function findLeadByCallSid(callSid, tenantId) {
  const config = getServerConfig();
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('call_sid', `eq.${callSid}`);
  if (tenantId) params.set('tenant_id', `eq.${tenantId}`);
  params.set('limit', '1');

  const result = await supabaseRequest('GET', `${config.tableName}?${params.toString()}`, null, {
    prefer: '',
  });

  return Array.isArray(result) && result.length ? result[0] : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  let body = {};
  try {
    body = event.httpMethod === 'POST' ? await parseEventBody(event) : {};
  } catch (error) {
    console.error('lead-manager-status parse error:', error.message);
  }

  try {
    const config = getServerConfig();
    const qs = event.queryStringParameters || {};
    const callSid = safeString(body.CallSid || qs.CallSid || qs.call_sid);
    const callStatus = safeString(body.CallStatus || qs.CallStatus || qs.status);
    const callDuration = safeString(body.CallDuration || qs.CallDuration || qs.duration);
    const tenantId = safeString(body.tenant_id || qs.tenant_id || config.tenantId);

    if (!callSid) {
      return json(200, { ok: true, skipped: true, reason: 'No CallSid provided.' });
    }

    const record = await findLeadByCallSid(callSid, tenantId);
    if (!record) {
      return json(200, { ok: true, skipped: true, reason: 'No matching lead record found.', call_sid: callSid });
    }

    const mergedMetadata = {
      ...(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
      latest_call_status: callStatus,
      latest_call_duration: callDuration,
      latest_status_received_at: nowIso(),
    };

    const params = new URLSearchParams();
    params.set('id', `eq.${record.id}`);
    params.set('tenant_id', `eq.${tenantId}`);

    const updated = await supabaseRequest('PATCH', `${config.tableName}?${params.toString()}`, {
      updated_at: nowIso(),
      metadata: mergedMetadata,
    }, {
      prefer: 'return=representation',
    });

    return json(200, {
      ok: true,
      call_sid: callSid,
      status: callStatus,
      record: Array.isArray(updated) && updated.length ? updated[0] : record,
    });
  } catch (error) {
    console.error('lead-manager-status error:', error.message);
    return json(500, { ok: false, error: 'Unable to process call status callback.' });
  }
};
