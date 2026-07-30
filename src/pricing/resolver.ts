/**
 * Pricing Resolver
 * ────────────────
 * ALL pricing logic lives here. No pricing math in components.
 *
 * Supported pricing modes:
 *  - Normal (default): price from sheet
 *  - Dewdrop slab: 6+ units → ₹110, else ₹120
 *  - GPay surcharge: +2% on final total
 *  - Manual override: cashier overrides price, flag kept
 */

import type { BillItem, PaymentMode } from "../types";

// dewdrop slab pricing

const DEWDROP_ITEM = "dewdrop";
const DEWDROP_BULK_PRICE = 110;
const DEWDROP_RETAIL_PRICE = 120;
const DEWDROP_BULK_QTY = 6;


// re-applies dewdrop slab pricing across the entire bill

export function applyDewdropPricing(items: BillItem[]): BillItem[] {
  const dewdropRows: { item: BillItem; idx: number }[] = [];
  items.forEach((item, idx) => {
    if (item.item.toLowerCase() === DEWDROP_ITEM && !item.priceOverridden) {
      dewdropRows.push({ item, idx });
    }
  });

  if (dewdropRows.length === 0) return items.map(recalcItem);

  const totalQty = dewdropRows.reduce((sum, { item }) => sum + item.qty, 0);
  const bulkQty = Math.floor(totalQty / DEWDROP_BULK_QTY) * DEWDROP_BULK_QTY;

  let bulkRemaining = bulkQty;
  const dewdropIdxSet = new Set(dewdropRows.map(r => r.idx));
  const result: BillItem[] = [];

  items.forEach((item, idx) => {
    if (!dewdropIdxSet.has(idx)) {
      result.push(item);
      return;
    }

    const qty = item.qty;
    const bulkUnits = Math.min(bulkRemaining, qty);
    const retailUnits = qty - bulkUnits;
    bulkRemaining -= bulkUnits;

    const originalPrice = item.originalPrice ?? item.price;

    // row fits entirely in one slab -> stays a single row, just re-priced
    if (bulkUnits > 0) {
      result.push({ ...item, qty: bulkUnits, price: DEWDROP_BULK_PRICE, originalPrice });
    }
    if (retailUnits > 0) {
      result.push({ ...item, qty: retailUnits, price: DEWDROP_RETAIL_PRICE, originalPrice });
    }
  });

  return result.map(recalcItem);
}

// gpay

const GPAY_RATE = 0.02;

export function computeGPayCharge(subtotal: number, paymentMode: PaymentMode): number {
  if (paymentMode !== "GPay") return 0;
  return Math.round(subtotal * GPAY_RATE * 100) / 100;
}

// bill totals

export interface BillTotals {
  grandTotal: number; // sum of all item totals
  subtotalBeforeCharges: number; // base amount for payment surcharge
  subtotalWithCourier: number; // + courier charges
  gpayCharge: number; // 2% if GPay
  finalTotal: number; // the number that matters
  changeAmount: number;  // cash back to customer
}

export function computeBillTotals(
  items: BillItem[],
  courierCharges: number,
  paymentMode: PaymentMode,
  amountReceived: number
): BillTotals {
  const grandTotal = items.reduce((sum, i) => sum + i.total, 0);
  const subtotalBeforeCharges = grandTotal;
  const subtotalWithCourier = grandTotal + (courierCharges || 0);
  const gpayCharge = computeGPayCharge(subtotalBeforeCharges, paymentMode);
  const finalTotal = subtotalWithCourier + gpayCharge;
  const changeAmount = amountReceived > finalTotal ? amountReceived - finalTotal : 0;

  return { grandTotal, subtotalBeforeCharges, subtotalWithCourier, gpayCharge, finalTotal, changeAmount };
}

// row recalc, recomputes total and profit for a single item, always call this after mutating qty or price

export function recalcItem(item: BillItem): BillItem {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  const cost = Number(item.cost) || 0;
  const total = qty * price;
  const profit = total - cost * qty;
  return { ...item, total, profit };
}


export function applyAllPricingRules(items: BillItem[]): BillItem[] {
  return applyDewdropPricing(items);
}

// points calc
export function computePointsValue(points: number, redeemRate: number): number {
  return Math.floor(points * redeemRate);
}
