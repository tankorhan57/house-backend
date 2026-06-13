import { describe, it, expect, vi, beforeEach } from 'vitest';
import deleteHandler from '../../lambda/handlers/delete.js';

// Inject a fake S3 client — never hit real AWS in unit tests
const s3Send = vi.fn();
deleteHandler._deps.s3 = { send: s3Send };

// Build a supabase mock that records which tables were deleted from.
function makeSupabase({ docs = [], deleteErrors = {} } = {}) {
  const deletedTables = [];
  return {
    deletedTables,
    from(table) {
      return {
        select: () => ({
          eq: async () => ({ data: docs, error: null }),
        }),
        delete: () => ({
          eq: async () => {
            deletedTables.push(table);
            return { error: deleteErrors[table] || null };
          },
        }),
      };
    },
  };
}

const event = { requestContext: { identity: { sourceIp: '1.2.3.4' } } };

beforeEach(() => {
  s3Send.mockReset();
  s3Send.mockResolvedValue({});
});

describe('deleteAccount', () => {
  it('deletes from all user-data tables', async () => {
    const supabase = makeSupabase({ docs: [{ id: 'd1', s3_key: 'k1' }] });
    const res = await deleteHandler.deleteAccount(event, {}, supabase, 'u1');

    expect(res.statusCode).toBe(200);
    expect(supabase.deletedTables).toEqual([
      'documents',
      'insights_cache',
      'dismissed_insights',
      'user_profiles',
      'health_score_cache',
      'chat_history',
    ]);
  });

  it('deletes Supabase rows BEFORE S3 objects (fail-safe ordering)', async () => {
    const order = [];
    s3Send.mockImplementation(async () => {
      order.push('s3');
      return {};
    });
    const supabase = makeSupabase({ docs: [{ id: 'd1', s3_key: 'k1' }] });
    const origFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      const chain = origFrom(table);
      const origDelete = chain.delete.bind(chain);
      chain.delete = () => {
        order.push(`db:${table}`);
        return origDelete();
      };
      return chain;
    };

    await deleteHandler.deleteAccount(event, {}, supabase, 'u1');
    expect(order.indexOf('db:documents')).toBeLessThan(order.indexOf('s3'));
  });

  it('skips tables that do not exist yet (42P01)', async () => {
    const supabase = makeSupabase({
      deleteErrors: {
        user_profiles: { code: '42P01', message: 'relation does not exist' },
        chat_history: { code: '42P01', message: 'relation does not exist' },
      },
    });
    const res = await deleteHandler.deleteAccount(event, {}, supabase, 'u1');
    expect(res.statusCode).toBe(200);
  });

  it('fails with 500 on a real delete error', async () => {
    const supabase = makeSupabase({
      deleteErrors: {
        insights_cache: { code: '500', message: 'connection lost' },
      },
    });
    const res = await deleteHandler.deleteAccount(event, {}, supabase, 'u1');
    expect(res.statusCode).toBe(500);
  });

  it('succeeds even when S3 cleanup fails (best-effort)', async () => {
    s3Send.mockRejectedValue(new Error('s3 down'));
    const supabase = makeSupabase({ docs: [{ id: 'd1', s3_key: 'k1' }] });
    const res = await deleteHandler.deleteAccount(event, {}, supabase, 'u1');

    // DB rows already deleted — S3 failure must not fail the request
    expect(res.statusCode).toBe(200);
  });
});
