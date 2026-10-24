/**
 * Pricing Resolver
 * ────────────────
 * ALL pricing logic lives here. No pricing math in components.
 *
 * Supported pricing modes:
 *  - Normal (default): price from sheet
 *  - Registry packet slab: packet size and prices come from Registry
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
  const groups = new Map<string, BillItem[]>();

  for (const item of items) {
    if (item.priceOverridden) {
      result.push(recalcItem(item));
      continue;
    }
    const key = `${item.item.trim().toLowerCase()}|${item.shade.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  for (const group of groups.values()) {
    const source = group[0];
    const totalQty = group.reduce((sum, item) => sum + Math.max(0, Number(item.qty) || 0), 0);
    const packetSize = Number(source.packetSize) || 0;
    const packetQty = packetSize > 0 ? Math.floor(totalQty / packetSize) * packetSize : 0;
    const individualQty = totalQty - packetQty;
    const individualPrice = priceForMode(source, paymentMode, false);
    const packetPrice = priceForMode(source, paymentMode, true);

    if (packetQty > 0) {
      result.push(recalcItem({
        ...source,
        id: source.id ? `${source.id}-packet` : undefined,
        qty: packetQty,
        price: packetPrice,
      }));
    }
    if (individualQty > 0) {
      result.push(recalcItem({
        ...source,
        qty: individualQty,
        price: individualPrice,
      }));
    }
  }

  return result;
}

// bill totals

export interface BillTotals {
  grandTotal: number; // sum of all item totals
  subtotalBeforeCharges: number; // item total before courier charges
  subtotalWithCourier: number; // + courier charges
  finalTotal: number; // the number that matters
  changeAmount: number;  // cash back to customer
}

export function computeBillTotals(
  items: BillItem[],
  courierCharges: number,
  amountReceived: number
): BillTotals {
  const grandTotal = items.reduce((sum, i) => sum + i.total, 0);
  const subtotalBeforeCharges = grandTotal;
  const subtotalWithCourier = grandTotal + (courierCharges || 0);
  const finalTotal = subtotalWithCourier;
  const changeAmount = amountReceived > finalTotal ? amountReceived - finalTotal : 0;

  return { grandTotal, subtotalBeforeCharges, subtotalWithCourier, finalTotal, changeAmount };
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


export function applyAllPricingRules(items: BillItem[], paymentMode: PaymentMode = "Cash"): BillItem[] {
  return applyBulkPricing(items, paymentMode);
}

// points calc
export function computePointsEarned(finalTotal: number, earnRate: number): number {
  return Math.floor((finalTotal / 100) * earnRate);
}

export function computePointsValue(points: number, redeemRate: number): number {
  return Math.floor(points * redeemRate);
}
