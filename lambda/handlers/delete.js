const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { writeAuditLog } = require('../lib/audit-log');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

const MAX_DELETE_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteS3ObjectWithRetry(key) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt++) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
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

    // Step 1: Delete from S3 (with retry)
    await deleteS3ObjectWithRetry(doc.s3_key);

    // Step 2: Delete from Supabase
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

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

// DELETE /account — delete all user documents and account
exports.deleteAccount = async (event, context, supabase, userId) => {
  try {
    // Get all user documents
    const { data: docs, error: fetchError } = await supabase
      .from('documents')
      .select('id, s3_key')
      .eq('user_id', userId);

    if (fetchError) throw fetchError;

    // Delete all S3 objects (with retry per object)
    const deleteResults = await Promise.allSettled(
      (docs || []).map((doc) => deleteS3ObjectWithRetry(doc.s3_key))
    );

    const failures = deleteResults.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`CRITICAL: ${failures.length} S3 deletes failed during account deletion for user ${userId}`);
      return response(500, {
        error: 'Account deletion partially failed. Please contact support to complete deletion of your health data.',
      });
    }

    // Delete all Supabase records
    const { error: dbError } = await supabase
      .from('documents')
      .delete()
      .eq('user_id', userId);

    if (dbError) throw dbError;

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
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
