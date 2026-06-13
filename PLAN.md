<!-- /autoplan restore point: /Users/korhantan/.gstack/projects/house-v2/main-autoplan-restore-20260604-171312.md -->
# House v2 — Feature Roadmap Plan

## Context

House v2 is a personal HIPAA-compliant medical document vault. Users upload lab reports, imaging, and visit notes (PDF/JPG/PNG). AWS Bedrock (Claude Vision) extracts and interprets the documents. Frontend is React/TanStack Router deployed via Lovable.dev. Backend is a single Lambda function behind API Gateway, using Supabase for auth and storage.

**Current state (as of June 2026):**
- Multi-file upload working (fixed)
- Markdown rendering in document detail (fixed)
- Security credentials rotated (Supabase service_role key, AWS access key)
- $50/month billing alert set
- Documents list, document detail, trends page exist in frontend
- Lambda handlers exist for: presign, process, documents (list + get), delete, trend

**Stack:**
- Frontend: React + TanStack Router + TanStack Query, deployed via Lovable.dev → GitHub main
- Backend: Node.js Lambda (house-v2-api) + API Gateway (29s timeout)
- AI: AWS Bedrock (Claude 3 Sonnet / Vision)
- Storage: Supabase (auth + Postgres + RLS)
- S3: document storage

---

## Features to Build

### F1 — Delete Document (UI)
**What:** Add a delete button to each document card on the list page and the document detail page. The Lambda handler (`handlers/delete.js`) already exists.
**Why:** Users upload test files and need to clean up. No delete = documents accumulate forever.
**Scope:**
- Frontend: trash icon button on document card in `index.tsx`, confirm dialog before deletion
- Frontend: delete button on document detail page `document.$id.tsx`
- API: `DELETE /documents/:id` already implemented in Lambda
- Frontend: optimistic removal from list after delete, toast confirmation
**Files affected:** `src/routes/_authenticated/index.tsx`, `src/routes/_authenticated/document.$id.tsx`, `src/lib/api.ts` (add `deleteDocument` method)

### F2 — PDF Upload Verification
**What:** Verify the PDF upload and analysis path works end-to-end. Images work (tested). PDFs untested.
**Why:** PDFs are the primary format for medical documents — lab reports, discharge summaries.
**Scope:**
- Upload a real PDF lab report
- Verify Bedrock vision can process it (it uses base64 encoding)
- Check if the process handler converts PDF to image for Bedrock or sends raw
- Fix any issues found
**Files affected:** `lambda/handlers/process.js`, possibly frontend upload validation

### F3 — Async Document Processing
**What:** Decouple upload from processing so the frontend doesn't wait 20-120s for Bedrock.
**Why:** API Gateway has a 29-second hard timeout. Multi-page PDFs and slow Bedrock calls exceed this. Users currently see a spinner for up to 2 minutes and occasionally get timeout errors.
**Approach:** SQS-based async processing
- Frontend calls `/presign` → uploads to S3 → calls `/process` (returns 202 Accepted immediately)
- Lambda enqueues to SQS, returns `{documentId, status: "processing"}`
- SQS consumer Lambda runs Bedrock, updates Supabase
- Frontend polls `GET /documents/:id` until `status === "done"` (or uses Supabase Realtime)
**Files affected:** Lambda architecture (new SQS consumer), `handlers/process.js`, `src/routes/_authenticated/upload.tsx` (polling logic), `src/lib/api.ts`
**Infrastructure:** New SQS queue, new Lambda consumer, IAM role updates

### F4 — Trends Page Verification + Fix
**What:** Test the trends page with real biomarker data from uploaded documents.
**Why:** Trend tracking is a key value prop — seeing how your cholesterol changes over time. Unverified since no real lab data with repeat biomarkers.
**Scope:**
- Upload 2+ lab reports with the same biomarker (e.g., cholesterol, hemoglobin)
- Verify trend chart renders correctly
- Fix any data mapping issues between Bedrock extraction and trend API
**Files affected:** `src/routes/_authenticated/trends.tsx`, `lambda/handlers/trend.js`

### F5 — Document Search + Filter
**What:** Search documents by type, date range, or provider. Filter by urgency.
**Why:** Once users have 20+ documents, finding a specific lab report from 6 months ago becomes painful.
**Scope:**
- Frontend: search bar + urgency filter chips on the documents list
- API: add query params to `GET /documents` (`?type=&urgency=&provider=&from=&to=`)
- Supabase: use `.ilike()` for text search, `.eq()` for urgency
**Files affected:** `src/routes/_authenticated/index.tsx`, `lambda/handlers/documents.js`, `src/lib/api.ts`

