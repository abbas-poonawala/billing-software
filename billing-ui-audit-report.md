# Production Audit — Threads & More Billing System (`billing-ui`)

Cross-file audit of the React/Vite frontend + Vercel serverless backend + Google Sheets "database." Findings are grounded in the actual code, organized by severity, with repro steps and fixes.

---

## 1. Executive Summary

This is a small-retail billing tool built on Google Sheets, with **zero authentication**, **no server-side re-validation of client-submitted totals**, **non-atomic multi-step writes with partial-failure rollbacks that are themselves not robust**, and **at least one destructive bug that can permanently delete a real bill's data**. Several "finished" features (loyalty-point redemption, points config) are actually **dead/disconnected code** due to a missing API case and two files disagreeing on the `PointsConfig` sheet schema.

The architecture (Sheets-as-DB via row scans, no locking, no idempotency keys, secrets parsed at module scope, business logic split across 4 near-duplicate normalization functions) is fundamentally unsuited to concurrent, unattended production billing without significant hardening.

**Bottom line:** functionally usable for a single trusted cashier on a slow day, but not safe for unattended/public exposure, multiple simultaneous terminals, or any adversarial user.

---

## 2. Critical Issues (fix before any production use)

### C1. No authentication/authorization on any API route
- **Files:** `api/bill.ts`, `api/core.ts`, `api/lookupBarcode.ts`, `api/restock.ts`
- **Problem:** Every handler starts executing business logic immediately on any HTTP request. There is no API key, session, or IP allow-list check anywhere.
- **Why it happens:** The endpoints were written as simple Vercel functions with no auth middleware.
- **Impact:** Anyone with the deployed URL can create fake bills, delete real bills (`?action=edit`), silently zero out inventory, or read/exfiltrate the entire customer database (names, phones, spend, points).
- **Repro:** `curl -X POST https://<deployment>/api/bill -d '{"items":[...],"finalTotal":1,"customer":{"phone":"9999999999"}}'`
- **Fix:** Require a shared secret / signed session header validated server-side (e.g., Vercel Edge Middleware + a login gate), and scope Google service-account credentials narrowly per environment.

