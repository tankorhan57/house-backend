const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { extractAndInterpretFromImage, extractAndInterpretFromText, extractAndInterpretFromPDF } = require('../lib/bedrock-client');
const { extractTextFromPDF, extractTextFromImage, UserError } = require('../lib/pdf-ingestion');
const { normalizeBiomarker } = require('../lib/normalization');
const { writeAuditLog } = require('../lib/audit-log');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

// Injectable deps — overridden in unit tests
exports._deps = {
  s3,
  extractTextFromImage,
  extractTextFromPDF,
  extractAndInterpretFromImage,
  extractAndInterpretFromText,
  extractAndInterpretFromPDF,
};

function detectMimeFromBuffer(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  return 'application/octet-stream';
}

// POST /process
// Body: { documentId, key, fileName }
// userId comes from the verified JWT
exports.handler = async (event, context, supabase, userId) => {
  const { documentId, key, fileName } = JSON.parse(event.body || '{}');

  try {
    if (!documentId || !key) {
      return response(400, { error: 'documentId and key are required' });
    }

    // Verify the S3 key prefix belongs to this user before fetching
    // Keys are created by presign.js as `uploads/{userId}/{documentId}/{filename}`
    const expectedPrefix = `documents/${userId}/`;
    if (!key.startsWith(expectedPrefix)) {
      console.error(`IDOR attempt: userId=${userId} tried to access key=${key}`);
      return response(403, { error: 'Forbidden' });
    }

    // Step 0: Insert stub row with status='processing' so the frontend can
    // poll GET /documents/:id and error states are visible (N1)
    const { error: stubError } = await supabase.from('documents').insert({
      id: documentId,
      user_id: userId,
      s3_key: key,
      file_name: fileName || key.split('/').pop(),
      status: 'processing',
      created_at: new Date().toISOString(),
    });
    if (stubError) throw stubError;

    // Step 1: Fetch document from S3
    const s3Response = await exports._deps.s3.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));

    const chunks = [];
    for await (const chunk of s3Response.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Detect actual file type from magic bytes — ignore filename/ContentType which can be wrong
    const actualMime = detectMimeFromBuffer(buffer);

    // Step 2: Extract text or prepare vision input
    let documentText = null;
    let visionContent = null;
    let scannedPdfBuffer = null;

    if (actualMime === 'image/png' || actualMime === 'image/jpeg' || actualMime === 'image/webp' || actualMime === 'image/gif') {
      visionContent = await exports._deps.extractTextFromImage(buffer, actualMime);
    } else if (actualMime === 'application/pdf') {
      const result = await exports._deps.extractTextFromPDF(buffer);
      if (result.method === 'text') {
        documentText = result.text;
      } else {
        // Scanned PDF — use Claude's native PDF document support
        scannedPdfBuffer = buffer;
      }
    } else {
      throw new UserError('Unsupported file type. Please upload a PDF, JPG, or PNG.');
    }

    // Step 3: Extract structured data + interpretation in one Bedrock call
    let extraction, interpretation;
    if (visionContent) {
      ({ extraction, interpretation } = await exports._deps.extractAndInterpretFromImage(visionContent));
    } else if (scannedPdfBuffer) {
      ({ extraction, interpretation } = await exports._deps.extractAndInterpretFromPDF(scannedPdfBuffer));
    } else {
      ({ extraction, interpretation } = await exports._deps.extractAndInterpretFromText(documentText));
    }

    // Step 4: Normalize biomarker names
    if (extraction.abnormal_values) {
      extraction.abnormal_values = extraction.abnormal_values.map((biomarker) => {
        const { canonical, recognized } = normalizeBiomarker(biomarker.name);
        return { ...biomarker, canonical_name: canonical, recognized };
      });
    }

    // Step 6: Update the stub row with extraction results + status='done'
    const { error: dbError } = await supabase
      .from('documents')
      .update({
        document_type: extraction.document_type,
        date_of_service: extraction.date_of_service,
        provider_name: extraction.provider_name,
        body_part: extraction.body_part,
        key_findings: extraction.key_findings || [],
        abnormal_values: extraction.abnormal_values || [],
        follow_up_recommended: extraction.follow_up_recommended || false,
        urgency: extraction.urgency,
        interpretation,
        status: 'done',
      })
      .eq('id', documentId)
      .eq('user_id', userId);

    if (dbError) throw dbError;

    // Step 7: Audit log
    await writeAuditLog(supabase, {
      userId,
      documentId,
      action: 'document_uploaded',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { documentId, extraction, interpretation });

  } catch (err) {
    console.error('process error:', err);

    // Mark the stub row as errored (best-effort — row may not exist if the
    // stub insert itself failed)
    try {
      await supabase
        .from('documents')
        .update({ status: 'error' })
        .eq('id', documentId)
        .eq('user_id', userId);
    } catch (statusErr) {
      console.error('failed to set error status:', statusErr.message);
    }

    if (err instanceof UserError) {
      return response(400, { error: err.message });
    }

    return response(500, { error: 'Failed to process document. Please try again.' });
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
