import { describe, it, expect } from 'vitest';
import { parseJSONResponse } from '../../lambda/lib/bedrock-client.js';

describe('parseJSONResponse', () => {
  it('parses plain JSON', () => {
    expect(parseJSONResponse('{"a": 1}', 'test')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in markdown fences', () => {
    expect(parseJSONResponse('```json\n{"a": 1}\n```', 'test')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in bare fences', () => {
    expect(parseJSONResponse('```\n{"a": 1}\n```', 'test')).toEqual({ a: 1 });
  });

  it('parses JSON with surrounding commentary', () => {
    expect(parseJSONResponse('Here is the result:\n{"a": 1}\nDone.', 'test')).toEqual({ a: 1 });
  });

  it('parses nested objects', () => {
    const text = '{"extraction": {"document_type": "blood_panel"}, "interpretation": "text"}';
    const result = parseJSONResponse(text, 'test');
    expect(result.extraction.document_type).toBe('blood_panel');
  });

  it('throws with label when no JSON present', () => {
    expect(() => parseJSONResponse('no json here', 'mylabel')).toThrow(/mylabel/);
  });
});
