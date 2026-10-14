import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadDestinationPack } from '../../apps/api/src/destination-pack';
import { buildApp } from '../../apps/api/src/app';
import { config } from '../../apps/api/src/config';
import type { Pool } from 'pg';

const approvedDigest = '78f5ba6c78041a2f7cff89ad032c5df7a5a03c9dddbe63150d7ca2d23be4bc93';
const approvedFile = resolve('database/fixtures/destination-pack-approved.json');
const alteredFile = resolve('database/fixtures/destination-pack-altered.json');

describe('A03 — The Mystery Destination Pack', () => {
  afterEach(() => {
    config.destinationPackFile = approvedFile;
  });

  it('flags an altered pack as untrusted instead of accepting it', async () => {
    const loaded = await loadDestinationPack(alteredFile, approvedDigest);
    expect(loaded.integrity.calculated).not.toBe(loaded.integrity.expected);
    expect(loaded.integrity.accepted).toBe(false);
  });

  it('refuses to serve the destination pack when integrity verification fails', async () => {
    config.destinationPackFile = alteredFile;

    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const app = await buildApp(pool as unknown as Pool, { serveFrontend: false, diagnosticsEnabled: false });
    const response = await app.inject({ method: 'GET', url: '/api/destination-pack' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/FLAG\{a03_[a-f0-9]{24}\}/);
    expect(response.json()).not.toHaveProperty('destinations');
    expect(response.body).not.toContain('altered destination pack');
    await app.close();
  });

  it('preserves the positive path for the approved pack', async () => {
    const loaded = await loadDestinationPack(approvedFile, approvedDigest);
    expect(loaded.integrity.calculated).toBe(approvedDigest);
    expect(loaded.integrity.accepted).toBe(true);
    expect(loaded.pack.supplier).toBe('HolbieTripsSync');
  });
});
