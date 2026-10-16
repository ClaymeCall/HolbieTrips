import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };
const booking = { id: '40000000-0000-4000-8000-000000000001', reference: 'HT-ALICE-001' };

function fakePool() {
  const auditEvents: Array<{ userId: unknown; action: unknown; entityType: unknown; entityId: unknown }> = [];
  let cancelled = false;

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes("UPDATE bookings SET status='cancelled'")) {
        if (cancelled) return { rowCount: 0, rows: [] };
        cancelled = true;
        return { rowCount: 1, rows: [{ id: booking.id, reference: booking.reference, status: 'cancelled' }] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        auditEvents.push({ userId: params[0], action: params[1], entityType: params[2], entityId: params[3] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };

  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [alice] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, auditEvents, isCancelled: () => cancelled };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

async function cancelAsAlice(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: 'POST',
    url: `/api/bookings/${booking.id}/cancel`,
    headers: { authorization: 'Bearer alice' }
  });
}

describe('A09 — The Silent Suitcase', () => {
  it('records an audit event when a booking is cancelled', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await cancelAsAlice(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().flag).toBeUndefined();
    expect(fake.auditEvents).toContainEqual({
      userId: alice.id,
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: booking.id
    });
  });

  it('preserves the customer journey: an owned booking is cancelled', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await cancelAsAlice(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ booking: { id: booking.id, reference: booking.reference, status: 'cancelled' } });
    expect(fake.isCancelled()).toBe(true);
  });

  it('does not write an audit event when there is nothing left to cancel', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    await cancelAsAlice(app);
    const second = await cancelAsAlice(app);

    expect(second.statusCode).toBe(404);
    expect(fake.auditEvents).toHaveLength(1);
  });
});
