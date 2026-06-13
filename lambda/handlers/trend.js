const config = require('../lib/config');
const { writeAuditLog } = require('../lib/audit-log');

// GET /trend?biomarker=Hemoglobin
// Returns time-series data for a specific biomarker across all user documents
exports.handler = async (event, context, supabase, userId) => {
  try {
    const biomarker = event.queryStringParameters?.biomarker;
    if (!biomarker) {
      return response(400, { error: 'biomarker query parameter is required' });
    }

    // Fetch all user documents that have abnormal_values, ordered by date
    const { data: docs, error } = await supabase
      .from('documents')
      .select('id, date_of_service, abnormal_values, created_at')
      .eq('user_id', userId)
      .not('abnormal_values', 'is', null)
      .order('date_of_service', { ascending: true });

    if (error) throw error;

    // Find the requested biomarker across all documents (match by name or canonical_name)
    const points = [];
    let unit;

    for (const doc of docs || []) {
      const bm = (doc.abnormal_values || []).find(
        (b) =>
          b.name?.toLowerCase() === biomarker.toLowerCase() ||
          b.canonical_name?.toLowerCase() === biomarker.toLowerCase()
      );
      if (!bm || bm.value == null) continue;

      const numericValue = parseFloat(bm.value);
      if (isNaN(numericValue)) continue;

      if (!unit && bm.unit) unit = bm.unit;

      points.push({
        date: doc.date_of_service || doc.created_at,
        value: numericValue,
        unit: bm.unit,
        reference_range: bm.reference_range,
      });
    }

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'trend_viewed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { biomarker, unit, points });
  } catch (err) {
    console.error('trend error:', err);
    return response(500, { error: 'Failed to generate trend data' });
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
