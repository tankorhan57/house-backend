import { describe, it, expect } from 'vitest';
import { normalizeBiomarker } from '../../lambda/lib/normalization.js';

describe('normalizeBiomarker', () => {
  it('recognizes CRP aliases', () => {
    expect(normalizeBiomarker('CRP')).toEqual({ canonical: 'crp', recognized: true });
    expect(normalizeBiomarker('C-Reactive Protein')).toEqual({ canonical: 'crp', recognized: true });
    expect(normalizeBiomarker('hsCRP')).toEqual({ canonical: 'crp', recognized: true });
  });

  it('recognizes LDL aliases', () => {
    expect(normalizeBiomarker('LDL')).toEqual({ canonical: 'ldl_cholesterol', recognized: true });
    expect(normalizeBiomarker('LDL-C')).toEqual({ canonical: 'ldl_cholesterol', recognized: true });
    expect(normalizeBiomarker('LDL Cholesterol')).toEqual({ canonical: 'ldl_cholesterol', recognized: true });
  });

  it('recognizes HbA1c aliases', () => {
    expect(normalizeBiomarker('A1C')).toEqual({ canonical: 'hemoglobin_a1c', recognized: true });
    expect(normalizeBiomarker('HbA1c')).toEqual({ canonical: 'hemoglobin_a1c', recognized: true });
  });

  it('returns unrecognized flag for unknown biomarkers', () => {
    const result = normalizeBiomarker('Some Unknown Marker');
    expect(result.recognized).toBe(false);
    expect(result.canonical).toBe('Some Unknown Marker');
  });

  it('handles null and empty input', () => {
    expect(normalizeBiomarker(null)).toEqual({ canonical: null, recognized: false });
    expect(normalizeBiomarker('')).toEqual({ canonical: null, recognized: false });
  });

  it('is case-insensitive', () => {
    expect(normalizeBiomarker('crp')).toEqual({ canonical: 'crp', recognized: true });
    expect(normalizeBiomarker('CRP')).toEqual({ canonical: 'crp', recognized: true });
  });
});
