import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../apps/api/src/app';
import { protectPassport, revealPassport } from '../../apps/api/src/security';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const demoPassport = 'FR-DEMO-BRUNO-8742';
const account = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'alice.martin@example.test',
  full_name: 'Alice Martin',
  role: 'customer'
};

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });

describe('A04 — Passport Panic', () => {
  it('protects passport numbers with authenticated encryption, not a reversible encoding', () => {
    const protectedValue = protectPassport(demoPassport, key);

    expect(protectedValue.iv).not.toBe('legacy-base64');
    expect(protectedValue.tag).toBeTruthy();
    expect(Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8')).not.toBe(demoPassport);
    expect(revealPassport(protectedValue.ciphertext, protectedValue.iv, protectedValue.tag, key)).toBe(demoPassport);
  });

  it('produces non-deterministic ciphertext for the same passport number', () => {
    const first = protectPassport(demoPassport, key);
    const second = protectPassport(demoPassport, key);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects a tampered ciphertext or authentication tag instead of returning altered plaintext', () => {
    const protectedValue = protectPassport(demoPassport, key);

    const tamperedCiphertext = Buffer.from(protectedValue.ciphertext, 'base64');
    tamperedCiphertext[0] ^= 0xff;
    expect(() =>
      revealPassport(tamperedCiphertext.toString('base64'), protectedValue.iv, protectedValue.tag, key)
    ).toThrow();

    const tamperedTag = Buffer.from(protectedValue.tag!, 'base64');
    tamperedTag[0] ^= 0xff;
    expect(() =>
      revealPassport(protectedValue.ciphertext, protectedValue.iv, tamperedTag.toString('base64'), key)
    ).toThrow();
  });

  it('round-trips the passport number through the authorised profile update and read endpoints', async () => {
    let stored: { ciphertext: string | null; iv: string | null; tag: string | null } = {
      ciphertext: null,
      iv: null,
      tag: null
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [account] };
        if (sql.includes('INSERT INTO traveler_profiles')) {
          const values = params as unknown[];
          stored = { ciphertext: values[4] as string | null, iv: values[5] as string | null, tag: values[6] as string | null };
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO audit_events')) return { rowCount: 1, rows: [] };
        if (sql.includes('FROM traveler_profiles')) {
          return {
            rowCount: 1,
            rows: [
              {
                phone: null,
                birth_date: null,
                nationality: null,
                passport_ciphertext: stored.ciphertext,
                passport_iv: stored.iv,
                passport_tag: stored.tag
              }
            ]
          };
        }
        throw new Error(`Unexpected query in test double: ${sql}`);
      }),
      end: vi.fn(async () => undefined)
    };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false });
    opened.push(app);

    const update = await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { authorization: 'Bearer alice' },
      payload: { passportNumber: demoPassport }
    });
    expect(update.statusCode).toBe(200);
    expect(stored.iv).not.toBe('legacy-base64');
    expect(stored.ciphertext).not.toBeNull();
    expect(stored.ciphertext).not.toContain(demoPassport);

    const read = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer alice' } });
    expect(read.statusCode).toBe(200);
    expect(read.json().profile.passportNumber).toBe(demoPassport);
  });
});
