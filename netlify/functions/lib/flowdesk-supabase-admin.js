'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabaseAdmin() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL environment variable is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is not set');

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}

module.exports = { getSupabaseAdmin };
