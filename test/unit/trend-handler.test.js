import { describe, it, expect } from 'vitest';
import trend from '../../lambda/handlers/trend.js';

function makeSupabase(docs) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => ({
            order: async () => ({ data: docs, error: null }),
          }),
        }),
      }),
    }),
  };
}

const event = (params) => ({ queryStringParameters: params, requestContext: {} });

describe('GET /trend', () => {
  it('returns 400 without biomarker param', async () => {
    const res = await trend.handler(event(null), {}, makeSupabase([]), 'u1');
    expect(res.statusCode).toBe(400);
  });

  it('returns time series matched by name or canonical_name', async () => {
    const docs = [
      {
        date_of_service: '2025-01-01',
        abnormal_values: [{ name: 'HGB', canonical_name: 'hemoglobin', value: '14.2', unit: 'g/dL' }],
      },
      {
        date_of_service: '2025-08-01',
        abnormal_values: [{ name: 'Hemoglobin', value: '13.1', unit: 'g/dL' }],
      },
    ];
    const res = await trend.handler(event({ biomarker: 'hemoglobin' }), {}, makeSupabase(docs), 'u1');
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.points).toHaveLength(2);
    expect(body.points[0].value).toBe(14.2);
    expect(body.unit).toBe('g/dL');
  });

  it('skips non-numeric values', async () => {
    const docs = [
      { date_of_service: '2025-01-01', abnormal_values: [{ name: 'TSH', value: 'high' }] },
    ];
    const res = await trend.handler(event({ biomarker: 'TSH' }), {}, makeSupabase(docs), 'u1');
    expect(JSON.parse(res.body).points).toHaveLength(0);
  });
});
