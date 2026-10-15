import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';

const bruno = { id: '10000000-0000-4000-8000-000000000002', email: 'bruno.dupont@example.test' };

type TokenRecord = { userId: string; expiresAt: number; usedAt: number | null };

function fakePool() {
  const tokens = new Map<string, TokenRecord>();
  const passwords = new Map<string, string>();

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT user_id FROM password_reset_tokens')) {
        const entry = tokens.get(params[0] as string);
        if (!entry || entry.usedAt !== null || entry.expiresAt <= Date.now()) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ user_id: entry.userId }] };
      }
      if (sql.includes('UPDATE users SET password_hash')) {
        passwords.set(params[1] as string, params[0] as string);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE password_reset_tokens SET used_at')) {
        const entry = tokens.get(params[0] as string);
        if (entry) entry.usedAt = Date.now();
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('DELETE FROM sessions') || sql.includes('INSERT INTO audit_events')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected client query: ${sql}`);
    }),
    release: vi.fn()
  };

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id,email FROM users WHERE email=')) {
        return params[0] === bruno.email ? { rowCount: 1, rows: [bruno] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO password_reset_tokens')) {
        const [hash, userId] = params as [string, string];
        tokens.set(hash, { userId, expiresAt: Date.now() + 15 * 60_000, usedAt: null });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined)
  };

  return { pool, client, tokens, passwords };
}

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
  vi.unstubAllGlobals();
});

/** Captures the reset token the server would have delivered over e-mail. */
function stubMailAndCapture() {
  const delivered: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    delivered.push(body.resetToken);
    return new Response(JSON.stringify({ accepted: true }), { status: 201 });
  }));
  return delivered;
}

async function requestReset(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/request',
    payload: { email: bruno.email }
  });
  expect(response.statusCode).toBe(200);
}

describe('A07 — Reset Route Roulette', () => {
  it('produces a different token on each reset request', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const delivered = stubMailAndCapture();

    await requestReset(app);
    await requestReset(app);

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).not.toBe(delivered[1]);
    expect(Buffer.from(delivered[0], 'base64url')).not.toEqual(Buffer.from(bruno.email, 'utf8'));
  });

  it('lets a valid token work once for the correct account', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const delivered = stubMailAndCapture();

    await requestReset(app);
    const token = delivered[0];

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'BrandNewPassword123!' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(fake.passwords.get(bruno.id)).toBe('BrandNewPassword123!');
  });

  it('rejects a reused token', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const delivered = stubMailAndCapture();

    await requestReset(app);
    const token = delivered[0];
    const payload = { token, password: 'BrandNewPassword123!' };

    const first = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload });
    expect(second.statusCode).toBe(400);
  });

  it('rejects an expired token', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const delivered = stubMailAndCapture();

    await requestReset(app);
    const token = delivered[0];
    const { tokenDigest } = await import('../../apps/api/src/security');
    const entry = fake.tokens.get(tokenDigest(token))!;
    entry.expiresAt = Date.now() - 1000;

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token, password: 'BrandNewPassword123!' }
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an altered token', async () => {
    const fake = fakePool();
    const app = await buildApp(fake.pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);
    const delivered = stubMailAndCapture();

    await requestReset(app);
    const token = delivered[0];
    const altered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token: altered, password: 'BrandNewPassword123!' }
    });
    expect(response.statusCode).toBe(400);
  });
});
