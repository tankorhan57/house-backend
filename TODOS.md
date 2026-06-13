# House v2 — TODOS

Items deferred from engineering review. Each item has enough context to be picked up cold.

---

## [CRITICAL] HIPAA BAA — Supabase Pro upgrade
**What:** Upgrade Supabase to Pro tier ($25/month) to obtain a Business Associate Agreement (BAA).
**Why:** Storing real PHI on Supabase free tier without a BAA is non-compliant with HIPAA for any users other than yourself. Required before recruiting beta users.
**How to apply:** Go to Supabase dashboard → Billing → Upgrade to Pro. Then email Supabase for BAA.
**Depends on:** Must be resolved before Phase 0 beta recruitment begins.

---

## Runtime prohibited phrase filter
**What:** Add a regex-based runtime gate in insights.js that scans Bedrock insight output before caching or returning it. If any prohibited phrase is detected: log to CloudWatch, return `{ insights: [] }` (fail safe).
**Why:** The pre-deploy adversarial script (scripts/check-prompts.js) catches drift before deploy, but can't catch model behavior changes that happen between deploys due to Bedrock model updates on AWS's end.
**Prohibited phrases:** "you have [condition]", "you need to", "you should", "I recommend", "you must", "I advise"
**How to apply:** Add a `checkProhibitedPhrases(insights)` function in insights.js. Called after Bedrock parse, before upsert. Returns `true` if clean, `false` if dirty (logs + returns []).
**Depends on:** insights.js (Phase 1)

---

## Phase 2 cache key upgrade: qualifying_doc_count → content fingerprint
**What:** Replace `qualifying_doc_count` in insights_cache with a fingerprint: `sha256(sorted canonical names with 3+ readings + max date_of_service per biomarker)`.
**Why:** qualifying_doc_count doesn't detect which biomarkers qualify. If biomarker A drops below 3 readings (document deleted) and B rises to 3+, the count is unchanged but the cache is stale. The fingerprint detects this.
**When:** Phase 2, when user volume grows. At Phase 1 beta scale (10 users, ~30 docs each), qualifying_doc_count is sufficient.
**How to apply:** Replace `document_count INT` column in insights_cache with `cache_key TEXT`. Compute fingerprint in insights.js grouping step.

---

## Dismiss validation in normalization.js
**Resolved in Phase 1 PR** — moved to fix-in-PR (3 lines: validate biomarker against NORMALIZATION_MAP in POST /insights/dismiss handler, return 400 if unrecognized).

---

## [GATE: Phase 2] FDA SaMD legal review — blocks Phase 2 ship
**What:** Brief legal review (health law attorney, 1-2 hours) of the chat interface's "contextual-with-rails" approach vs FDA Software as a Medical Device (SaMD) classification.
**Why:** A chat interface that answers "why am I so tired?" using the user's own TSH + ferritin values may qualify as clinical decision support under FDA guidelines. If so, shipping without 510(k) clearance is an FDA violation. The "discuss with your doctor" closer is the key guard, but the exact phrasing and scope of AI responses needs attorney sign-off.
**Context:** Products like Juno (chronic illness AI, $70K MRR) operate in this lane. The contextual-with-rails pattern is known. This is not expected to be a blocker — it's a confirmation. But it's a gate, not a parallel track.
**How to apply:** Consult a health law attorney before Phase 2 beta ships to real users. Document the sign-off.
**Depends on:** Must resolve before Phase 2 ships.

---

## Bedrock holding response behavior spec
**What:** Fully specify what happens when Bedrock exceeds 6s and a holding response is returned: (1) rate limit counter NOT incremented (request didn't complete), (2) turn NOT saved to chat_history (conversation not polluted), (3) frontend shows "Still thinking…" with a retry button.
**Why:** If a Bedrock timeout consumes one of the user's 20 daily calls, users lose calls they never used. If it's saved to chat_history, the conversation history becomes polluted with failed turns.
**How to apply:** In handlers/chat.js — wrap Bedrock call in a 6s timeout; on timeout, return 202 with the holding response body without incrementing count or inserting into chat_history. Frontend retries on 202.
**Depends on:** T13 (handlers/chat.js, Phase 2)

---

## Monetization one-pager — before Phase 2 spend
**What:** One page answering: who pays, how much, and why. Evaluate consumer subscription vs B2B2C (concierge clinics, longevity practices, patient advocates who already aggregate records and would pay).
**Why:** CEO review (autoplan, 2026-06-12): the plan contains zero monetization thinking; consumer health subscriptions monetize poorly with cost-sensitive chronic patients. B2B2C could solve distribution + upload friction + HIPAA-buyer sophistication at once.
**How to apply:** Write before committing Phase 2 build time. Effort: S.
**Priority:** P2. **Depends on:** nothing — pure thinking work.

---

## Demand validation interviews
**What:** 15 interviews with multi-condition/multi-provider patients; look for 5 who maintain a manual workaround today (spreadsheet, binder, folder of PDFs).
**Why:** CEO outside voice: demand evidence is currently one person (the builder). Manual workaround = burning problem signal. No workaround found = demand assumption is wrong.
**How to apply:** Run in parallel with Phase 1 beta recruitment — same people can become beta users.
**Priority:** P2. **Depends on:** nothing.

---

## Email verification before questionnaire
**What:** Require verified email before accepting PHI into user_profiles.
**Why:** Defense against PHI landing in a typo'd/wrong account.
**How to apply:** Supabase auth email confirmation setting + frontend gate. Effort: S (config) to M (custom flow).
**Priority:** P3. **Depends on:** Supabase auth config.

---

## Layer 2 score UI confidence gate
**What:** Add a `confidence` flag to computeLayer2() output. Only show the trajectory arrow (↑/→/↓) in the UI when confidence is true: requires 4+ readings from recognized canonical biomarkers (recognized: true in normalization.js). With fewer readings, show Layer 1 score only, no arrow.
**Why:** 3 lab readings from different providers using different assay methods is insufficient for a reliable trend. A wrong trajectory arrow will erode user trust faster than no arrow. The current threshold (3+) is too low for a visual indicator the user will act on.
**How to apply:** computeLayer2() returns `{ modifier, confidence: boolean }`. handlers/score.js includes `trajectoryConfident: boolean` in GET /score response. Frontend only renders the arrow when trajectoryConfident = true.
**Depends on:** T9 (lib/score.js), T10 (handlers/score.js)

---

## Score history sparkline
**What:** Store health score snapshots over time (append rows vs single-row cache) to enable a "your profile over time" view.
**Why:** Deferred at /autoplan final gate (2026-06-12) — no usage data yet to justify table growth.
**How to apply:** Change health_score_cache to append snapshots; add sparkline to score widget.
**Priority:** P3. **Depends on:** T9/T10 shipped, real beta usage.
