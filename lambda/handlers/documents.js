const config = require('../lib/config');
const { writeAuditLog } = require('../lib/audit-log');

// GET /documents/:id
exports.getOne = async (event, context, supabase, userId) => {
  const id = event.pathParameters?.id || event.path.split('/documents/')[1]?.split('?')[0];
  if (!id) return response(400, { error: 'Document ID required' });

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) return response(404, { error: 'Document not found' });

    return response(200, { ...data, documentId: data.id });
  } catch (err) {
    console.error('document get error:', err);
    return response(500, { error: 'Failed to fetch document' });
  }
};

// GET /documents
// Returns all documents for the authenticated user
exports.handler = async (event, context, supabase, userId) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, file_name, document_type, date_of_service, provider_name, body_part, key_findings, abnormal_values, urgency, follow_up_recommended, status, created_at')
      .eq('user_id', userId)
      .order('date_of_service', { ascending: false });

    if (error) throw error;

    await writeAuditLog(supabase, {
      userId,
      documentId: null,
      action: 'documents_listed',
      ipAddress: event.requestContext?.identity?.sourceIp,
    });

    // Frontend expects an array and uses documentId (not id)
    const mapped = (data || []).map(doc => ({ ...doc, documentId: doc.id }));
    return response(200, mapped);
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
      'Access-Control-Allow-Origin': config.allowedOrigin,
    },
    body: JSON.stringify(body),
  };
}
