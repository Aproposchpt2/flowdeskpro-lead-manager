const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async () => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const tableName = process.env.FLOWDESK_INTAKE_TABLE || 'flowdesk_intake_records';

  const result = {
    ok: true,
    function: 'flowdesk-voice-health',
    checks: {
      SUPABASE_URL: Boolean(supabaseUrl),
      SUPABASE_SERVICE_KEY_OR_ROLE: Boolean(serviceKey),
      RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
      RESEND_FROM_EMAIL: Boolean(process.env.RESEND_FROM_EMAIL),
      RESEND_TO_EMAIL: Boolean(process.env.RESEND_TO_EMAIL),
      FLOWDESK_INTAKE_TABLE: tableName
    },
    tableRead: null
  };

  if (supabaseUrl && serviceKey) {
    try {
      const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}?select=id,created_at,source_page,category,business_name,phone&order=created_at.desc&limit=1`;
      const response = await fetch(endpoint, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json().catch(() => null);
      result.tableRead = { ok: response.ok, status: response.status, data };
    } catch (error) {
      result.tableRead = { ok: false, error: error.message };
    }
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(result, null, 2) };
};
