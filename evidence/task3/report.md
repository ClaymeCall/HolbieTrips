# A04 - Passport Panic

## Vulnerability

Traveller passport numbers are stored in `traveler_profiles.passport_ciphertext` alongside `passport_iv` and `passport_tag`, columns shaped like an AES-GCM authenticated-encryption payload. In practice, the local stack's default configuration (`PASSPORT_PROTECTION_MODE=legacy-base64`, set in `compose.yaml` and `.env.example`) made `protectPassport` skip encryption entirely: it just base64-encoded the value and wrote the sentinel `iv: 'legacy-base64'`, `tag: null`. `revealPassport` mirrored this with a base64-decode shortcut. No key was ever involved — anyone with read access to the stored value (or the value itself, e.g. via a DB dump) could recover the plaintext passport number instantly, without `APP_ENCRYPTION_KEY`, defeating the entire point of storing it as "ciphertext" (CWE-327, use of a broken/risky cryptographic algorithm; the scheme provided no confidentiality at all).

## Exploitation

Bruno's seeded profile held `passport_ciphertext = 'RlItREVNTy1CUlVOTy04NzQy'` with `passport_iv = 'legacy-base64'`. Decoding it required no key and no application access beyond the raw column value:

```
$ echo RlItREVNTy1CUlVOTy04NzQy | base64 -d
FR-DEMO-BRUNO-8742
```

The `iv = 'legacy-base64'` sentinel is what confirms the weak mode was in use rather than real encryption: a genuine AES-GCM IV is 12 random bytes, and a correctly encrypted value does not decode to readable UTF-8 with a generic base64 decode.

## Root Cause

`apps/api/src/security.ts` had two storage representations for passport numbers, selected by a `mode` argument:

```ts
export function protectPassport(value: string, keyHex: string, mode: string) {
  if (mode === 'legacy-base64') {
    return { ciphertext: Buffer.from(value, 'utf8').toString('base64'), iv: 'legacy-base64', tag: null };
  }
  return encryptSensitive(value, keyHex);
}
```

The repository already contained correct authenticated-encryption helpers (`encryptSensitive`/`decryptSensitive`, AES-256-GCM with a fresh random 12-byte IV and a verified authentication tag), but the `legacy-base64` escape hatch bypassed them — and `apps/api/src/config.ts` defaulted `PASSPORT_PROTECTION_MODE` to exactly that mode, so every new write through `PUT /api/me` used the weak path by default, not just the stale seed row.

## Remediation

- Removed the `legacy-base64` branch from `protectPassport`/`revealPassport` (`apps/api/src/security.ts`) — passport numbers now always go through `encryptSensitive`/`decryptSensitive` (AES-256-GCM, random IV per call, authentication tag required to decrypt).
- Dropped the `mode` parameter and the `passportProtectionMode` setting (`apps/api/src/config.ts`, `apps/api/src/routes/profile.ts`) and removed `PASSPORT_PROTECTION_MODE` from `compose.yaml` and `.env.example` — there is no longer an insecure option to misconfigure.
- Re-encrypted the seeded demo passport (`database/seeds/001_demo.sql`) with real AES-256-GCM under the existing `APP_ENCRYPTION_KEY`, including the previously-missing `passport_tag` value.
- `revealPassport` now throws on a missing IV/tag instead of silently falling back, and `decryptSensitive`'s GCM tag verification causes any tampered ciphertext or tag to throw rather than returning altered or partial plaintext — the API fails closed instead of degrading to no protection.
- Removed the standalone `/api/challenges/a04/claim` endpoint from `apps/api/src/routes/profile.ts`: it was a bolt-on digest-comparison oracle unrelated to the actual storage fix and is not part of the corrected API surface.

## Verification

![passing tests](passing-tests.png)

`tests/api/a04-cryptographic-failures.test.ts` covers:
- authenticated storage: `protectPassport` never returns the `legacy-base64` sentinel, produces ciphertext that does not base64-decode back to plaintext, and round-trips correctly through `revealPassport` with the key;
- non-deterministic ciphertext for identical passport numbers (fresh random IV per encryption);
- tamper rejection: flipping a byte in the ciphertext or the authentication tag makes `revealPassport` throw instead of returning altered plaintext;
- the authorised business flow: `PUT /api/me` stores a non-legacy, non-plaintext-containing ciphertext, and `GET /api/me` correctly decrypts it back to the original passport number.