---

## Prioritization

| Priority | Feature | Effort (human) | Effort (CC) | Value |
|----------|---------|----------------|-------------|-------|
| P1 | F1 Delete Document (UI) | 2h | 15min | High — hygiene |
| P1 | F2 PDF Verification | 1h | 30min | High — untested core path |
| P2 | F3 Async Processing | 2 days | 2h | High — reliability |
| P2 | F4 Trends Verification | 1h | 30min | Medium — data quality |
| P3 | F5 Search + Filter | 4h | 45min | Medium — discoverability |

---

## Out of Scope (This Phase)
- HIPAA BAA (Supabase Pro) — wait until real users
- Push notifications — requires mobile app or PWA
- Document sharing — complex auth model, later
- Mobile app — later
- Multi-user / family accounts — later

---

## Technical Constraints
- Lovable.dev deploys from GitHub main — frontend changes go through git push → Lovable picks up → user publishes
- API Gateway 29s timeout blocks synchronous Bedrock calls for large documents
- AWS root access key rotated (new key stored locally, not in plan files)
- Supabase free tier — no BAA, dev/test only

---

## /autoplan Review Report

**Voices:** [subagent-only] — Codex binary not installed. Claude subagent ran CEO + Eng phases independently.

---

### CEO REVIEW

**CEO DUAL VOICES — CONSENSUS TABLE [subagent-only]:**
```
  Dimension                                 Claude  Codex  Consensus
  ─────────────────────────────────────── ─────── ─────── ──────────
  1. Premises valid?                        No      N/A    subagent-only
  2. Right problem to solve?                Part.   N/A    subagent-only
  3. Scope calibration correct?             No      N/A    subagent-only
  4. Alternatives sufficiently explored?    No      N/A    subagent-only
  5. Competitive/market risks covered?      No      N/A    subagent-only
  6. 6-month trajectory sound?             Risky   N/A    subagent-only
```

**CEO findings:**

- **[HIGH] Wrong problem framing.** The plan describes a storage vault. The product is actually a longitudinal health intelligence layer. Trends are the moat, not the vault. F4 is listed P2 as "verification" — it should be the strategic thesis.
- **[CRITICAL] Upload retention assumption.** The plan assumes users consistently upload over time. They won't without a trigger. No feature here reduces upload friction (no email forwarding, no reminder loop). Without retention, this becomes a one-upload vault.
- **[HIGH] 6-month regret: unvalidated extraction.** F2 is "PDF verification" but framed as low-urgency. Bedrock extraction quality is the foundation everything else builds on. If lab values are wrong, trend charts are wrong, and users make health decisions on bad data.
- **[HIGH] F3 misranked.** Async processing is P2 but is a prerequisite for the product functioning. API Gateway 29s timeout means multi-page PDFs already fail. F3 should be P0.
- **[CRITICAL] Data loss bug in process.js.** On any Bedrock failure, process.js deletes the user's original S3 document as "cleanup." Health records destroyed silently on transient errors.

**Dream state delta:**
```
CURRENT → THIS PLAN → 12-MONTH IDEAL
  - uploads work for images    → async, reliable uploads     → email forwarding + providers
  - no delete UI               → delete works                → retention reminders
  - trends broken (wrong param)→ trends verified             → longitudinal intelligence moat
  - no search                  → search/filter               → ML-powered search
  - sync 29s timeout           → SQS async                   → real-time Supabase updates
```

**What already exists (CEO mapping):**
- DELETE /documents/:id handler — complete, just needs frontend
- PDF handling in process.js — already implemented (text + scanned PDF paths)
- Trend handler — exists but broken (wrong query param in frontend)
- delete.js — has proper RLS (user_id check), S3 retry logic

**NOT in scope (CEO deferred):**
- Email forwarding for document ingestion (F6 — high leverage, out of phase)
- FHIR/CommonHealth provider portal integration (F7 — complex, later)
- Push notifications (F8 — needs mobile or PWA, later)

---

### ENG REVIEW

**ENG DUAL VOICES — CONSENSUS TABLE [subagent-only]:**
```
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               No      N/A    subagent-only
  2. Test coverage sufficient?         No      N/A    subagent-only
  3. Performance risks addressed?      Part.   N/A    subagent-only
  4. Security threats covered?         No      N/A    subagent-only
  5. Error paths handled?              No      N/A    subagent-only
  6. Deployment risk manageable?       Med.    N/A    subagent-only
```

**Eng findings (by severity):**

