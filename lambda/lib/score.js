// Pure score computation — no Supabase, no network. (T9)
// Layer 1: profile completeness/richness (always active)
// Layer 2: biomarker trajectory modifier (Phase 2, activates at 3+ readings)

const PROFILE_FIELDS = ['age', 'sex', 'chronic_conditions', 'current_medications', 'allergies', 'lifestyle_notes'];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Layer 1 (0-100):
 *  - documents uploaded: 0-30 (3 pts/doc, capped at 10 docs)
 *  - biomarker diversity: 0-20 (2 pts per unique recognized canonical name, cap 10)
 *  - profile completeness: 0-20 (filled fields / 6)
 *  - recency: 20 if doc within 6 months, 10 within 12, else 0
 *  - follow-ups acted on: 0-10 (2 pts per reviewed dismissal — dismissed >=1h
 *    after first served — capped at 5)
 *
 * @param docs Array<{ date_of_service, created_at, abnormal_values: [{canonical_name, recognized}] }>
 * @param profile user_profiles row or null
 * @param reviewedDismissals number of insights dismissed >=1h after served
 */
function computeLayer1(docs, profile, reviewedDismissals = 0) {
  const documents = (docs || []).length;
  const docPoints = Math.min(documents, 10) * 3;

  const canonicals = new Set();
  for (const doc of docs || []) {
    for (const bm of doc.abnormal_values || []) {
      if (bm.recognized && bm.canonical_name) canonicals.add(bm.canonical_name);
    }
  }
  const diversityPoints = Math.min(canonicals.size, 10) * 2;

  let filled = 0;
  if (profile) {
    for (const field of PROFILE_FIELDS) {
      const v = profile[field];
      if (v == null) continue;
      if (Array.isArray(v) ? v.length > 0 : String(v).length > 0) filled++;
    }
  }
  const profilePoints = Math.round((filled / PROFILE_FIELDS.length) * 20);

  let recencyPoints = 0;
  const now = Date.now();
  const SIX_MONTHS = 183 * 24 * 60 * 60 * 1000;
  const TWELVE_MONTHS = 366 * 24 * 60 * 60 * 1000;
  for (const doc of docs || []) {
    const d = new Date(doc.date_of_service || doc.created_at).getTime();
    if (isNaN(d)) continue;
    const age = now - d;
    if (age <= SIX_MONTHS) { recencyPoints = 20; break; }
    if (age <= TWELVE_MONTHS) recencyPoints = Math.max(recencyPoints, 10);
  }

  const followUpPoints = Math.min(reviewedDismissals, 5) * 2;

  const breakdown = {
    documents: { points: docPoints, max: 30 },
    biomarkers: { points: diversityPoints, max: 20 },
    profile: { points: profilePoints, max: 20 },
    recency: { points: recencyPoints, max: 20 },
    followUps: { points: followUpPoints, max: 10 },
  };

  const score = clamp(docPoints + diversityPoints + profilePoints + recencyPoints + followUpPoints, 0, 100);
  return { score, breakdown };
}

/**
 * Layer 2 trajectory modifier (-20..+20) + confidence gate.
 * NOTE: slope direction is uncalibrated (rising isn't universally good) —
 * see Open Question 5 / TODOS. UI shows amber "watch" only, never red.
 *
 * @param biomarkerTimeSeries { [canonical]: [{ date, value, urgency?, recognized? }] }
 *        Points must be sorted chronologically. Only series with 3+ points count.
 * @returns { modifier, confidence }
 */
function computeLayer2(biomarkerTimeSeries) {
  let weightedSum = 0;
  let weightTotal = 0;
  let maxRecognizedReadings = 0;
  let allRecognized = true;

  for (const points of Object.values(biomarkerTimeSeries || {})) {
    if (!points || points.length < 3) continue;

    const first = points[0].value;
    const last = points[points.length - 1].value;
    if (typeof first !== 'number' || typeof last !== 'number') continue;

    const base = Math.abs(first) || 1;
    const trajectory = clamp((last - first) / base, -1, 1);

    const isUrgent = points.some((p) => p.urgency === 'urgent');
    const weight = isUrgent ? 2 : 1;
    weightedSum += trajectory * weight;
    weightTotal += weight;

    const recognized = points.every((p) => p.recognized !== false);
    if (!recognized) allRecognized = false;
    else maxRecognizedReadings = Math.max(maxRecognizedReadings, points.length);
  }

  if (weightTotal === 0) {
    return { modifier: 0, confidence: false };
  }

  const weightedAvg = weightedSum / weightTotal;
  const modifier = Math.round(clamp(weightedAvg * 20, -20, 20));
  const confidence = allRecognized && maxRecognizedReadings >= 4;

  return { modifier, confidence };
}

function finalScore(layer1Score, layer2Modifier) {
  return clamp(layer1Score + layer2Modifier, 0, 100);
}

module.exports = { computeLayer1, computeLayer2, finalScore, clamp };
