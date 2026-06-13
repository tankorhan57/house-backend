const config = require('../lib/config');
const { computeLayer1 } = require('../lib/score');
const { writeAuditLog } = require('../lib/audit-log');

// GET /score — Layer 1 Health Profile score with cache + staleness guard (T10)
// Cache flow:
//   1. Read health_score_cache row
//   2. Staleness guard: if latest done-document created_at > computed_at,
//      cache is stale (covers silent DB-trigger failure)
//   3. On miss/stale: recompute from docs + profile + reviewed dismissals, upsert
exports.handler = async (event, context, supabase, userId) => {
  try {
    const [cacheRes, docsRes] = await Promise.all([
      supabase
        .from('health_score_cache')
        .select('score, breakdown, computed_at')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('documents')
        .select('date_of_service, created_at, abnormal_values')
        .eq('user_id', userId)
        .eq('status', 'done')
        .order('created_at', { ascending: false }),
    ]);

    if (docsRes.error) throw docsRes.error;
    const docs = docsRes.data || [];
    const cached = cacheRes.data;

    const latestDocAt = docs.length ? new Date(docs[0].created_at).getTime() : 0;
    const cacheFresh =
      cached && new Date(cached.computed_at).getTime() >= latestDocAt;

    let score, breakdown, computedAt;

    if (cacheFresh) {
      ({ score, breakdown } = cached);
      computedAt = cached.computed_at;
    } else {
      // Recompute: profile + reviewed dismissals (dismissed >=1h after served)
      const [profileRes, dismissedRes] = await Promise.all([
        supabase
          .from('user_profiles')
          .select('age, sex, chronic_conditions, current_medications, allergies, lifestyle_notes')
          .eq('user_id', userId)
          .maybeSingle(),
        supabase
          .from('dismissed_insights')
          .select('dismissed_at, served_at')
          .eq('user_id', userId),
      ]);

      const ONE_HOUR = 60 * 60 * 1000;
      const reviewedDismissals = (dismissedRes.data || []).filter(
        (d) =>
          d.served_at &&
          new Date(d.dismissed_at).getTime() - new Date(d.served_at).getTime() >= ONE_HOUR
      ).length;

      ({ score, breakdown } = computeLayer1(docs, profileRes.data, reviewedDismissals));
      computedAt = new Date().toISOString();

      await supabase.from('health_score_cache').upsert({
        user_id: userId,
        score,
        breakdown,
        computed_at: computedAt,
      });

      console.log(JSON.stringify({ event: 'score_computed', userId, score }));
    }

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'score_viewed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, {
      score,
      breakdown,
      lastUpdated: computedAt,
      // Layer 2 ships in Phase 2 — UI hides the trajectory arrow until then
      trajectoryConfident: false,
    });
  } catch (err) {
    console.error('score error:', err);
    return response(500, { error: 'Failed to load score' });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': config.allowedOrigin,
    },
    body: JSON.stringify(body),
  };
}
