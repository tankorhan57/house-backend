import { describe, it, expect } from 'vitest';
import insights from '../../lambda/handlers/insights.js';

const { groupQualifyingBiomarkers, insightHash } = insights._internal;

function doc(date, values) {
  return {
    date_of_service: date,
    created_at: date,
    abnormal_values: values,
  };
}

describe('groupQualifyingBiomarkers', () => {
  it('includes biomarkers with 3+ readings', () => {
    const docs = [
      doc('2025-01-01', [{ name: 'Ferritin', value: '80', unit: 'ng/mL' }]),
      doc('2025-06-01', [{ name: 'Ferritin', value: '60', unit: 'ng/mL' }]),
      doc('2025-12-01', [{ name: 'Ferritin', value: '48', unit: 'ng/mL' }]),
    ];
    const result = groupQualifyingBiomarkers(docs);
    expect(result.ferritin).toHaveLength(3);
    expect(result.ferritin.map((p) => p.value)).toEqual([80, 60, 48]);
  });

  it('excludes biomarkers with fewer than 3 readings', () => {
    const docs = [
      doc('2025-01-01', [{ name: 'TSH', value: '2.1' }]),
      doc('2025-06-01', [{ name: 'TSH', value: '2.4' }]),
    ];
    expect(groupQualifyingBiomarkers(docs)).toEqual({});
  });

  it('counts each biomarker once per document', () => {
    const docs = [
      doc('2025-01-01', [
        { name: 'CRP', value: '2.0' },
        { name: 'hsCRP', value: '2.1' }, // same canonical, same doc
      ]),
      doc('2025-06-01', [{ name: 'CRP', value: '2.5' }]),
      doc('2025-12-01', [{ name: 'CRP', value: '3.0' }]),
    ];
    const result = groupQualifyingBiomarkers(docs);
    expect(result.crp).toHaveLength(3);
  });

  it('excludes unrecognized biomarkers', () => {
    const docs = [
      doc('2025-01-01', [{ name: 'Mystery Marker', value: '1' }]),
      doc('2025-06-01', [{ name: 'Mystery Marker', value: '2' }]),
      doc('2025-12-01', [{ name: 'Mystery Marker', value: '3' }]),
    ];
    expect(groupQualifyingBiomarkers(docs)).toEqual({});
  });

  it('excludes non-numeric values', () => {
    const docs = [
      doc('2025-01-01', [{ name: 'Ferritin', value: 'positive' }]),
      doc('2025-06-01', [{ name: 'Ferritin', value: '60' }]),
      doc('2025-12-01', [{ name: 'Ferritin', value: '48' }]),
    ];
    expect(groupQualifyingBiomarkers(docs)).toEqual({});
  });

  it('sorts points chronologically and caps at 10 most recent', () => {
    const docs = [];
    for (let i = 1; i <= 12; i++) {
      docs.push(doc(`2025-${String(i).padStart(2, '0')}-01`, [{ name: 'Glucose', value: String(90 + i) }]));
    }
    const result = groupQualifyingBiomarkers(docs);
    expect(result.glucose).toHaveLength(10);
    // Oldest two dropped
    expect(result.glucose[0].value).toBe(93);
    expect(result.glucose[9].value).toBe(102);
  });

  it('handles empty and missing abnormal_values', () => {
    expect(groupQualifyingBiomarkers([])).toEqual({});
    expect(groupQualifyingBiomarkers([{ abnormal_values: null }])).toEqual({});
    expect(groupQualifyingBiomarkers(null)).toEqual({});
  });
});

describe('insightHash', () => {
  it('is deterministic', () => {
    expect(insightHash('ferritin', 'msg')).toBe(insightHash('ferritin', 'msg'));
  });

  it('differs across biomarker/message combinations', () => {
    expect(insightHash('ferritin', 'msg')).not.toBe(insightHash('tsh', 'msg'));
    expect(insightHash('ferritin', 'msg-a')).not.toBe(insightHash('ferritin', 'msg-b'));
  });

  it('is a 64-char hex sha256', () => {
    expect(insightHash('a', 'b')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /insights/dismiss validation', () => {
  function makeSupabase() {
    return {
      from: () => ({
        upsert: async () => ({ error: null }),
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { created_at: new Date().toISOString() } }) }),
        }),
      }),
    };
  }
  const event = (body) => ({ body: JSON.stringify(body), requestContext: {} });

  it('returns 400 for unrecognized biomarker', async () => {
    const res = await insights.dismiss(event({ biomarker: 'not_a_biomarker', message: 'x' }), {}, makeSupabase(), 'u1');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unrecognized/);
  });

  it('returns 400 when biomarker or message missing', async () => {
    const res1 = await insights.dismiss(event({ message: 'x' }), {}, makeSupabase(), 'u1');
    const res2 = await insights.dismiss(event({ biomarker: 'crp' }), {}, makeSupabase(), 'u1');
    expect(res1.statusCode).toBe(400);
    expect(res2.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await insights.dismiss({ body: '{not json' }, {}, makeSupabase(), 'u1');
    expect(res.statusCode).toBe(400);
  });

  it('accepts a recognized canonical biomarker', async () => {
    const res = await insights.dismiss(event({ biomarker: 'crp', message: 'trend msg' }), {}, makeSupabase(), 'u1');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).dismissed).toBe(true);
  });
});
