// netlify/functions/auth-claim.js
// FlowDesk Pro — Portal User Claim Handler v2
// Called by dashboard after magic link redirect
// Links Supabase auth session to clients/agencies row in portal_users

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Get token from Authorization header
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  console.log('auth-claim called');
  console.log('Token present:', token ? 'YES' : 'NO');
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING');
  console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');

  if (!token) {
    console.error('No token provided');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized — no token' }) };
  }

  // Use publishable key to verify the user token
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY
  );

  // Use service role for DB operations
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify token and get user
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);

  console.log('User lookup result:', user ? `Found: ${user.email}` : 'Not found');
  if (userError) console.error('User error:', userError.message);

  if (userError || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }

  const email = user.email?.toLowerCase().trim();
  const authUserId = user.id;

  console.log('Looking up portal_users for auth_user_id:', authUserId);

  // Check if portal_users row already exists
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('portal_users')
    .select('*')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (existingError) console.error('portal_users lookup error:', existingError.message);

  if (existing) {
    console.log('Existing portal_user found:', existing.role);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, portal_user: existing })
    };
  }

  console.log('No existing portal_user — looking up client/agency for email:', email);

  // Find matching client
  const { data: clientRow, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id, plan, status, business_name')
    .eq('resend_to_email', email)
    .eq('status', 'active')
    .maybeSingle();

  if (clientError) console.error('Client lookup error:', clientError.message);
  console.log('Client row found:', clientRow ? clientRow.business_name : 'None');

  // Find matching agency if no client
  let agencyRow = null;
  if (!clientRow) {
    const { data: agency, error: agencyError } = await supabaseAdmin
      .from('agencies')
      .select('id, plan, status, business_name')
      .eq('owner_email', email)
      .eq('status', 'active')
      .maybeSingle();

    if (agencyError) console.error('Agency lookup error:', agencyError.message);
    agencyRow = agency;
    console.log('Agency row found:', agencyRow ? agencyRow.business_name : 'None');
  }

  // If neither found — create a default client entry so they can still log in
  if (!clientRow && !agencyRow) {
    console.log('No client or agency found for email — creating default portal access');

    // Insert a new client row for this user
    const { data: newClient, error: newClientError } = await supabaseAdmin
      .from('clients')
      .insert({
        business_name: 'New Client',
        plan: 'starter',
        status: 'active',
        resend_to_email: email,
      })
      .select()
      .single();

    if (newClientError) {
      console.error('Failed to create default client:', newClientError.message);
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'No active account found. Contact support@aiflowdeskpro.com' })
      };
    }

    // Create portal_users row for new client
    const { data: newPortalUser, error: puError } = await supabaseAdmin
      .from('portal_users')
      .insert({
        auth_user_id: authUserId,
        client_id: newClient.id,
        agency_id: null,
        role: 'client'
      })
      .select()
      .single();

    if (puError) {
      console.error('portal_users insert error:', puError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create portal account' }) };
    }

    console.log('Default portal_user created successfully');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, portal_user: newPortalUser, role: 'client' })
    };
  }

  const role = agencyRow ? 'agency_owner' : 'client';
  console.log('Creating portal_users row — role:', role);

  const { data: newPortalUser, error: insertError } = await supabaseAdmin
    .from('portal_users')
    .insert({
      auth_user_id: authUserId,
      client_id: clientRow?.id || null,
      agency_id: agencyRow?.id || null,
      role
    })
    .select()
    .single();

  if (insertError) {
    console.error('portal_users insert error:', insertError.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create portal account. Contact support.' })
    };
  }

  console.log('portal_user created successfully:', role);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, portal_user: newPortalUser, role })
  };
};
