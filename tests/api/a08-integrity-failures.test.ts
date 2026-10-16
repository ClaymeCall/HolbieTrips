import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { config } from '../../apps/api/src/config';
import { paymentSignature } from '../../apps/api/src/security';

const booking = { id: '40000000-0000-4000-8000-000000000002', totalCents: 129900 };

function fakePool() {
  const auditEvents: Array<{ action: string; entityId: unknown }> = [];
  const payments: Array<Record<string, unknown>> = [];
  let bookingStatus = 'pending';

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO payments')) {
        payments.push({ bookingId: params[0], providerReference: params[1], amountCents: params[2], cardLast4: params[3] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE bookings SET status='confirmed'")) {
        bookingStatus = 'confirmed';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        auditEvents.push({ action: params[1], entityId: params[3] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id,total_cents FROM bookings')) {
        const [id, amount] = params as [string, number];
        if (id === booking.id && amount === booking.totalCents && bookingStatus === 'pending') {
          return { rowCount: 1, rows: [{ id, total_cents: amount }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        auditEvents.push({ action: params[1], entityId: params[3] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, auditEvents, payments, isConfirmed: () => bookingStatus === 'confirmed' };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

function basePayload(amountCents = booking.totalCents) {
  return {
    bookingId: booking.id,
    amountCents,
    status: 'approved',
    providerReference: 'FAKE-provider-ref-001',
    cardLast4: '4242'
  };
}

function signedPayload(amountCents = booking.totalCents) {
  const payload = basePayload(amountCents);
  const signature = paymentSignature(payload, config.paymentKey);
  return { ...payload, signature };
}

describe('A08 — Payment Postcard Pretender', () => {
  it('rejects a forged callback with no signature at all', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...basePayload(), providerReference: 'FORGED-DEMO' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().flag).toBeUndefined();
    expect(fake.payments).toHaveLength(0);
    expect(fake.isConfirmed()).toBe(false);
    expect(fake.auditEvents).toContainEqual({ action: 'payment.rejected', entityId: booking.id });
  });

  it('rejects a callback signed with the wrong key', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const payload = basePayload();
    const signature = paymentSignature(payload, 'attacker-controlled-key');

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...payload, signature }
    });

    expect(response.statusCode).toBe(400);
    expect(fake.payments).toHaveLength(0);
    expect(fake.isConfirmed()).toBe(false);
  });

  it('rejects a genuinely signed payload that has been tampered with afterwards', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const signed = signedPayload();

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: { ...signed, amountCents: 1 }
    });

    expect(response.statusCode).toBe(400);
    expect(fake.payments).toHaveLength(0);
  });

  it('accepts and confirms a correctly signed callback from the payment provider', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: signedPayload()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed' });
    expect(fake.isConfirmed()).toBe(true);
    expect(fake.payments).toHaveLength(1);
    expect(fake.auditEvents).toContainEqual({ action: 'payment.approved', entityId: booking.id });
  });

  it('still rejects a correctly signed callback whose amount does not match the booking', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/callback',
      payload: signedPayload(1)
    });

    expect(response.statusCode).toBe(404);
    expect(fake.payments).toHaveLength(0);
  });
});
