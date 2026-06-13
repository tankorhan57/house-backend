import { describe, it, expect, vi, beforeEach } from 'vitest';
import insights from '../../lambda/handlers/insights.js';

// Inject a fake Bedrock call — never hit real AWS in unit tests
const callBedrockMock = vi.fn();
insights._deps.callBedrock = callBedrockMock;

// 3 docs with the same biomarker so it qualifies (3+ readings)
const QUALIFYING_DOCS = [
  { id: 'd1', date_of_service: '2025-01-01', created_at: '2025-01-01', abnormal_values: [{ name: 'Ferritin', value: '80', unit: 'ng/mL' }] },
  { id: 'd2', date_of_service: '2025-06-01', created_at: '2025-06-01', abnormal_values: [{ name: 'Ferritin', value: '60', unit: 'ng/mL' }] },
  { id: 'd3', date_of_service: '2025-12-01', created_at: '2025-12-01', abnormal_values: [{ name: 'Ferritin', value: '48', unit: 'ng/mL' }] },
];

function makeSupabase({ docs = [], cache = null, dismissed = [] } = {}) {
  const upserts = [];
  const supabase = {
    upserts,
    from(table) {
      if (table === 'documents') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: docs, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'insights_cache') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: cache }),
            }),
          }),
          upsert: async (row) => {
            upserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === 'dismissed_insights') {
        return {
          select: () => ({
            eq: async () => ({ data: dismissed }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return supabase;
}

const event = { requestContext: {} };

beforeEach(() => {
  callBedrockMock.mockReset();
});

describe('GET /insights', () => {
  it('returns empty insights when no biomarker qualifies', async () => {
    const res = await insights.handler(event, {}, makeSupabase({ docs: [] }), 'u1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).insights).toEqual([]);
    expect(callBedrockMock).not.toHaveBeenCalled();
  });

  it('calls Bedrock and caches on cache miss', async () => {
    callBedrockMock.mockResolvedValue(
      '{"insights": [{"biomarker": "ferritin", "message": "Declining over 12 months.", "dataPoints": 3, "severity": "watch"}]}'
    );
    const supabase = makeSupabase({ docs: QUALIFYING_DOCS });
    const res = await insights.handler(event, {}, supabase, 'u1');
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.insights).toHaveLength(1);
    expect(callBedrockMock).toHaveBeenCalledOnce();
    expect(supabase.upserts).toHaveLength(1);
    expect(supabase.upserts[0].document_count).toBe(3);
  });

  it('serves from fresh cache without calling Bedrock', async () => {
    const cache = {
      insights: [{ biomarker: 'ferritin', message: 'cached', dataPoints: 3, severity: 'info' }],
      document_count: 3,
      created_at: new Date().toISOString(),
    };
    const res = await insights.handler(event, {}, makeSupabase({ docs: QUALIFYING_DOCS, cache }), 'u1');
    expect(JSON.parse(res.body).insights[0].message).toBe('cached');
    expect(callBedrockMock).not.toHaveBeenCalled();
  });

  it('recomputes when cache is stale (>24h)', async () => {
    callBedrockMock.mockResolvedValue('{"insights": []}');
    const cache = {
      insights: [{ biomarker: 'ferritin', message: 'old', dataPoints: 3, severity: 'info' }],
      document_count: 3,
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    await insights.handler(event, {}, makeSupabase({ docs: QUALIFYING_DOCS, cache }), 'u1');
    expect(callBedrockMock).toHaveBeenCalledOnce();
  });

  it('recomputes when document count changed', async () => {
    callBedrockMock.mockResolvedValue('{"insights": []}');
    const cache = {
      insights: [],
      document_count: 2, // user has 3 docs now
      created_at: new Date().toISOString(),
    };
    await insights.handler(event, {}, makeSupabase({ docs: QUALIFYING_DOCS, cache }), 'u1');
    expect(callBedrockMock).toHaveBeenCalledOnce();
  });

  it('returns empty insights when Bedrock fails (fail-safe)', async () => {
    callBedrockMock.mockRejectedValue(new Error('bedrock down'));
    const res = await insights.handler(event, {}, makeSupabase({ docs: QUALIFYING_DOCS }), 'u1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).insights).toEqual([]);
  });

  it('filters dismissed insights', async () => {
    const insight = { biomarker: 'ferritin', message: 'Declining.', dataPoints: 3, severity: 'watch' };
    const cache = { insights: [insight], document_count: 3, created_at: new Date().toISOString() };
    const hash = insights._internal.insightHash(insight.biomarker, insight.message);

    const res = await insights.handler(
      event, {}, makeSupabase({ docs: QUALIFYING_DOCS, cache, dismissed: [{ insight_hash: hash }] }), 'u1'
    );
    expect(JSON.parse(res.body).insights).toEqual([]);
  });
});