**CRITICAL:**
- **IDOR in process.js:31** — handler fetches S3 object using caller-supplied `key` without verifying it belongs to `userId`. Attacker can pass any other user's S3 key, steal their document, and associate it with their own account. Fix: validate `key` against a pending presign table before fetching.
- **Data loss on failure in process.js:114** — on any error (Bedrock timeout, bad response, Supabase error), the catch block deletes the user's S3 object. Health records permanently destroyed on transient failures. Fix: never delete S3 in catch; only clean up on explicit user-triggered delete.

**HIGH:**
- **Trends broken in production (api.ts:157 vs trend.js)** — frontend sends `?biomarker=` but trend handler reads `event.queryStringParameters?.documentType`. These never match. F4 "verification" will immediately find this. Fix: align query param name — use `biomarker` in both.
- **Partial state on delete (delete.js:49-59)** — S3 deleted before Supabase. If Supabase fails, document row points to nonexistent S3 object. Fix: delete Supabase row first, then S3.
- **No duplicate insert guard (process.js:81)** — retry on network hiccup hits Supabase unique constraint → catch block deletes S3 → user loses document. Fix: upsert or check before insert; never delete S3 on duplicate key error.
- **F3 SQS design underspecified** — no DLQ (failed messages retry forever burning Bedrock tokens), no idempotency (SQS re-delivery causes duplicate Bedrock calls), no `status` column on documents table (polling won't work without it). Fix: add these to F3 spec before implementing.

**MEDIUM:**
- **getOne uses path string parsing (documents.js:5)** — `event.path.split('/documents/')[1]` is fragile. Delete handler correctly uses `event.pathParameters?.id`. Fix: use `pathParameters` in both.
- **Division by zero in trend.js** — `Math.abs((curr - prev) / prev)` when prev=0 produces Infinity/NaN. Fix: guard with `if (prev !== 0)`.

**LOW:**
- **CORS wildcard on PHI API** — `Access-Control-Allow-Origin: *` should be scoped to the app's Lovable URL before real users.

**Architecture ASCII diagram:**
```
User Browser
  │
  ├─► Lovable.dev (CDN)
  │     └── React SPA (TanStack Router)
  │           ├─ /upload → POST /presign → PUT S3 (presigned) → POST /process [SYNC, 29s limit]
  │           ├─ / → GET /documents
  │           ├─ /document/$id → GET /documents/:id
  │           └─ /trends → GET /trend?biomarker=X [BROKEN: mismatch]
  │
  └─► API Gateway (29s hard timeout)
        └── Lambda: house-v2-api
              ├─ presign.js → generates S3 presigned URL + documentId
              ├─ process.js → S3 get → Bedrock → Supabase insert [CRITICAL: IDOR + data loss]
              ├─ documents.js → Supabase SELECT (RLS: user_id) [MEDIUM: fragile ID parsing]
              ├─ delete.js → S3 delete → Supabase DELETE [HIGH: wrong order]
              └─ trend.js → Supabase SELECT + aggregate [MEDIUM: div/0 risk]
```

**NOT in scope (Eng deferred):**
- SQS consumer Lambda (F3 prerequisite — design must be completed first)
- Supabase `documents.status` column migration (needed for F3 polling)
- CORS allowlist tightening (low priority, no real users yet)

---

### DESIGN REVIEW (UI scope detected)

**Key design findings:**
- **No loading state for delete** — plan calls for optimistic removal but doesn't specify what happens if the delete API fails after the card disappears. Needs a rollback + error toast.
- **Confirm dialog** — trash icon + confirm is the right pattern. The plan specifies this correctly.
- **No empty state after deleting last document** — the Dashboard already handles empty state (the "No documents yet" card). Confirmed: TanStack Query invalidation after delete will trigger a refetch and the empty state will show. No new code needed.
- **Trends page is a dead end without working data** — if users land on trends with no valid data, they see nothing. Need an informative empty state explaining that trends appear after uploading multiple documents with the same biomarkers.

---

### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 1 | CEO | Move F3 to P0 | Mechanical | P6 (bias toward action) | API Gateway timeout means upload already fails for large PDFs |
| 2 | Eng | Fix IDOR in process.js before F1 | Mechanical | P5 (explicit over clever) | Critical security — PHI exposure |
| 3 | Eng | Fix trends query param before F4 | Mechanical | P3 (pragmatic) | Already broken in production |
| 4 | Eng | Fix data-loss bug in process.js catch | Mechanical | P1 (completeness) | User health records being destroyed |
| 5 | CEO | Reframe F4 as product thesis | Taste | P1 (completeness) | Strategic direction, user decides |
| 6 | CEO | Add retention mechanism to roadmap | Taste | P2 (boil lakes) | Borderline scope expansion |

---

## GSTACK REVIEW REPORT
