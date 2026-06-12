import { describe, it, expect, vi, beforeEach } from 'vitest';
import process_ from '../../lambda/handlers/process.js';

// PNG magic bytes so detectMimeFromBuffer routes to the image path
const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeS3() {
  return {
    send: vi.fn().mockResolvedValue({
      Body: (async function* () { yield PNG_BUFFER; })(),
    }),
  };
}

const EXTRACTION = {
  document_type: 'blood_panel',
  date_of_service: '2026-01-01',
  provider_name: 'Test Lab',
  body_part: 'blood',
  key_findings: ['finding'],
  abnormal_values: [{ name: 'CRP', value: '2.4', unit: 'mg/L' }],
  follow_up_recommended: false,
  urgency: 'routine',
};

// Supabase mock that records status writes in order
function makeSupabase({ stubInsertError = null, updateError = null } = {}) {
  const statusWrites = [];
  return {
    statusWrites,
    from(table) {
      if (table === 'documents') {
        return {
          insert: async (row) => {
            statusWrites.push(`insert:${row.status}`);
            return { error: stubInsertError };
          },
          update: (row) => ({
            eq: () => ({
              eq: async () => {
                statusWrites.push(`update:${row.status}`);
                return { error: updateError };
              },
            }),
          }),
        };
      }
      if (table === 'audit_log') {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const event = (body) => ({ body: JSON.stringify(body), requestContext: {} });
const GOOD_BODY = { documentId: 'd1', key: 'documents/u1/d1/file.png', fileName: 'file.png' };

beforeEach(() => {
  process_._deps.s3 = makeS3();
  process_._deps.extractTextFromImage = vi.fn().mockResolvedValue({ type: 'image', source: {} });
  process_._deps.extractAndInterpretFromImage = vi.fn().mockResolvedValue({
    extraction: { ...EXTRACTION, abnormal_values: [...EXTRACTION.abnormal_values] },
    interpretation: 'plain language text',
  });
});

describe('process.js status transitions (N1)', () => {
  it('inserts processing stub, then updates to done on success', async () => {
    const supabase = makeSupabase();
    const res = await process_.handler(event(GOOD_BODY), {}, supabase, 'u1');

    expect(res.statusCode).toBe(200);
    expect(supabase.statusWrites).toEqual(['insert:processing', 'update:done']);
  });

  it('sets status=error when Bedrock extraction fails', async () => {
    process_._deps.extractAndInterpretFromImage = vi.fn().mockRejectedValue(new Error('bedrock down'));
    const supabase = makeSupabase();
    const res = await process_.handler(event(GOOD_BODY), {}, supabase, 'u1');

    expect(res.statusCode).toBe(500);
    expect(supabase.statusWrites).toEqual(['insert:processing', 'update:error']);
  });

  it('sets status=error when the final update fails', async () => {
    // First update (done) fails → catch sets error → that update also records
    const supabase = makeSupabase({ updateError: { message: 'db down' } });
    const res = await process_.handler(event(GOOD_BODY), {}, supabase, 'u1');

    expect(res.statusCode).toBe(500);
    expect(supabase.statusWrites[0]).toBe('insert:processing');
    expect(supabase.statusWrites[1]).toBe('update:done'); // attempted
    expect(supabase.statusWrites[2]).toBe('update:error');
  });

  it('rejects IDOR key without creating any row', async () => {
    const supabase = makeSupabase();
    const res = await process_.handler(
      event({ documentId: 'd1', key: 'documents/OTHER-user/d1/f.png' }), {}, supabase, 'u1'
    );
    expect(res.statusCode).toBe(403);
    expect(supabase.statusWrites).toEqual([]);
  });

  it('normalizes biomarker names into canonical_name on the done update', async () => {
    let updatedRow;
    const supabase = makeSupabase();
    const origFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const chain = origFrom(table);
      if (table === 'documents' && chain.update) {
        const origUpdate = chain.update.bind(chain);
        chain.update = (row) => {
          if (row.status === 'done') updatedRow = row;
          return origUpdate(row);
        };
      }
      return chain;
    };

    await process_.handler(event(GOOD_BODY), {}, supabase, 'u1');
    expect(updatedRow.abnormal_values[0].canonical_name).toBe('crp');
    expect(updatedRow.abnormal_values[0].recognized).toBe(true);
  });
});
