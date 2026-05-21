// netlify/functions/config.js
// FlowDesk Pro — Public Config Endpoint
// Serves the Supabase URL and publishable key to the dashboard
// These are safe to expose to the browser — no secret keys here

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    // Cache for 5 minutes — config doesn't change often
    'Cache-Control': 'public, max-age=300',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY env vars');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Portal configuration error. Contact support.' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      supabaseUrl,
      supabaseKey,
    }),
  };
};
