const config = require('./lib/config');
const { createUserClient } = require('./lib/supabase-client');
const presign = require('./handlers/presign');
const process_ = require('./handlers/process');
const documents = require('./handlers/documents');
const deleteHandler = require('./handlers/delete');
const trend = require('./handlers/trend');
const insights = require('./handlers/insights');
const score = require('./handlers/score');
const profile = require('./handlers/profile');

exports.handler = async (event, context) => {
  const method = event.httpMethod;
  const path = event.path;

  // CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': config.allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
      body: '',
    };
  }

  // Verify JWT and extract userId
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return response(401, { error: 'Authorization header required' });
  }

  const token = authHeader.slice(7);
  let userId;
  let supabase;

  try {
    supabase = createUserClient(token);
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return response(401, { error: 'Invalid or expired token' });
    userId = user.id;
  } catch (err) {
    console.error('Auth error:', err);
    return response(401, { error: 'Authentication failed' });
  }

  // Route
  if (method === 'POST' && path === '/presign') {
    return presign.handler(event, context, supabase, userId);
  }
  if (method === 'POST' && path === '/process') {
    return process_.handler(event, context, supabase, userId);
  }
  if (method === 'GET' && path === '/documents') {
    return documents.handler(event, context, supabase, userId);
  }
  if (method === 'GET' && path.startsWith('/documents/')) {
    return documents.getOne(event, context, supabase, userId);
  }
  if (method === 'GET' && path === '/trend') {
    return trend.handler(event, context, supabase, userId);
  }
  if (method === 'GET' && path === '/insights') {
    return insights.handler(event, context, supabase, userId);
  }
  if (method === 'POST' && path === '/insights/dismiss') {
    return insights.dismiss(event, context, supabase, userId);
  }
  if (method === 'GET' && path === '/score') {
    return score.handler(event, context, supabase, userId);
  }
  if (method === 'GET' && path === '/profile') {
    return profile.handler(event, context, supabase, userId);
  }
  if (method === 'PUT' && path === '/profile') {
    return profile.update(event, context, supabase, userId);
  }
  if (method === 'DELETE' && path.startsWith('/documents/')) {
    return deleteHandler.handler(event, context, supabase, userId);
  }
  if (method === 'DELETE' && path === '/account') {
    return deleteHandler.deleteAccount(event, context, supabase, userId);
  }

  return response(404, { error: 'Route not found' });
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
