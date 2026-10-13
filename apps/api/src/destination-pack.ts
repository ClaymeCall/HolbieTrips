import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type DestinationPack = {
  packVersion: string;
  supplier: string;
  destinations: Array<{ slug: string; travelTip: string }>;
};

/** Reads a supplier pack and returns both its content and digest metadata. */
export async function loadDestinationPack(file: string, expectedSha256: string) {
  const raw = await readFile(file);
  const calculatedSha256 = createHash('sha256').update(raw).digest('hex');
  const pack = JSON.parse(raw.toString('utf8')) as DestinationPack;

  return {
    pack,
    integrity: {
      algorithm: 'sha256',
      expected: expectedSha256,
      calculated: calculatedSha256,
      accepted: expectedSha256 === calculatedSha256
    }
  };
}
