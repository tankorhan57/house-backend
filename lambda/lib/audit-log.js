const { createServiceClient } = require('./supabase-client');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// Module-level singleton — reused across warm Lambda invocations
let serviceClientInstance = null;
function getServiceClient() {
  if (!serviceClientInstance) serviceClientInstance = createServiceClient();
  return serviceClientInstance;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAuditLog(supabase, { userId, documentId, action, ipAddress }) {
  const entry = {
    user_id: userId,
    document_id: documentId || null,
    action,
    ip_address: ipAddress || null,
    timestamp: new Date().toISOString(),
  };

  // Use service role client for audit writes — bypasses RLS so the
  // user cannot tamper with or suppress their own audit trail.
  // Client creation can throw (missing env vars) — must never block the
  // user's action, so treat it like any other audit failure.
  let serviceClient;
  try {
    serviceClient = getServiceClient();
  } catch (err) {
    console.error('CRITICAL: Audit log client init failed. HIPAA compliance gap.', {
      entry,
      error: err.message,
    });
    return;
  }
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await serviceClient.from('audit_log').insert(entry);
      if (error) throw error;
      return; // success
    } catch (err) {
      lastError = err;
      console.error(`Audit log write attempt ${attempt} failed:`, err.message);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  // All retries failed — log to CloudWatch, do not throw (never blocks user action)
  console.error('CRITICAL: Audit log write failed after all retries. HIPAA compliance gap.', {
    entry,
    error: lastError?.message,
  });
}

module.exports = { writeAuditLog };