### C2. Client fully controls `finalTotal` and per-item `price` — server never recomputes them
- **Files:** `src/App.tsx` (`saveBill`), `api/bill.ts` (`POST` handler: `const { items, finalTotal = 0, ... } = req.body;`)
- **Problem:** `finalTotal` (and every item's `price`) is taken verbatim from the request body. The backend never recalculates totals from `items × price` (+ tax/courier/GPay rules) and compares against the submitted figure.
- **Why:** Trust boundary was never drawn between UI convenience calculation (`computeBillTotals`) and the persisted record — the same numbers are just forwarded.
- **Impact:** Anyone who can call the API (see C1) — or a corrupted/manipulated client state — can save a bill for ₹1 while items/stock reflect a ₹50,000 sale, or set arbitrary negative prices to generate refund-like behavior with no reconciliation. This is a direct, exploitable revenue-loss vector.
- **Repro:** Submit a normal cart with `finalTotal: 1` — the sheet stores `1` as the bill's `FINAL_TOTAL`, no validation error.
- **Fix:** Recompute `subtotal`, `courierCharges`, `gpayCharge`, and `finalTotal` server-side from trusted price lookups (`getPrice`) and item quantities; reject if the client's total deviates beyond a rounding tolerance.

### C3. `getPrice` / `getShades` endpoints don't restrict `item` to real inventory tabs — arbitrary sheet read (IDOR)
- **Files:** `api/core.ts` (`handleGetPrice`, `handleGetShades`)
- **Problem:** Unlike `lookupBarcode.ts`/`restock.ts`, these two handlers take `item` straight from the query string and read `` `'${item}'!B2:D` `` from the spreadsheet with **no whitelist check** against `skipTabs`/Registry.
- **Impact:** `GET /api/core?action=getPrice&item=Customers&shade=x` (or `item=Profit`, `item=Bill`) reads rows from sensitive tabs (customer PII, cost/profit data, prior bills) and returns them framed as "price/stock," effectively an unauthenticated data-exfiltration primitive.
- **Fix:** Validate `item` against the `Registry` item list (same list `getItems` returns) before building any range string.

### C4. Editing a bill can permanently delete it if the new item list fails a stock check
- **File:** `api/bill.ts`, `POST ?action=edit` handler
- **Problem:** Execution order is: (1) reverse old bill's stock/customer stats, (2) `deleteBillRows(gsapi, originalBillNo)` — **actually deletes the Bills/BillItems rows** — (3) *then* compute new stock availability and `return res.status(400)` if insufficient stock for the new item list.
- **Why:** The insufficient-stock guard was written as if it runs before any mutation, but the delete happens earlier in the function.
- **Impact:** A cashier editing a bill (e.g., to fix a typo) where stock has since dropped below what the edited cart needs will have the **original, already-paid bill permanently deleted** from `Bills`/`BillItems`, its customer stats already decremented, and receive only a 400 error — with no new bill created. Real financial record loss with no recovery path.
- **Repro:** Retrieve any existing bill for edit → increase an item's quantity beyond currently-available stock → save. The original bill vanishes.
- **Fix:** Do not delete/mutate anything until *all* validations (stock, customer, pricing) pass. Build the new state first, validate it fully, then atomically swap (or delete only after the new rows are successfully appended).

### C5. Bill numbers are generated via read-then-write with no locking — duplicate bill numbers under concurrency
- **File:** `api/bill.ts` (`getNextBillNo`)
- **Problem:** `getNextBillNo` reads all of `Bills!A:A`, computes `max+1`, and the caller appends later. Two concurrent `POST /api/bill` requests (two tills, or a client retry) can both read the same max and both append with the **same** bill number.
- **Impact:** `BillItems` rows for two unrelated transactions merge under one `billNo`. `getBillByNumber`, printing, retrieval, and editing all become corrupted for both bills — wrong items/totals shown/printed, and editing one bill can affect the other's rows (see C4's delete-by-billNo logic, which deletes **all** rows matching that billNo, i.e. both transactions).
- **Fix:** Use an atomic counter (e.g., a dedicated locking mechanism, a database with `SEQUENCE`/`INCREMENT`, or Sheets’ `USER_ENTERED` append with a server-side mutex/queue) instead of scan-then-compute-max.

### C6. Stock-deduction "rollback on failure" is not durable and errors are unhandled if the rollback itself fails
- **File:** `api/bill.ts` (both `POST` new-bill and `?action=edit` paths, the `try { ...deduct... } catch (err) { ...revert... }` blocks)
- **Problem:** On a deduction failure, the code issues compensating writes to restore original stock. Those compensating writes are themselves un-retried Sheets API calls with no try/catch; if a rollback write also fails (rate limit, transient network error), it throws inside the `catch` block, producing an unhandled rejection and a generic 500 — leaving stock in a silently corrupted, indeterminate state that no log captures precisely.
- **Impact:** Inventory counts drift from reality over time with no audit trail of when/why, undetectable until a physical stock-take.
- **Fix:** Wrap rollback operations in their own try/catch with structured logging (ideally to a dedicated "reconciliation needed" sheet/alert), and consider a true transactional data store instead of Sheets for anything touching money/stock.

### C7. Loyalty point redemption is completely non-functional / disconnected end-to-end
- **Files:** `src/components/CustomerSection.tsx`, `src/store/billingStore.ts` (`useBillTotals`), `src/App.tsx` (`saveBill` payload), `api/bill.ts` (`upsertCustomer`)
- **Problem:**
  1. `CustomerSection` shows "Redeem X pts (₹Y off)" and toggles `redeemPoints`, but `useBillTotals`/`computeBillTotals` never subtracts the redeemed value from `finalTotal`.
  2. The `saveBill` payload sent to the backend **never includes `redeemPoints`** at all.
  3. `upsertCustomer` only ever *adds* `calculatePointsEarned(...)`; there is no code path anywhere that subtracts redeemed points from a customer's balance.
