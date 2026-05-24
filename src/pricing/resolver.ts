/**
 * Pricing Resolver
 * ────────────────
 * ALL pricing logic lives here. No pricing math in components.
 *
 * Supported pricing modes:
 *  - Normal (default): price from sheet
 *  - Triosoft slab: 6+ units → ₹110, else ₹120
 *  - GPay surcharge: +2% on final total
 *  - Manual override: cashier overrides price, flag kept
 */

import type { BillItem, PaymentMode } from "../types";

// triosoft slab pricing

const TRIOSOFT_ITEM = "triosoft";
const TRIOSOFT_BULK_PRICE = 110;
const TRIOSOFT_RETAIL_PRICE = 120;
const TRIOSOFT_BULK_QTY = 6;

/**
 * Re-applies Triosoft slab pricing across the entire bill.
 * Must be called after any qty or item change.
 * Only affects non-overridden Triosoft rows.
 */
export function applyTriosoftPricing(items: BillItem[]): BillItem[] {
  const triosoftIdxs = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.item.toLowerCase() === TRIOSOFT_ITEM && !item.priceOverridden);

  if (triosoftIdxs.length === 0) return items.map(recalcItem);

  const totalQty = triosoftIdxs.reduce((sum, { item }) => sum + item.qty, 0);
  const bulkSlots = Math.floor(totalQty / TRIOSOFT_BULK_QTY) * TRIOSOFT_BULK_QTY;

  let slotsRemaining = bulkSlots;
  const updated = [...items];

  for (const { item: trioItem, idx } of triosoftIdxs) {
    const price = slotsRemaining >= trioItem.qty ? TRIOSOFT_BULK_PRICE : TRIOSOFT_RETAIL_PRICE;
    updated[idx] = {
      ...trioItem,
      price,
      originalPrice: trioItem.originalPrice ?? trioItem.price,
    };
    slotsRemaining -= trioItem.qty;
  }

  return updated.map(recalcItem);
}

// gpay

const GPAY_RATE = 0.02;

export function computeGPayCharge(subtotal: number, paymentMode: PaymentMode): number {
  if (paymentMode !== "GPay") return 0;
  return Math.round(subtotal * GPAY_RATE * 100) / 100;
}

// bill totals

export interface BillTotals {
  grandTotal: number;         // sum of all item totals
  subtotalWithCourier: number; // + courier charges
  gpayCharge: number;         // 2% if GPay
  finalTotal: number;         // the number that matters
  changeAmount: number;       // cash back to customer
}

export function computeBillTotals(
  items: BillItem[],
  courierCharges: number,
  paymentMode: PaymentMode,
  amountReceived: number
): BillTotals {
  const grandTotal = items.reduce((sum, i) => sum + i.total, 0);
  const subtotalWithCourier = grandTotal + (courierCharges || 0);
  const gpayCharge = computeGPayCharge(subtotalWithCourier, paymentMode);
  const finalTotal = subtotalWithCourier + gpayCharge;
  const changeAmount = amountReceived > finalTotal ? amountReceived - finalTotal : 0;

  return { grandTotal, subtotalWithCourier, gpayCharge, finalTotal, changeAmount };
}

// row recalc

/**
recomputes total and profit for a single BillItem.
always call this after mutating qty or price.
 */
export function recalcItem(item: BillItem): BillItem {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  const cost = Number(item.cost) || 0;
  const total = qty * price;
  const profit = total - cost * qty;
  return { ...item, total, profit };
}

/**
top-level function to apply all pricing rules to a bill.
call this instead of setItems directly.
 */
export function applyAllPricingRules(items: BillItem[]): BillItem[] {
  return applyTriosoftPricing(items);
}

// points calc

export function computePointsEarned(finalTotal: number, earnRate: number): number {
  return Math.floor((finalTotal / 100) * earnRate);
}

export function computePointsValue(points: number, redeemRate: number): number {
  return Math.floor(points * redeemRate);
}
