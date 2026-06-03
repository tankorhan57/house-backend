const { writeAuditLog } = require('../lib/audit-log');

// GET /documents
// Returns all documents for the authenticated user
exports.handler = async (event, context, supabase, userId) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, file_name, document_type, date_of_service, provider_name, body_part, key_findings, abnormal_values, urgency, follow_up_recommended, created_at')
      .eq('user_id', userId)
      .order('date_of_service', { ascending: false });

    if (error) throw error;

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'documents_listed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    return response(200, { documents: data });
  } catch (err) {
    console.error('documents list error:', err);
    return response(500, { error: 'Failed to fetch documents' });
  }
};

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