- **Impact:** The UI implies a discount is being applied and that points are being spent; neither happens. Customers are charged full price while cashiers believe a discount was given (till/cash mismatches, customer disputes), and a customer's points balance can never actually decrease — an unbounded, ever-growing loyalty liability.
- **Fix:** Compute `pointsDiscount = computePointsValue(customer.points, pointsConfig.redeemRate)` inside `computeBillTotals` when `redeemPoints` is true, subtract from `finalTotal`, send `redeemPoints`/`pointsRedeemed` in the save payload, and deduct that amount from the customer's stored points server-side (atomically with the earn calculation).

### C8. `PointsConfig` sheet schema is defined two different, incompatible ways in two files, and the frontend's config endpoint is never wired up
- **Files:** `api/core.ts` (`getPointsConfig` — reads `PointsConfig!A:B` as a `{EarnRate, RedeemRate, MinRedeem, SpendBonus, BillBonus}` key/value map) vs. `api/bill.ts` (`getPointsConfig` — reads `PointsConfig!A2:C` as rows of `type,value1,value2` with types `earn_rate`/`spend_bonus`/`bill_bonus`)
- **Problem:** These are two unrelated schemas for a sheet with the same name. Only one can be "correct" for whatever is actually in the spreadsheet; the other silently falls back to hardcoded defaults (`0.005`/`0.5`/`50` or `0.01`) rather than erroring.
- **Compounding bug:** `api/core.ts`'s `handler` switch statement has **no `case "getPointsConfig"`**, so `src/services/api.ts`'s `fetchPointsConfig()` always hits the `default: 400` branch, and its own `try { } catch { return null }` wrapper (which doesn't even trigger, since the response resolves fine as JSON, it just returns `null` because `data.config` is undefined) means `store.pointsConfig` is **always `null`** in the running app. This is *why* C7's redemption UI never even renders its checkbox in practice — `pointsConfig && customer.points >= pointsConfig.minRedeem` is always false.
- **Fix:** Pick one canonical `PointsConfig` schema, delete the duplicate, add the missing `case` in `api/core.ts`, and add a test asserting the endpoint returns a non-null config.

### C9. `GET /api/bill?action=getBill&billNo=N` is an unauthenticated IDOR exposing all customers' PII
- **File:** `api/bill.ts`
- **Problem:** Bill numbers are sequential small integers with no ownership check. Combined with C1 (no auth), any caller can iterate `billNo=1,2,3,...` and dump every historical customer's name, phone number, and full itemized purchase history.
- **Fix:** Require auth (C1) at minimum; consider non-sequential bill identifiers for anything externally reachable.

---

## 3. High-Priority Issues

### H1. `normalizePhone` (frontend `src/utils/phone.ts`) does not actually add the `+91` prefix for valid 10-digit numbers
- **Problem:** `if (dig.length < 10) return '+91'+dig; return trimmed;` — this is backwards: it only prefixes **invalid** (too-short) numbers and returns **valid** 10-digit numbers completely unmodified (no `+91`).
- **Impact:** `phoneForWhatsApp()` (used by "Send Bill via WhatsApp"/"Save & Send") builds `wa.me/<number>` links **without the country code** for the overwhelmingly common case of a cashier typing a plain 10-digit mobile number — the WhatsApp deep link will not resolve to the correct chat.
- **Fix:** Always normalize to `+91` + last 10 digits, matching the (correct) backend `normalisePhone` in `api/bill.ts`.

### H2. Same bug is duplicated in `api/core.ts`'s local `normalizePhone`, breaking phone-based customer search
- **Problem:** `api/core.ts` defines its own `normalizePhone` with the identical bug (H1). Stored customer phones are written via `api/bill.ts`'s **correct** `normalisePhone` (always `+91XXXXXXXXXX`). When a cashier searches by typing a plain 10-digit number, `handleSearchCustomersByPhone`/`handleGetCustomer` normalize the query to the **unprefixed** digits, which will never equal the stored `+91...` value.
- **Impact:** Returning-customer lookup by phone silently fails for the standard input pattern, causing duplicate customer records to be created and loyalty history to fragment/be lost.
- **Repro:** Create a customer via a completed sale (phone stored as `+919876543210`). Start a new bill and type `9876543210` into the phone field — no match is found.
- **Fix:** Use one shared, correct phone-normalization utility across frontend and all backend files (there are currently **three** divergent implementations).

### H3. No server-side input validation on `qty`/`price` in `api/bill.ts`
- **Problem:** Nothing rejects negative or zero `qty`, non-numeric values, or absurd prices at the API layer; only the client's `EditableCell`/entry-form validation guards this, which is bypassable per C1/C2.
- **Impact:** A negative `qty` reduces the computed total and effectively *increases* store stock (deduction of a negative number), and a `NaN` price can propagate into `Profit`/`Bills` numeric columns as `NaN`/`null`, corrupting downstream Sheets formulas.
- **Fix:** Validate `Number.isFinite(qty) && qty > 0`, `Number.isFinite(price) && price >= 0` for every item server-side before any writes.

### H4. Fuzzy/Levenshtein shade matching can silently bill the wrong variant
- **File:** `api/core.ts` (`findBestShadeMatch`)
- **Problem:** After exact/`startsWith` checks fail, it falls back to Levenshtein distance with up to ~30% character tolerance, picking the closest sheet row even if it's a different, unintended shade.
- **Impact:** A typo or partial shade name can silently resolve to a *different* real shade's price and decrement *that* shade's stock instead of the intended one — wrong item sold at wrong price, wrong inventory affected, with no warning surfaced to the cashier beyond an opaque `method: "fuzzy"` field that isn't shown in the UI.
- **Fix:** Surface the matched shade name back to the UI for cashier confirmation before committing to it, or disable fuzzy fallback for `getPrice` (require exact selection from the shade dropdown, which is already fetched).

### H5. Concurrent phone/ID customer lookups have no request sequencing (unlike name search)
- **Files:** `src/components/CustomerSection.tsx` (`handlePhoneChange`, `handleIdChange`)
- **Problem:** `handleNameChange` correctly uses an `AbortController` + monotonic sequence number to discard stale responses. `handlePhoneChange` fires on every keystroke past 10 digits with **no debounce or cancellation**, and `handleIdChange`'s single `setTimeout` ref can still let an older in-flight request's `.then()` resolve after a newer one and silently overwrite the just-selected customer.
- **Impact:** Cashier selects/confirms customer A, a stale lookup for a previously-typed prefix resolves late and silently swaps in customer B — wrong customer attached to the bill (wrong loyalty points, wrong contact for WhatsApp send).
- **Fix:** Apply the same abort/sequence pattern used for name search to phone and ID lookups; add a debounce to the phone handler.

### H6. Unrounded floating-point totals/profit are written directly into the "ledger" sheets
- **Files:** `src/pricing/resolver.ts` (`recalcItem`, `computeBillTotals`), `api/bill.ts` (`calculateItemProfit`, `createBillItemRow`, `createBillSummaryRow`)
- **Problem:** `total = qty * price` and `profit = total - cost*qty` are never rounded to 2 decimal places before being stored. Standard IEEE-754 float multiplication (e.g., `33.33 * 3`) can produce values like `99.99000000000001`.
- **Impact:** The permanent business ledger (`Bills`, `BillItems`, and any owner-built Sheets formulas/reports on top of it) accumulates visibly malformed numbers and can break `SUM`/reconciliation formulas over time. `GPay` charge is correctly rounded (`Math.round(x*100)/100`) — the rest of the pipeline is not.
- **Fix:** Round every currency value to 2 decimals (ideally do integer-cents math per the project's own `.github/copilot-instructions.md` guidance, which explicitly calls for cent-based math and is not followed anywhere in the actual code) immediately before storage and before any comparison.

### H7. Sequential (non-batched) Sheets API calls make barcode scan and full-store restock slow and quota-hungry
- **Files:** `api/lookupBarcode.ts` (loops every non-skip tab with a `values.get` per tab per scan), `api/restock.ts` `handleStoreRestock` (multiple sequential `values.get` calls per tab: header check, data-shape check, stock read)
- **Impact:** As inventory grows (more item tabs), a single barcode scan or a full "restock all" action makes O(tabs) sequential network round-trips, risking Vercel function timeouts and burning through Google Sheets API read quota, directly slowing down checkout at the register.
- **Fix:** Use `spreadsheets.values.batchGet` with all tab ranges in one call (already done elsewhere in the codebase, e.g. `batchGetStoreStock` in `api/bill.ts`), and maintain a barcode→(item, shade) index instead of scanning every tab per scan.

### H8. Divergent `skipTabs` lists between `api/lookupBarcode.ts` and `api/restock.ts`
- **Problem:** `lookupBarcode.ts`'s local `skipTabs` array is missing `"dashboard"`, `"alternate shades"`, `"settings"` that `restock.ts`'s otherwise-identical list includes.
- **Impact:** A barcode scan can match against rows in non-inventory tabs (e.g., `Settings`, `Dashboard`), returning garbage item/shade/price data and letting a cashier add a nonsensical line item at an arbitrary price.
- **Fix:** Extract one shared `SKIP_TABS` constant into a common module and import it everywhere instead of maintaining parallel copies.

### H9. Optimistic-concurrency-free bill editing ("last write wins") on top of the destructive delete-then-recreate pattern (C4)
- **Problem:** No version/`lastUpdated` check is compared before an edit overwrites a bill. Two staff retrieving and editing the same bill concurrently will race; combined with C4's delete-before-validate ordering, this is a compounding risk, not just a lost-update.
- **Fix:** Add an optimistic-concurrency token (`lastUpdated` timestamp) to the edit payload and reject the edit if it no longer matches the current stored value.

---

## 4. Medium-Priority Issues

| # | Issue | File(s) | Impact |
|---|---|---|---|
| M1 | `entryQty` accepts `NaN` (empty/garbage input isn't rejected because `NaN <= 0` is `false`), silently coerced to `qty: 0` via `recalcItem`'s `Number(item.qty)\|\|0`, producing a free (₹0-total) line item added to the bill with no visible error. | `src/App.tsx` (`addItem`), `src/pricing/resolver.ts` (`recalcItem`) | Items can be silently given away for free. |
| M2 | `updateItemQty` resets `priceOverridden: false` on every quantity change, silently discarding a cashier's manual price override and re-enabling Dewdrop bulk-pricing recompute without notice. | `src/store/billingStore.ts` | Cashier believes an override still applies; wrong price charged. |
| M3 | `updateItemPrice` mutates the item directly without calling `applyAllPricingRules`, so overriding one Dewdrop-item's price doesn't rebalance the bulk-slot allocation across the other Dewdrop rows in the same bill until an unrelated qty change triggers a full recompute. | `src/store/billingStore.ts` | Inconsistent/incorrect Dewdrop slab pricing across a bill. |
| M4 | Dewdrop bulk pricing assigns the bulk price greedily per line-item in insertion order rather than splitting a partially-bulk-eligible row, so identical total quantities entered as different row splits produce different total prices. | `src/pricing/resolver.ts` (`applyDewdropPricing`) | Order-dependent, exploitable/inconsistent discounting. |
| M5 | In-session `priceCache`/`shadeCache` (`useItemSearch.ts`) never expire (no TTL), unlike the backend's 5-minute cache — a price change on the sheet mid-shift is never picked up by an already-open till until a manual "Refresh Item List." | `src/hooks/useItemSearch.ts` | Stale pricing charged for the rest of a session. |
| M6 | Backend in-memory `priceCache`/`shadesCache` (module-level `Map`) is unreliable across Vercel's multiple/cold-started serverless instances — provides no consistent guarantee and can also serve stale prices for up to 5 minutes on a warm instance after a legitimate price update. | `api/core.ts` | False sense of caching correctness; stale prices possible. |
| M7 | `getNextBillNo`/refresh-on-focus display logic relies on client-local clock/date formatting (`getISTNow`) for the on-screen bill date/time shown before saving, while the actually-persisted date/time is generated independently by the server at save time (`getISTDateTime` in `api/bill.ts`) — can drift near midnight or if a client's clock is wrong. | `src/App.tsx`, `api/bill.ts` | Printed/WhatsApp receipt date can mismatch the persisted ledger date. |
| M8 | `amountReceived`/`courierCharges` text inputs are parsed with raw `Number(str)`; a comma-formatted amount (`"12,000"`, common in Indian numeral entry) becomes `NaN`, silently zeroing the displayed change-due or rejecting a valid courier order. | `src/App.tsx`, `src/store/billingStore.ts` (`useBillTotals`) | Wrong/blocked cash-change display; confusing rejects. |
| M9 | `parseDate` in `restock.ts` hard-assumes a `DD/MM/YYYY` string shape from `toLocaleDateString("en-IN")`; any locale/formatting drift silently breaks the "already requested this week" de-duplication. | `api/restock.ts` | Duplicate WhatsApp restock requests, or missed ones. |
| M10 | `localStorage` draft-bill autosave (`useBillDraft.ts`) stores customer PII (name/phone) in plaintext on a typically shared till PC, with no encryption or expiry, and drafts are recovered without re-checking current stock availability. | `src/hooks/useBillDraft.ts` | PII exposure on shared hardware; stale-stock draft recovery. |
| M11 | No cash-tendered/change-given amount is ever sent to or stored by the backend — only displayed client-side. | `src/App.tsx` | No audit trail for cash reconciliation. |
| M12 | `handleGetCost`/customer search endpoints read entire sheets on every call with no pagination beyond a client-side `.slice(0, 20)`, scaling linearly with customer/item count. | `api/core.ts` | Increasing latency and Sheets API quota usage as the business grows. |
| M13 | Points-earned reversal on bill edit recomputes `calculatePointsEarned` using the **current** `PointsConfig`, not the config in effect when the original bill was created — if rates changed in between, the reversal doesn't match what was actually awarded, drifting the customer's point balance. | `api/bill.ts` (`?action=edit`) | Loyalty balance corruption over time. |
| M14 | No idempotency key on bill save; a network timeout/retry after a successful append will create a second, duplicate bill (compounded by C5's race in bill numbering). | `api/bill.ts`, `src/services/api.ts` | Duplicate revenue records / duplicate stock deduction. |

---

## 5. Low-Priority / Maintainability Issues

- **Dead/unused dependencies:** `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover`, `tailwind-merge`, `recharts`, `react-router-dom`, `express`, `cors`, `body-parser` all appear in `package.json` but are not imported anywhere in the provided source — inflates install/build size and signals architectural confusion (Express deps alongside Vercel serverless functions).
- **Tailwind is fully configured (`tailwind.config.js`, `postcss.config.js`, `@tailwindcss/postcss`) but never actually wired up** — `src/index.css` is empty and is never imported by `src/main.tsx` or `src/App.tsx`. The entire app is styled with inline `style={}` objects; the Tailwind toolchain is dead weight.
- **Google service-account credentials are `JSON.parse`'d at module scope in four separate files** (`api/core.ts`, `api/bill.ts`, `api/lookupBarcode.ts`, `api/restock.ts`) instead of a single shared client — duplicated init code, and a malformed/missing env var crashes the function at cold start with an unhandled exception rather than a clean 500.
- **`RESTOCK_PHONE` hardcoded** in `api/restock.ts` instead of an environment variable.
- **README claims a generic "Discounts"/slab-based discount config system** exists (`Discounts` sheet, "Slab based discount config" feature) — no such generic discount logic exists in code; only the hardcoded Dewdrop-specific slab exists in `resolver.ts`. Documentation/feature mismatch.
- **`computePointsEarned` (resolver.ts) and `handleGetCustomer`/`fetchCustomer` appear unused** — dead exports.
- Multiple independent re-implementations of phone normalization (`src/utils/phone.ts`, `api/core.ts`, `api/bill.ts`) and of `skipTabs` (`api/lookupBarcode.ts`, `api/restock.ts`) — see H2/H8; consolidate into shared modules to prevent future drift.

---

## 6. Testing Gaps & Recommended Test Cases

There are **no test files anywhere in the repository.** Given the money-handling surface area, at minimum add:

**Pricing/resolver unit tests**
- `computeBillTotals`: zero items, GPay vs Cash, courier charges included/excluded for walk-in vs courier.
- `applyDewdropPricing`: total qty exactly on a multiple of 6, split across 2/3 rows in different orders, one row manually overridden.
- `recalcItem`/rounding: verify 2-decimal-place output for inputs known to trigger float drift (e.g. `qty=3, price=33.33`).
- `computePointsEarned`/`computePointsValue` against documented tier thresholds.

**API integration tests (mocking the Sheets client)**
- Save a bill with a `finalTotal` that doesn't match `sum(items)` — assert rejection (once C2 is fixed).
- Save with negative/zero `qty` or `price` — assert rejection (once H3 is fixed).
- Two concurrent `POST /api/bill` calls — assert distinct bill numbers (once C5 is fixed).
- Edit a bill where new item list exceeds available stock — assert the **original bill still exists** afterward (regression test for C4).
- `getPrice`/`getShades` called with `item=Customers` or any non-Registry tab name — assert 4xx, not sheet data (regression test for C3).
- `fetchPointsConfig()` — assert it returns a non-null config object (regression test for C8).
- Redeem-points flow — assert `finalTotal` is reduced and the customer's points balance decreases by the redeemed amount (regression test for C7).

**Phone normalization tests**
- `normalizePhone("9876543210")` → `"+919876543210"` (regression for H1).
- Round-trip: value written by `upsertCustomer` must be found by `searchCustomersByPhone` given a plain 10-digit query (regression for H2).

**Concurrency / load tests**
- Simulate 2 simultaneous scans of the same barely-in-stock item — assert stock never goes negative and only one sale succeeds.
- Simulate rapid customer-phone-field typing — assert the UI ends up showing the customer matching the *last* keystroke, not a stale earlier lookup (regression for H5).

---

## 7. Production Readiness Score: **2.5 / 10**

Justification: the UI/UX and day-to-day happy-path (single till, trusted cashier, no concurrency, no adversarial input) is reasonably polished and thoughtfully built (autosave drafts, keyboard shortcuts, fuzzy search, print/WhatsApp flows). But the system has **no authentication**, **trusts client-submitted financial totals**, has a **confirmed data-destruction bug in the edit flow**, a **race condition that can merge two unrelated bills under one bill number**, and a **flagship loyalty feature that silently does nothing**. None of these are hypothetical edge cases — they are reachable through normal UI usage or a single `curl` command.

## 8. Estimated Risk of Financial Loss if Deployed As-Is: **High**

- **Direct fraud/loss vector:** C2 (client-controlled `finalTotal`) is trivially exploitable by anyone who can reach the API and requires no special skill beyond a browser devtools network tab or a REST client — this alone justifies a "High" rating regardless of other issues.
- **Operational data-loss risk:** C4 can destroy real transaction records during ordinary bill-editing, corrupting accounting/reconciliation.
- **Compounding integrity risk:** C5/C6 make inventory and bill numbering unreliable under any concurrent usage (more than one till, or even one till plus a retried request), which is a realistic operating condition, not a rare edge case.
- **Reputational/PII risk:** C1/C3/C9 expose full customer PII and business cost data to anyone with the URL.

---

## 9. Prioritized Remediation Order

1. C1 (auth) — blocks everything else from being exploitable remotely.
2. C2 (server-side total recomputation) — closes the direct fraud vector.
3. C4 (fix delete-before-validate ordering in bill edit) — stop active data loss.
4. C3 (whitelist `item` param in `getPrice`/`getShades`) — stop PII/data leakage.
5. C5/C6 (atomic bill numbering + durable rollback/reconciliation logging).
6. C7/C8 (fix or explicitly remove the loyalty redemption feature — don't ship a discount UI that doesn't discount).
7. H1–H9, then the Medium list, in the order given.
