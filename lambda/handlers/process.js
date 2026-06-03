const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { extractStructuredData, interpretDocument } = require('../lib/bedrock-client');
const { extractTextFromPDF, UserError } = require('../lib/pdf-ingestion');
const { normalizeBiomarker } = require('../lib/normalization');
const { writeAuditLog } = require('../lib/audit-log');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

// POST /process
// Body: { documentId, key, userId, fileName }
// Returns: { documentId, extraction, interpretation }
exports.handler = async (event, context, supabase) => {
  const { documentId, key, userId, fileName } = JSON.parse(event.body || '{}');
  let s3ObjectExists = true;

  try {
    if (!documentId || !key || !userId) {
      return response(400, { error: 'documentId, key, and userId are required' });
    }

    // Step 1: Fetch document from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));

    const chunks = [];
    for await (const chunk of s3Response.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Step 2: Extract text from PDF/image
    let documentText;
    const contentType = s3Response.ContentType || '';

    if (contentType.includes('pdf') || fileName?.toLowerCase().endsWith('.pdf')) {
      const result = await extractTextFromPDF(buffer);
      if (result.method === 'vision') {
        // Scanned PDF — use base64 image for Bedrock Vision
        documentText = `[SCANNED_DOCUMENT base64:${buffer.toString('base64').slice(0, 100)}...]`;
        // In production: pass buffer to Bedrock Vision directly
      } else {
        documentText = result.text;
      }
    } else {
      // Image file — convert to base64 for vision
      documentText = `[IMAGE base64:${buffer.toString('base64').slice(0, 100)}...]`;
    }

    // Step 3: Extract structured data via Bedrock
    const extraction = await extractStructuredData(documentText);

    // Step 4: Normalize biomarker names
    if (extraction.abnormal_values) {
      extraction.abnormal_values = extraction.abnormal_values.map((biomarker) => {
        const { canonical, recognized } = normalizeBiomarker(biomarker.name);
        return {
          ...biomarker,
          canonical_name: canonical,
          recognized,
        };
      });
    }

    // Step 5: Generate plain-language interpretation
    const interpretation = await interpretDocument(documentText, extraction);

    // Step 6: Save to Supabase (two-phase complete)
    const { error: dbError } = await supabase.from('documents').insert({
      id: documentId,
      user_id: userId,
      s3_key: key,
      file_name: fileName,
      document_type: extraction.document_type,
      date_of_service: extraction.date_of_service,
      provider_name: extraction.provider_name,
      body_part: extraction.body_part,
      key_findings: extraction.key_findings,
      abnormal_values: extraction.abnormal_values,
      follow_up_recommended: extraction.follow_up_recommended,
      urgency: extraction.urgency,
      interpretation,
      created_at: new Date().toISOString(),
    });

    if (dbError) throw dbError;

    // Step 7: Write audit log
    await writeAuditLog(supabase, {
      userId,
      documentId,
      action: 'document_uploaded',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { documentId, extraction, interpretation });

  } catch (err) {
    console.error('process error:', err);

    // Two-phase cleanup: delete S3 object on any failure after upload
    if (s3ObjectExists && key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        console.log('Cleaned up S3 object after processing failure:', key);
      } catch (deleteErr) {
        console.error('Failed to clean up S3 object:', deleteErr);
      }
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
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
