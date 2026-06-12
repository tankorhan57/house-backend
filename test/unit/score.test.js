import { describe, it, expect } from 'vitest';
import score from '../../lambda/lib/score.js';

const { computeLayer1, computeLayer2, finalScore } = score;

function doc(daysAgo, abnormalValues = []) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { date_of_service: d, created_at: d, abnormal_values: abnormalValues };
}

const FULL_PROFILE = {
  age: 38, sex: 'male',
  chronic_conditions: ['hypothyroidism'],
  current_medications: ['levothyroxine'],
  allergies: ['penicillin'],
  lifestyle_notes: 'runs 3x/week',
};

describe('computeLayer1', () => {
  it('returns 0 for empty everything', () => {
    const { score: s, breakdown } = computeLayer1([], null, 0);
    expect(s).toBe(0);
    expect(breakdown.documents.points).toBe(0);
  });

  it('caps document points at 30 (10+ docs)', () => {
    const docs = Array.from({ length: 15 }, () => doc(10));
    expect(computeLayer1(docs, null).breakdown.documents.points).toBe(30);
  });

  it('counts only recognized canonical biomarkers for diversity', () => {
    const docs = [doc(10, [
      { canonical_name: 'crp', recognized: true },
      { canonical_name: 'tsh', recognized: true },
      { canonical_name: 'Mystery', recognized: false },
    ])];
    expect(computeLayer1(docs, null).breakdown.biomarkers.points).toBe(4); // 2 × 2pts
  });

  it('scores profile completeness proportionally', () => {
    expect(computeLayer1([], FULL_PROFILE).breakdown.profile.points).toBe(20);
    expect(computeLayer1([], { age: 38, sex: 'male' }).breakdown.profile.points).toBe(7); // 2/6 → 6.67 → 7
    expect(computeLayer1([], { chronic_conditions: [] }).breakdown.profile.points).toBe(0); // empty array ≠ filled
  });

  it('recency: 20 within 6mo, 10 within 12mo, 0 older', () => {
    expect(computeLayer1([doc(30)], null).breakdown.recency.points).toBe(20);
    expect(computeLayer1([doc(300)], null).breakdown.recency.points).toBe(10);
    expect(computeLayer1([doc(400)], null).breakdown.recency.points).toBe(0);
  });

  it('caps follow-up points at 10', () => {
    expect(computeLayer1([], null, 3).breakdown.followUps.points).toBe(6);
    expect(computeLayer1([], null, 99).breakdown.followUps.points).toBe(10);
  });

  it('total never exceeds 100', () => {
    const docs = Array.from({ length: 12 }, (_, i) =>
      doc(5, [{ canonical_name: `bm${i}`, recognized: true }])
    );
    const { score: s } = computeLayer1(docs, FULL_PROFILE, 10);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('computeLayer2', () => {
  const pts = (values, extra = {}) =>
    values.map((v, i) => ({ date: `2025-0${i + 1}-01`, value: v, recognized: true, ...extra }));

  it('returns zero modifier with no qualifying series', () => {
    expect(computeLayer2({})).toEqual({ modifier: 0, confidence: false });
    expect(computeLayer2({ crp: pts([1, 2]) })).toEqual({ modifier: 0, confidence: false }); // <3 readings
  });

  it('computes positive modifier for rising series', () => {
    const { modifier } = computeLayer2({ glucose: pts([100, 120, 150]) });
    expect(modifier).toBeGreaterThan(0);
    expect(modifier).toBeLessThanOrEqual(20);
  });

  it('clamps modifier to [-20, 20]', () => {
    const { modifier } = computeLayer2({ crp: pts([1, 10, 50]) }); // +4900% → clamp
    expect(modifier).toBe(20);
    const { modifier: down } = computeLayer2({ ferritin: pts([100, 20, 1]) });
    expect(down).toBe(-20);
  });

  it('weights urgent biomarkers 2x', () => {
    const normal = computeLayer2({
      a: pts([100, 100, 100]),       // flat, weight 1
      b: pts([100, 150, 200]),       // +100% → 1.0, weight 1
    });
    const urgent = computeLayer2({
      a: pts([100, 100, 100]),
      b: pts([100, 150, 200], { urgency: 'urgent' }), // weight 2
    });
    expect(urgent.modifier).toBeGreaterThan(normal.modifier);
  });

  it('confidence requires 4+ recognized readings', () => {
    expect(computeLayer2({ crp: pts([1, 2, 3]) }).confidence).toBe(false);
    expect(computeLayer2({ crp: pts([1, 2, 3, 4]) }).confidence).toBe(true);
  });

  it('confidence false when any contributing series unrecognized', () => {
    const series = {
      crp: pts([1, 2, 3, 4]),
      mystery: pts([1, 2, 3, 4]).map((p) => ({ ...p, recognized: false })),
    };
    expect(computeLayer2(series).confidence).toBe(false);
  });
});

describe('finalScore', () => {
  it('clamps to [0, 100]', () => {
    expect(finalScore(95, 20)).toBe(100);
    expect(finalScore(10, -20)).toBe(0);
    expect(finalScore(50, 10)).toBe(60);
  });
});
