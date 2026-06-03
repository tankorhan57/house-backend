const { createClient } = require('@supabase/supabase-js');

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// User-scoped client: respects RLS, operations run as the authenticated user
function createUserClient(jwtToken) {
  const supabaseUrl = getRequiredEnv('SUPABASE_URL');
  const supabaseAnonKey = getRequiredEnv('SUPABASE_ANON_KEY');

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${jwtToken}` },
    },
    auth: { persistSession: false },
  });
}

// Service-role client: bypasses RLS, used for audit log writes
// The service role key is never exposed to the frontend
function createServiceClient() {
  const supabaseUrl = getRequiredEnv('SUPABASE_URL');
  const serviceRoleKey = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

module.exports = { createUserClient, createServiceClient };
