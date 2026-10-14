import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const alice = { id: '10000000-0000-4000-8000-000000000001', email: 'alice.martin@example.test', full_name: 'Alice Martin', role: 'customer' };

function fakePool(bookingRow: { status: string; payment_status: string | null }) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [alice] };
    if (sql.includes('SELECT b.id,b.status')) return { rowCount: 1, rows: [{ id: 'booking', ...bookingRow }] };
    if (sql.includes("UPDATE bookings SET status='confirmed'")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }), end: vi.fn(async () => undefined) };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A10 — The Emergency Exit Is Open', () => {
  it('returns 503 and leaves the booking untouched when the readiness check is unavailable', async () => {
    const pool = fakePool({ status: 'pending', payment_status: 'approved' });
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/bookings/40000000-0000-4000-8000-000000000001/confirm', headers: { authorization: 'Bearer alice' }, payload: { simulateCheckFailure: true } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('FLAG{');
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE bookings SET status='confirmed'"))).toBe(false);
  });

  it('preserves the normal rejection when payment is missing', async () => {
    const app = await buildApp(fakePool({ status: 'pending', payment_status: null }) as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/bookings/40000000-0000-4000-8000-000000000001/confirm', headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('FLAG{');
  });

  it('confirms the booking when payment is approved and the check succeeds', async () => {
    const app = await buildApp(fakePool({ status: 'pending', payment_status: 'approved' }) as unknown as Pool, { serveFrontend: false }); opened.push(app);
    const response = await app.inject({ method: 'POST', url: '/api/bookings/40000000-0000-4000-8000-000000000001/confirm', headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
  });
});
