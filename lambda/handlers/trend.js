const { writeAuditLog } = require('../lib/audit-log');

// GET /trend?documentType=blood_panel
// Returns trend table for a given document type
exports.handler = async (event, context, supabase, userId) => {
  try {
    const documentType = event.queryStringParameters?.documentType;
    if (!documentType) {
      return response(400, { error: 'documentType query parameter is required' });
    }

    // Fetch all documents of this type for the user, ordered by date
    const { data: docs, error } = await supabase
      .from('documents')
      .select('id, date_of_service, abnormal_values, key_findings, created_at')
      .eq('user_id', userId)
      .eq('document_type', documentType)
      .order('date_of_service', { ascending: true });

    if (error) throw error;
    if (!docs || docs.length < 2) {
      return response(200, { trend: null, message: 'Upload at least 2 documents of the same type to see trends.' });
    }

    // Build trend table
    const trend = buildTrendTable(docs);

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'trend_viewed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { trend, documentCount: docs.length });
  } catch (err) {
    console.error('trend error:', err);
    return response(500, { error: 'Failed to generate trend data' });
  }
};

function buildTrendTable(docs) {
  // Collect all unique canonical biomarker names across all documents
  const allBiomarkers = new Set();
  for (const doc of docs) {
    for (const bm of doc.abnormal_values || []) {
      if (bm.canonical_name) allBiomarkers.add(bm.canonical_name);
    }
  }

  // Build table: biomarker -> array of values per document
  const rows = [];
  for (const biomarkerName of allBiomarkers) {
    const row = {
      biomarker: biomarkerName,
      recognized: true,
      values: [],
    };

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const bm = (doc.abnormal_values || []).find((b) => b.canonical_name === biomarkerName);

      if (!bm) {
        row.values.push({ date: doc.date_of_service, value: null, unit: null, arrow: null });
        continue;
      }

      // Determine trend arrow
      let arrow = null;
      if (i > 0) {
        const prevDoc = docs[i - 1];
        const prevBm = (prevDoc.abnormal_values || []).find((b) => b.canonical_name === biomarkerName);
        if (prevBm && prevBm.value != null && bm.value != null) {
          const prev = parseFloat(prevBm.value);
          const curr = parseFloat(bm.value);
          const pctChange = Math.abs((curr - prev) / prev);

          if (pctChange >= 0.05) {
            const direction = curr > prev ? 'up' : 'down';
            const outsideRange = bm.direction === 'high' || bm.direction === 'low';
            arrow = { direction, severity: outsideRange ? 'red' : 'gray' };
          }
        }
      }

      row.values.push({
        date: doc.date_of_service,
        value: bm.value,
        unit: bm.unit,
        reference_range: bm.reference_range,
        direction: bm.direction,
        arrow,
        recognized: bm.recognized !== false,
        document_id: doc.id,
      });
    }

    rows.push(row);
  }

  return {
    dates: docs.map((d) => d.date_of_service),
    document_ids: docs.map((d) => d.id),
    rows,
  };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
