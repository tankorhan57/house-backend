const pdfParse = require('pdf-parse');

const MAX_PAGES = 50;
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

async function extractTextFromPDF(buffer) {
  // Size guard
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new UserError(`This document is too large (max ${MAX_FILE_SIZE_MB}MB). Please upload a smaller file.`);
  }

  // Try text extraction first
  try {
    const data = await pdfParse(buffer, { max: MAX_PAGES });

    // Check if encrypted (pdf-parse returns empty text for encrypted PDFs)
    if (data.text && data.text.trim().length > 50) {
      return { text: data.text, method: 'text', pages: data.numpages };
    }

    // If text is empty, it's likely a scanned PDF — fall through to vision
  } catch (err) {
    if (err.message && (
      err.message.includes('Password') ||
      err.message.includes('encrypted') ||
      err.message.includes('password')
    )) {
      throw new UserError(
        'This PDF is password-protected. Please remove the password and re-upload.'
      );
    }
    // Other parse errors — try vision fallback
  }

  // Scanned PDF — return buffer for vision processing
  return { buffer, method: 'vision', pages: null };
}

async function extractTextFromImage(imageBuffer, mimeType = 'image/jpeg') {
  // Normalize media type to values Bedrock accepts
  const MEDIA_TYPE_MAP = {
    'image/jpg': 'image/jpeg',
    'image/jpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/gif': 'image/gif',
    'image/webp': 'image/webp',
  };
  const normalizedType = MEDIA_TYPE_MAP[mimeType] || 'image/jpeg';

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: normalizedType,
      data: imageBuffer.toString('base64'),
    },
  };
}

// Custom error class for user-facing errors
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
  }
}

module.exports = { extractTextFromPDF, extractTextFromImage, UserError };
