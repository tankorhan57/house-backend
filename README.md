# House v2 — Personal Medical Document Vault

AI health vault that accumulates your medical documents, interprets each one in plain language, and builds longitudinal context across time.

## Architecture

- **Frontend:** Next.js + Vercel (no PHI)
- **API:** AWS Lambda + API Gateway (all PHI handling)
- **Storage:** S3 with SSE-KMS encryption
- **AI:** AWS Bedrock (Claude) — HIPAA BAA covered
- **Database:** Supabase Pro (HIPAA BAA signed)

## Stack

- AWS Lambda (PHI API routes)
- AWS Bedrock — `us.anthropic.claude-opus-4-6-v1`
- AWS S3 SSE-KMS — `house-v2-documents-014810124016`
- AWS KMS — `alias/house-v2-documents`
- Supabase Pro (documents + audit_log)
- Next.js + Vercel (frontend only)
- Vitest (unit tests)
- Playwright (E2E tests)

## AWS Resources

| Resource | Name/ID |
|----------|---------|
| S3 Bucket | `house-v2-documents-014810124016` |
| KMS Key | `alias/house-v2-documents` |
| App Role | `house-v2-app-role` |
| Admin Role | `house-v2-admin-role` |
| Bedrock Model | `us.anthropic.claude-opus-4-6-v1` |
| Region | `us-east-1` |

## Legal

Patient education tool. Not medical advice. HIPAA-compliant infrastructure.
