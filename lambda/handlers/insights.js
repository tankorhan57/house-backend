const config = require('../lib/config');
const crypto = require('crypto');
const { callBedrock, parseJSONResponse } = require('../lib/bedrock-client');

// Injectable deps — overridden in unit tests (CJS modules can't be vi.mock'd
// reliably from ESM test files)
exports._deps = { callBedrock };
const { normalizeBiomarker, NORMALIZATION_MAP } = require('../lib/normalization');
const { writeAuditLog } = require('../lib/audit-log');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_READINGS = 3;
const MAX_POINTS_PER_BIOMARKER = 10;

function insightHash(biomarker, message) {
  return crypto.createHash('sha256').update(`${biomarker}|${message}`).digest('hex');
}

// Group a user's abnormal_values by canonical biomarker name.
// Returns { canonical: [{ date, value, unit, reference_range }] } for
// biomarkers appearing in MIN_READINGS+ documents.
function groupQualifyingBiomarkers(docs) {
  const series = {};

  for (const doc of docs || []) {
    const seen = new Set(); // count each biomarker once per document
    for (const bm of doc.abnormal_values || []) {
      const { canonical, recognized } = normalizeBiomarker(bm.canonical_name || bm.name);
      if (!recognized || seen.has(canonical)) continue;

      const value = parseFloat(bm.value);
      if (isNaN(value)) continue;

      seen.add(canonical);
      if (!series[canonical]) series[canonical] = [];
      series[canonical].push({
        date: doc.date_of_service || doc.created_at,
        value,
        unit: bm.unit || null,
        reference_range: bm.reference_range || null,
      });
    }
  }

  const qualifying = {};
  for (const [canonical, points] of Object.entries(series)) {
    if (points.length >= MIN_READINGS) {
      points.sort((a, b) => new Date(a.date) - new Date(b.date));
      qualifying[canonical] = points.slice(-MAX_POINTS_PER_BIOMARKER);
    }
  }
  return qualifying;
}

function buildInsightsPrompt(qualifying) {
  const seriesText = Object.entries(qualifying)
    .map(([biomarker, points]) => {
      const line = points
        .map((p) => `${p.date}: ${p.value}${p.unit ? ' ' + p.unit : ''}${p.reference_range ? ` (ref ${p.reference_range})` : ''}`)
        .join(' → ');
      return `${biomarker}: ${line}`;
    })
    .join('\n');

  return `You are a patient education tool analyzing biomarker time series from a single patient's lab history. For each biomarker with a meaningful pattern (sustained trend, large change, drift toward range boundary), produce one insight.

Rules — these are absolute:
- NEVER diagnose ("you have X" is prohibited)
- NEVER recommend treatment, supplements, or medication changes
- NEVER use: "you should", "you need to", "you must", "I recommend", "I advise"
- Describe the data pattern factually, note it is worth discussing with a doctor
- If a biomarker shows no meaningful pattern, omit it entirely

Respond ONLY with raw JSON (no markdown fences):
{"insights": [{"biomarker": "<canonical_name>", "message": "<2-3 sentence plain-language description>", "dataPoints": <number of readings>, "severity": "info|watch|urgent"}]}

Severity guide: info = stable or mild drift; watch = sustained trend toward range boundary; urgent = rapid change or clearly outside range across multiple readings.

Time series:
${seriesText}`;
}

async function generateInsights(qualifying) {
  const prompt = buildInsightsPrompt(qualifying);
  const text = await exports._deps.callBedrock([{ role: 'user', content: prompt }], 2048);
  const parsed = parseJSONResponse(text, 'insights');
  return Array.isArray(parsed.insights) ? parsed.insights : [];
}

// GET /insights
exports.handler = async (event, context, supabase, userId) => {
  try {
    // Fetch processed documents with abnormal values
    const { data: docs, error: docsError } = await supabase
      .from('documents')
      .select('id, date_of_service, abnormal_values, created_at')
      .eq('user_id', userId)
      .eq('status', 'done')
      .order('date_of_service', { ascending: true });

    if (docsError) throw docsError;

    const qualifying = groupQualifyingBiomarkers(docs);
    const qualifyingCount = Object.keys(qualifying).length;

    if (qualifyingCount === 0) {
      return response(200, { insights: [] });
    }

    // Cache check: fresh (<24h) and same qualifying doc count
    const docCount = (docs || []).length;
    const { data: cached } = await supabase
      .from('insights_cache')
      .select('insights, document_count, created_at')
      .eq('user_id', userId)
      .maybeSingle();

    let insights;
    if (
      cached &&
      cached.document_count === docCount &&
      Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS
    ) {
      insights = cached.insights;
    } else {
      try {
        insights = await generateInsights(qualifying);
      } catch (bedrockErr) {
        // Bedrock unavailable → empty insights, no user-facing error
        console.error('insights bedrock error:', bedrockErr);
        return response(200, { insights: [] });
      }

      await supabase.from('insights_cache').upsert({
        user_id: userId,
        insights,
        document_count: docCount,
        created_at: new Date().toISOString(),
      });

      console.log(JSON.stringify({ event: 'insights_generated', userId, count: insights.length }));
    }

    // Filter dismissed
    const { data: dismissed } = await supabase
      .from('dismissed_insights')
      .select('insight_hash')
      .eq('user_id', userId);

    const dismissedHashes = new Set((dismissed || []).map((d) => d.insight_hash));
    const visible = (insights || []).filter(
      (i) => !dismissedHashes.has(insightHash(i.biomarker, i.message))
    );

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'insights_viewed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { insights: visible });
  } catch (err) {
    console.error('insights error:', err);
    return response(500, { error: 'Failed to load insights' });
  }
};

// POST /insights/dismiss — body: { biomarker, message }
exports.dismiss = async (event, context, supabase, userId) => {
  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return response(400, { error: 'Invalid JSON body' });
    }

    const { biomarker, message } = body;
    if (!biomarker || !message) {
      return response(400, { error: 'biomarker and message are required' });
    }

    // Validate biomarker against the normalization map (fix-in-PR item)
    if (!Object.prototype.hasOwnProperty.call(NORMALIZATION_MAP, biomarker)) {
      return response(400, { error: 'Unrecognized biomarker' });
    }

    // Record when this insight was first served (cache creation time) so the
    // score's "follow-ups acted on" rule can tell reviewed from reflex dismissals
    const { data: cacheRow } = await supabase
      .from('insights_cache')
      .select('created_at')
      .eq('user_id', userId)
      .maybeSingle();

    const { error } = await supabase.from('dismissed_insights').upsert(
      {
        user_id: userId,
        insight_hash: insightHash(biomarker, message),
        biomarker,
        dismissed_at: new Date().toISOString(),
        served_at: cacheRow?.created_at || null,
      },
      { onConflict: 'user_id,insight_hash' }
    );

    if (error) throw error;

    return response(200, { dismissed: true });
  } catch (err) {
    console.error('insights dismiss error:', err);
    return response(500, { error: 'Failed to dismiss insight' });
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

// Exported for unit tests
exports._internal = { groupQualifyingBiomarkers, insightHash, buildInsightsPrompt };
