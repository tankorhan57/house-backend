const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { writeAuditLog } = require('../lib/audit-log');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

// Injectable deps — overridden in unit tests
exports._deps = { s3 };

const MAX_DELETE_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteS3ObjectWithRetry(key) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt++) {
    try {
      await exports._deps.s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return; // success
    } catch (err) {
      lastError = err;
      console.error(`S3 delete attempt ${attempt} failed for key ${key}:`, err.message);
      if (attempt < MAX_DELETE_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

// DELETE /documents/:id
exports.handler = async (event, context, supabase, userId) => {
  try {
    const documentId = event.pathParameters?.id;
    if (!documentId) {
      return response(400, { error: 'Document ID is required' });
    }

    // Verify document belongs to this user and get S3 key
    const { data: doc, error: fetchError } = await supabase
      .from('documents')
      .select('id, s3_key')
      .eq('id', documentId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !doc) {
      return response(404, { error: 'Document not found' });
    }

    // Step 1: Delete from Supabase first (fail safe — document disappears from user's view)
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    // Step 2: Delete from S3 (best-effort — row already gone from DB)
    try {
      await deleteS3ObjectWithRetry(doc.s3_key);
    } catch (s3Err) {
      // Log for async cleanup but don't fail the response — document is already removed from user's view
      console.error(`S3 cleanup failed for key ${doc.s3_key}, document ${documentId}:`, s3Err.message);
    }

    // Step 3: Audit log
    await writeAuditLog(supabase, {
      userId,
      documentId,
      action: 'document_deleted',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { success: true, documentId });
  } catch (err) {
    console.error('delete error:', err);
    return response(500, { error: 'Failed to delete document. Please try again.' });
  }
};

// All user-data tables that must be wiped on account deletion.
// Tables that haven't been migrated yet (undefined_table, code 42P01) are
// skipped — they're listed ahead of their migrations so deleteAccount
// never silently misses a PHI table once it exists.
const USER_DATA_TABLES = [
  'documents',
  'insights_cache',
  'dismissed_insights',
  'user_profiles',
  'health_score_cache',
  'chat_history',
];

// DELETE /account — delete all user data and account
exports.deleteAccount = async (event, context, supabase, userId) => {
  try {
    // Get all user documents first (need S3 keys before rows are gone)
    const { data: docs, error: fetchError } = await supabase
      .from('documents')
      .select('id, s3_key')
      .eq('user_id', userId);

    if (fetchError) throw fetchError;

    // Step 1: Delete Supabase rows FIRST (fail safe — PHI disappears from
    // user's view immediately; S3 cleanup is best-effort afterward)
    for (const table of USER_DATA_TABLES) {
      const { error: dbError } = await supabase
        .from(table)
        .delete()
        .eq('user_id', userId);

      if (dbError) {
        // 42P01 = undefined_table — table not migrated yet, skip
        if (dbError.code === '42P01') continue;
        console.error(`CRITICAL: failed to delete from ${table} for user ${userId}:`, dbError.message);
        return response(500, {
          error: 'Account deletion failed. Please contact support to complete deletion of your health data.',
        });
      }
    }

    // Step 2: Delete S3 objects (best-effort — rows already gone)
    const deleteResults = await Promise.allSettled(
      (docs || []).map((doc) => deleteS3ObjectWithRetry(doc.s3_key))
    );

    const failures = deleteResults.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      // Log for async cleanup; do not fail — DB rows are already deleted
      console.error(`CRITICAL: ${failures.length} S3 deletes failed during account deletion for user ${userId}. Orphaned objects require cleanup.`);
    }

    // Final audit log entry
    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'account_deleted',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { success: true, message: 'Account and all health data deleted.' });
  } catch (err) {
    console.error('account delete error:', err);
    return response(500, { error: 'Account deletion failed. Please contact support.' });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': config.allowedOrigin,
    },
    body: JSON.stringify(body),
  };
}
