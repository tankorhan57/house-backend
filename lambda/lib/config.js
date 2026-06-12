const config = {
  region: process.env.AWS_REGION || 'us-east-1',
  account: '014810124016',
  bucket: process.env.DOCS_BUCKET || 'house-v2-documents-014810124016',
  kmsKeyId: process.env.KMS_KEY_ID || 'e2edcbbc-f8af-42c9-bd9a-85c5d6d30208',
  bedrockModel: process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6',
  appRoleArn: 'arn:aws:iam::014810124016:role/house-v2-app-role',
  // CORS allowlist — set ALLOWED_ORIGIN in Lambda env to the frontend origin
  // (e.g. https://app.example.com). '*' only as local-dev fallback.
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
};

module.exports = config;
