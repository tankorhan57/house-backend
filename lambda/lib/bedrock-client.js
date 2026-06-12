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

/**
 * Single entry point for all Bedrock calls. Returns the raw text of the
 * first content block. All new handlers (insights, chat, score) MUST use
 * this helper rather than building InvokeModelCommand inline.
 */
async function callBedrock(messages, maxTokens) {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages,
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

/**
 * Parse a JSON object out of a Bedrock text response. Strips markdown
 * code fences (```json ... ```) before matching, since models sometimes
 * wrap JSON despite instructions.
 */
function parseJSONResponse(text, label) {
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON found in Bedrock ${label} response`);
  return JSON.parse(jsonMatch[0]);
}

function validateCombined(result) {
  if (!result.extraction || !result.interpretation) {
    throw new Error('Invalid combined response structure');
  }
  return result;
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

const COMBINED_PROMPT_INSTRUCTIONS = `You are a medical document analyzer and patient education tool. Analyze this medical document and respond with a JSON object containing two keys: "extraction" and "interpretation".

"extraction" must follow this schema exactly:
${EXTRACTION_SCHEMA}

"interpretation" must be a plain-language explanation for the patient:
- Use simple, clear language (no medical jargon without explanation)
- Highlight what is normal vs abnormal
- Explain what each finding means for the patient
- Generate 5 targeted questions to ask the doctor at the next appointment
- NEVER diagnose, recommend treatment, or impersonate a physician
- End with: "House is a patient education tool, not medical advice. Always consult a qualified medical professional."

If you cannot determine a field in extraction with confidence, use null. Do not fabricate values. Never state or imply that the patient has a specific condition. Never recommend starting, stopping, or changing any medication or treatment.

Respond ONLY with raw JSON in this format (no markdown fences, no commentary):
{"extraction": {...}, "interpretation": "..."}`;

async function extractStructuredData(documentText) {
  const truncated = truncateForExtraction(documentText);

  const prompt = `You are extracting structured metadata from a medical document. Output raw JSON only — no markdown fences, no commentary.

Extract:
${EXTRACTION_SCHEMA}

If you cannot determine a field with confidence, use null.
Do not fabricate values. Only extract what is explicitly present in the document.

Document:
${truncated}`;

  const text = await callBedrock([{ role: 'user', content: prompt }], 2048);
  return parseJSONResponse(text, 'extraction');
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

  return callBedrock([{ role: 'user', content: prompt }], 4096);
}

async function extractStructuredDataFromImage(visionContent) {
  const messages = [{
    role: 'user',
    content: [
      visionContent,
      {
        type: 'text',
        text: `You are extracting structured metadata from this medical document image. Output raw JSON only — no markdown fences, no commentary.\n\nExtract:\n${EXTRACTION_SCHEMA}\n\nIf you cannot determine a field with confidence, use null. Do not fabricate values.`,
      },
    ],
  }];

  const text = await callBedrock(messages, 2048);
  return parseJSONResponse(text, 'vision');
}

async function extractAndInterpretFromImage(visionContent) {
  const messages = [{
    role: 'user',
    content: [
      visionContent,
      { type: 'text', text: COMBINED_PROMPT_INSTRUCTIONS },
    ],
  }];

  const text = await callBedrock(messages, 6144);
  return validateCombined(parseJSONResponse(text, 'combined'));
}

async function extractAndInterpretFromPDF(pdfBuffer) {
  const messages = [{
    role: 'user',
    content: [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      },
      { type: 'text', text: COMBINED_PROMPT_INSTRUCTIONS },
    ],
  }];

  const text = await callBedrock(messages, 6144);
  return validateCombined(parseJSONResponse(text, 'PDF'));
}

async function extractAndInterpretFromText(documentText) {
  const truncated = truncateForExtraction(documentText);

  const messages = [{
    role: 'user',
    content: `${COMBINED_PROMPT_INSTRUCTIONS}\n\nDocument:\n${truncated}`,
  }];

  const text = await callBedrock(messages, 6144);
  return validateCombined(parseJSONResponse(text, 'combined text'));
}

module.exports = {
  callBedrock,
  parseJSONResponse,
  extractStructuredData,
  extractStructuredDataFromImage,
  interpretDocument,
  extractAndInterpretFromImage,
  extractAndInterpretFromText,
  extractAndInterpretFromPDF,
};
