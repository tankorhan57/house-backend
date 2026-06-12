import { describe, it, expect } from 'vitest';
import scoreHandler from '../../lambda/handlers/score.js';

function makeSupabase({ cache = null, docs = [], profile = null, dismissed = [] } = {}) {
  const upserts = [];
  return {
    upserts,
    from(table) {
      if (table === 'health_score_cache') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cache }) }) }),
          upsert: async (row) => { upserts.push(row); return { error: null }; },
        };
      }
      if (table === 'documents') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ order: async () => ({ data: docs, error: null }) }) }),
          }),
        };
      }
      if (table === 'user_profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) };
      }
      if (table === 'dismissed_insights') {
        return { select: () => ({ eq: async () => ({ data: dismissed }) }) };
      }
      if (table === 'audit_log') {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const event = { requestContext: {} };
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

describe('GET /score', () => {
  it('serves fresh cache without recompute', async () => {
    const cache = { score: 42, breakdown: { documents: { points: 12, max: 30 } }, computed_at: iso(0) };
    const docs = [{ created_at: iso(60 * 60 * 1000), date_of_service: null, abnormal_values: [] }];
    const supabase = makeSupabase({ cache, docs });

    const res = await scoreHandler.handler(event, {}, supabase, 'u1');
    const body = JSON.parse(res.body);
    expect(body.score).toBe(42);
    expect(supabase.upserts).toHaveLength(0); // no recompute
  });

  it('recomputes when cache is stale (doc newer than computed_at)', async () => {
    const cache = { score: 42, breakdown: {}, computed_at: iso(2 * 60 * 60 * 1000) };
    const docs = [{ created_at: iso(60 * 60 * 1000), date_of_service: iso(60 * 60 * 1000), abnormal_values: [] }];
    const supabase = makeSupabase({ cache, docs });

    const res = await scoreHandler.handler(event, {}, supabase, 'u1');
    expect(res.statusCode).toBe(200);
    expect(supabase.upserts).toHaveLength(1); // recomputed + cached
  });

  it('recomputes on cache miss and returns breakdown', async () => {
    const docs = [{ created_at: iso(1000), date_of_service: iso(1000), abnormal_values: [{ canonical_name: 'crp', recognized: true }] }];
    const supabase = makeSupabase({ docs });

    const res = await scoreHandler.handler(event, {}, supabase, 'u1');
    const body = JSON.parse(res.body);
    expect(body.score).toBeGreaterThan(0);
    expect(body.breakdown.documents.points).toBe(3);
    expect(body.trajectoryConfident).toBe(false);
    expect(supabase.upserts).toHaveLength(1);
  });

  it('counts only reviewed dismissals (>=1h after served)', async () => {
    const dismissed = [
      { served_at: iso(3 * 60 * 60 * 1000), dismissed_at: iso(60 * 60 * 1000) },  // 2h after → reviewed
      { served_at: iso(60 * 60 * 1000), dismissed_at: iso(59 * 60 * 1000) },      // 1min after → reflex
      { served_at: null, dismissed_at: iso(0) },                                   // no served_at → excluded
    ];
    const supabase = makeSupabase({ docs: [], dismissed });

    const res = await scoreHandler.handler(event, {}, supabase, 'u1');
    const body = JSON.parse(res.body);
    expect(body.breakdown.followUps.points).toBe(2); // 1 reviewed × 2pts
  });

  it('returns 0 score with empty state for new user', async () => {
    const res = await scoreHandler.handler(event, {}, makeSupabase(), 'u1');
    const body = JSON.parse(res.body);
    expect(body.score).toBe(0);
  });
});
