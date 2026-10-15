# A06 - Coupon Carousel

## Vulnerability

`POST /api/bookings` accepts a `couponCode` field that it treats as a **comma-separated list** of coupon codes, in `apps/api/src/routes/bookings.ts`. The handler loops over every code in that list and applies the percentage discount for each match it finds, with no check that the codes are distinct. Submitting the same valid code twice in one request (`"BIENVENUE10,BIENVENUE10"`) causes the discount to be looked up and applied twice against the running total in a single booking, compounding the reduction instead of being rejected as a duplicate redemption. Each pass also increments the coupon's `uses` counter, so a single request can burn through a limited-use promotion faster than intended. This is an insecure-design flaw (CWE-840): the business rule "one coupon per booking" was never enforced, and an implementation detail (splitting on `,`) silently turned a single-code field into an unbounded discount-stacking vector.

## Exploitation

- Authenticate as any customer and send:
  ```
  POST /api/bookings
  Authorization: Bearer <token>
  Content-Type: application/json

  { "tripId": "<uuid>", "travelers": 1, "couponCode": "BIENVENUE10,BIENVENUE10" }
  ```
- The handler splits `couponCode` on `,` into `["BIENVENUE10", "BIENVENUE10"]` and applies the 10% discount twice in sequence: a 100 000¢ trip becomes 90 000¢ after the first pass, then 81 000¢ after the second — a 19% reduction from one coupon, not the single 10% a customer is entitled to.
- The response is `201 Created` with the double-discounted `total_cents`.

## Root Cause

```ts
const couponCodes = readText(body.couponCode, 120)
  .toUpperCase()
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
...
for (const couponCode of couponCodes) {
  const couponResult = await client.query(
    `SELECT * FROM coupons WHERE code=$1 AND starts_at<=now() AND ends_at>=now() AND uses<max_uses FOR UPDATE`,
    [couponCode]
  );
  ...
  total = applyCoupon(total, { discountPercent: coupon.discount_percent, minimumCents: coupon.minimum_cents });
  await client.query('UPDATE coupons SET uses=uses+1 WHERE id=$1', [coupon.id]);
}
```

`couponCodes` is derived by splitting a single string on commas and is never deduplicated or bounded to one entry. The loop body re-validates and re-applies `applyCoupon` for every token it finds, including repeats of the exact same code, so the discount compounds multiplicatively with each repetition. The input was also only ever coerced with `readText`, which silently turns any non-string value (an array, an object) into `''` — so a client sending the field as JSON array got no error and no coupon applied, masking the real shape the endpoint expected.

## Remediation

- `POST /api/bookings` (`apps/api/src/routes/bookings.ts`) now validates `couponCode` **before** opening the booking transaction:
  - A value that is present but not a `string` (e.g. an array) is rejected with `400 Coupon invalide` instead of being silently dropped.
  - The normalized, upper-cased code is rejected with `400 Un seul coupon est autorisé par réservation` if it contains a `,`, so a comma-joined list of codes is refused outright rather than being parsed into multiple redemptions.
- The handler was simplified from a loop over `couponCodes` to a single `if (couponCode)` branch that looks up, validates, and applies at most one coupon — reusing the existing `applyCoupon` helper, the server-side price calculation (`trip.price_cents * travelers`), and the existing `BEGIN`/`COMMIT` transaction unchanged. No new coupon data model was needed: the fix is enforcing single-code input at the edge of the handler, not a schema change.
- The dead-code path that revealed the challenge flag when more than one coupon code was supplied (`hasMultipleCoupons` / the `itinerary_notes` flag concatenation) was removed along with the loop it depended on, since that condition can no longer be reached.
- `tests/api/a06-insecure-design.test.ts` was converted into a regression suite: a comma-separated pair of codes and a non-string `couponCode` (array) are now asserted to return `400` before the transaction even begins (`BEGIN` is never called), while a single valid code still applies its one discount correctly (`total_cents` reduced once, no flag in the response).

## Verification

![passing tests](passing-tests.png)
