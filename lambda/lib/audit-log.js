const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

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

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await supabase.from('audit_log').insert(entry);

      if (error) throw error;
      return; // success
    } catch (err) {
      lastError = err;
      console.error(`Audit log write attempt ${attempt} failed:`, err.message);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  // All retries failed — log to CloudWatch and alert
  console.error('CRITICAL: Audit log write failed after all retries. HIPAA compliance gap.', {
    entry,
    error: lastError?.message,
  });

  // In production, this should trigger a CloudWatch alarm
  // The error is logged but not thrown — audit log failure should not block the user action
}

module.exports = { writeAuditLog };
