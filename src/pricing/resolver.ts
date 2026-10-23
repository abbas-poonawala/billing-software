/**
 * Pricing Resolver
 * ────────────────
 * ALL pricing logic lives here. No pricing math in components.
 *
 * Supported pricing modes:
 *  - Normal (default): price from sheet
 *  - Registry packet slab: packet size and prices come from Registry
 *  - Cash discount: 2% off the item total plus courier charges
 *  - Manual override: cashier overrides price, flag kept
 */

import type { BillItem, PaymentMode } from "../types";

function priceForMode(item: BillItem, paymentMode: PaymentMode, packet: boolean): number {
  const configuredPrice = packet
    ? paymentMode === "Cash" ? item.packetCashPrice : item.packetGPayPrice
    : paymentMode === "Cash" ? item.individualCashPrice : item.individualGPayPrice;
  return configuredPrice && configuredPrice > 0 ? configuredPrice : item.price;
}

export function applyBulkPricing(items: BillItem[], paymentMode: PaymentMode): BillItem[] {
      const result: BillItem[] = [];
      const groups = new Map<string, number[]>();

      items.forEach((item, index) => {
        if (item.priceOverridden) return;
        const key = `${item.item.trim().toLowerCase()}|${item.shade.trim().toLowerCase()}`;
        groups.set(key, [...(groups.get(key) || []), index]);
      });

      const processedGroups = new Set<string>();
      items.forEach(originalItem => {
        const key = `${originalItem.item.trim().toLowerCase()}|${originalItem.shade.trim().toLowerCase()}`;
        const indexes = groups.get(key);
        if (indexes && processedGroups.has(key)) return;
        if (!indexes || originalItem.priceOverridden) {
          result.push(originalItem);
          return;
        }
        processedGroups.add(key);

        const packetSize = originalItem.packetSize || 0;
        if (packetSize <= 0) {
          for (const itemIndex of indexes) {
            const item = items[itemIndex];
            result.push(recalcItem({ ...item, price: priceForMode(item, paymentMode, false) }));
          }
          return;
        }
        const totalQty = packetSize > 0
          ? indexes.reduce((sum, itemIndex) => sum + Math.max(0, items[itemIndex].qty), 0)
          : 0;
        let packetRemaining = Math.floor(totalQty / packetSize) * packetSize;

        for (const itemIndex of indexes) {
          const item = items[itemIndex];
          const packetQty = Math.min(packetRemaining, item.qty);
          packetRemaining -= packetQty;
          const individualQty = item.qty - packetQty;
          const packetPrice = priceForMode(item, paymentMode, true);
          const individualPrice = priceForMode(item, paymentMode, false);
          if (packetQty > 0) {
            result.push(recalcItem({ ...item, id: item.id ? `${item.id}-packet` : undefined, qty: packetQty, price: packetPrice }));
          }
          if (individualQty > 0) {
            result.push(recalcItem({ ...item, qty: individualQty, price: individualPrice }));
          }
        }
      });

  return result;
}

// cash discount

const GPAY_RATE = 0.02;

export function computeCashDiscount(subtotal: number, paymentMode: PaymentMode): number {
  if (paymentMode !== "Cash") return 0;
  return Math.round(subtotal * GPAY_RATE * 100) / 100;
}

// bill totals

export interface BillTotals {
  grandTotal: number; // sum of all item totals
  subtotalBeforeCharges: number; // item total before courier charges
  subtotalWithCourier: number; // + courier charges
  cashDiscount: number; // 2% for Cash
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
  const cashDiscount = computeCashDiscount(subtotalWithCourier, paymentMode);
  const finalTotal = subtotalWithCourier - cashDiscount;
  const changeAmount = amountReceived > finalTotal ? amountReceived - finalTotal : 0;

  return { grandTotal, subtotalBeforeCharges, subtotalWithCourier, cashDiscount, finalTotal, changeAmount };
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


export function applyAllPricingRules(items: BillItem[], paymentMode: PaymentMode = "GPay"): BillItem[] {
  return applyBulkPricing(items, paymentMode);
}

// points calc
export function computePointsEarned(finalTotal: number, earnRate: number): number {
  return Math.floor((finalTotal / 100) * earnRate);
}

export function computePointsValue(points: number, redeemRate: number): number {
  return Math.floor(points * redeemRate);
}
