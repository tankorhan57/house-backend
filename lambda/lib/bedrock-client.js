const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const config = require('./config');

const client = new BedrockRuntimeClient({ region: config.region });

const MAX_TOKENS_BEFORE_EXTRACTION = 15000;
const CHARS_PER_TOKEN = 4; // rough estimate
const MAX_CHARS = MAX_TOKENS_BEFORE_EXTRACTION * CHARS_PER_TOKEN;

function truncateForExtraction(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + '\n\n[Document truncated for extraction — remaining content omitted]';
}

async function extractStructuredData(documentText) {
  const truncated = truncateForExtraction(documentText);

  const prompt = `You are extracting structured metadata from a medical document. Output JSON only.

Extract:
{
  "document_type": "blood_panel|mri_report|doctor_note|specialist_letter|prescription|imaging|other",
  "date_of_service": "YYYY-MM-DD or null if not found",
  "provider_name": "string or null",
  "body_part": "knee|shoulder|spine|heart|blood|other|multiple|null",
  "key_findings": ["finding 1", "finding 2"],
  "abnormal_values": [
    {
      "name": "CRP",
      "value": "2.4",
      "unit": "mg/L",
      "reference_range": "0.0-1.0",
      "direction": "high",
      "trend_flag": true
    }
  ],
  "follow_up_recommended": true,
  "urgency": "routine|soon|urgent|null"
}

If you cannot determine a field with confidence, use null.
Do not fabricate values. Only extract what is explicitly present in the document.

Document:
${truncated}`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId: config.bedrockModel,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(Buffer.from(response.body).toString());
  const text = responseBody.content[0].text;

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Bedrock response');

  return JSON.parse(jsonMatch[0]);
}

async function interpretDocument(documentText, extractedData) {
  const truncated = truncateForExtraction(documentText);

  const prompt = `You are House, a patient education tool. Explain this medical document in plain language a patient can understand.

You must:
- Use simple, clear language (no medical jargon without explanation)
- Highlight what is normal vs abnormal
- Explain what each finding means for the patient
- Generate 5 targeted questions to ask the doctor at the next appointment
- NEVER diagnose, recommend treatment, or impersonate a physician
- End with: "House is a patient education tool, not medical advice. Always consult a qualified medical professional."

Document type: ${extractedData.document_type}
Key findings from extraction: ${JSON.stringify(extractedData.key_findings)}

Full document:
${truncated}`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId: config.bedrockModel,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(Buffer.from(response.body).toString());
  return responseBody.content[0].text;
}

const EXTRACTION_SCHEMA = `{
  "document_type": "blood_panel|mri_report|doctor_note|specialist_letter|prescription|imaging|other",
  "date_of_service": "YYYY-MM-DD or null if not found",
  "provider_name": "string or null",
  "body_part": "knee|shoulder|spine|heart|blood|other|multiple|null",
  "key_findings": ["finding 1", "finding 2"],
  "abnormal_values": [
    {
      "name": "CRP",
      "value": "2.4",
      "unit": "mg/L",
      "reference_range": "0.0-1.0",
      "direction": "high",
      "trend_flag": true
    }
  ],
  "follow_up_recommended": true,
  "urgency": "routine|soon|urgent|null"
}`;

async function extractStructuredDataFromImage(visionContent) {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        visionContent,
        {
          type: 'text',
          text: `You are extracting structured metadata from this medical document image. Output JSON only.\n\nExtract:\n${EXTRACTION_SCHEMA}\n\nIf you cannot determine a field with confidence, use null. Do not fabricate values.`,
        },
      ],
    }],
  });

  const command = new InvokeModelCommand({
    modelId: config.bedrockModel,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(Buffer.from(response.body).toString());
  const text = responseBody.content[0].text;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Bedrock vision response');

  return JSON.parse(jsonMatch[0]);
}

module.exports = { extractStructuredData, extractStructuredDataFromImage, interpretDocument };
