const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { extractStructuredData, interpretDocument, extractStructuredDataFromImage } = require('../lib/bedrock-client');
const { extractTextFromPDF, extractTextFromImage, UserError } = require('../lib/pdf-ingestion');
const { normalizeBiomarker } = require('../lib/normalization');
const { writeAuditLog } = require('../lib/audit-log');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

// POST /process
// Body: { documentId, key, fileName }
// userId comes from the verified JWT
exports.handler = async (event, context, supabase, userId) => {
  const { documentId, key, fileName } = JSON.parse(event.body || '{}');

  try {
    if (!documentId || !key) {
      return response(400, { error: 'documentId and key are required' });
    }

    // Step 1: Fetch document from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));

    const chunks = [];
    for await (const chunk of s3Response.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const contentType = s3Response.ContentType || '';
    const isImage = contentType.startsWith('image/');
    const isPdf = contentType.includes('pdf') || fileName?.toLowerCase().endsWith('.pdf');

    // Step 2: Extract text or prepare vision input
    let documentText = null;
    let visionContent = null;

    if (isPdf) {
      const result = await extractTextFromPDF(buffer);
      if (result.method === 'text') {
        documentText = result.text;
      } else {
        // Scanned PDF — send as image to Bedrock Vision
        visionContent = await extractTextFromImage(buffer, 'application/pdf');
      }
    } else if (isImage) {
      visionContent = await extractTextFromImage(buffer, contentType);
    } else {
      throw new UserError('Unsupported file type. Please upload a PDF, JPG, or PNG.');
    }

    // Step 3: Extract structured data via Bedrock
    let extraction;
    if (visionContent) {
      extraction = await extractStructuredDataFromImage(visionContent);
    } else {
      extraction = await extractStructuredData(documentText);
    }

    // Step 4: Normalize biomarker names
    if (extraction.abnormal_values) {
      extraction.abnormal_values = extraction.abnormal_values.map((biomarker) => {
        const { canonical, recognized } = normalizeBiomarker(biomarker.name);
        return { ...biomarker, canonical_name: canonical, recognized };
      });
    }

    // Step 5: Generate plain-language interpretation
    const interpretation = visionContent
      ? await interpretDocument('[scanned document — see extraction]', extraction)
      : await interpretDocument(documentText, extraction);

    // Step 6: Save to Supabase
    const { error: dbError } = await supabase.from('documents').insert({
      id: documentId,
      user_id: userId,
      s3_key: key,
      file_name: fileName || key.split('/').pop(),
      document_type: extraction.document_type,
      date_of_service: extraction.date_of_service,
      provider_name: extraction.provider_name,
      body_part: extraction.body_part,
      key_findings: extraction.key_findings || [],
      abnormal_values: extraction.abnormal_values || [],
      follow_up_recommended: extraction.follow_up_recommended || false,
      urgency: extraction.urgency,
      interpretation,
      created_at: new Date().toISOString(),
    });

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

    // Two-phase cleanup: delete S3 object on any failure
    if (key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        console.log('Cleaned up S3 object after failure:', key);
      } catch (deleteErr) {
        console.error('Failed to clean up S3 object:', key, deleteErr.message);
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
