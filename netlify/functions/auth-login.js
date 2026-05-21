// netlify/functions/auth-login.js
// FlowDesk Pro — Magic Link Login Handler v3
// Simplified — sends magic link directly via Supabase signInWithOtp
// DB verification added back after portal is confirmed working

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email;
  try {
    ({ email } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  const cleanEmail = email.toLowerCase().trim();

  console.log(`Sending magic link to: ${cleanEmail}`);
  console.log(`SUPABASE_URL: ${process.env.SUPABASE_URL ? 'SET' : 'MISSING'}`);
  console.log(`SUPABASE_PUBLISHABLE_KEY: ${process.env.SUPABASE_PUBLISHABLE_KEY ? 'SET' : 'MISSING'}`);
  console.log(`FLOWDESK_SITE_URL: ${process.env.FLOWDESK_SITE_URL ? 'SET' : 'MISSING'}`);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY
  );

  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: {
      emailRedirectTo: `${process.env.FLOWDESK_SITE_URL}/dashboard.html`,
      shouldCreateUser: true,
    }
  });

  if (error) {
    console.error('signInWithOtp error:', error.message, error.status, error.code);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: `Failed to send login link: ${error.message}`
      })
    };
  }

  console.log(`Magic link sent successfully to: ${cleanEmail}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: 'If that email is registered, a login link is on its way.'
    })
  };
};
