const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');

const s3 = new S3Client({ region: config.region });

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const URL_EXPIRY_SECONDS = 300; // 5 minutes

// POST /presign
// Body: { fileName, fileType, fileSize, userId }
// Returns: { uploadUrl, documentId, key }
exports.handler = async (event) => {
  try {
    const { fileName, fileType, fileSize, userId } = JSON.parse(event.body || '{}');

    if (!fileName || !fileType || !fileSize || !userId) {
      return response(400, { error: 'fileName, fileType, fileSize, and userId are required' });
    }

    if (!ALLOWED_TYPES.includes(fileType)) {
      return response(400, { error: 'Only PDF, JPG, and PNG files are supported' });
    }

    if (fileSize > MAX_FILE_SIZE) {
      return response(400, { error: 'File too large. Maximum size is 20MB.' });
    }

    const documentId = uuidv4();
    const ext = fileName.split('.').pop().toLowerCase();
    const key = `documents/${userId}/${documentId}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: fileType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.kmsKeyId,
      Metadata: {
        'user-id': userId,
        'document-id': documentId,
        'original-name': encodeURIComponent(fileName),
      },
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRY_SECONDS });

    return response(200, { uploadUrl, documentId, key });
  } catch (err) {
    console.error('presign error:', err);
    return response(500, { error: 'Failed to generate upload URL' });
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
