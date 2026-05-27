/**
 * Billing Store (Zustand)
 * Single source of truth for all mutable billing state.
 * Replaces ~30 useState calls in App.tsx.
 *
 * Key design decisions:
 * - editedPrice is tracked separately from originalPrice (fixes the revert bug)
 * - updateItems always goes through applyAllPricingRules
 * - Selectors kept in store for easy memoization
 * - Toast notifications delegated to Sonner (removed dual state)
 */

import { create } from "zustand";
import type { BillItem, Customer, CustomerType, PaymentMode, PointsConfig } from "../types";
import { applyAllPricingRules, computeBillTotals } from "../pricing/resolver";

//start of billing store code

interface BillingState {
  // bill items
  items: BillItem[];

  // entry form fields
  entryItem: string;
  entryShade: string;
  entryQty: number;
  entryPrice: string;
  entryCost: string;

  // customer
  customer: Customer | null;
  customerName: string;
  phone: string;
  phone2: string;
  customerType: CustomerType;
  redeemPoints: boolean;

  // payment
  paymentMode: PaymentMode;
  courierCharges: string;
  amountReceived: string;

  // bill meta
  nextBillNo: number | null;
  billDate: string;
  billTime: string;
  editingBillNo: number | null;
  originalBillDate: string;
  originalBillTime: string;
  originalRowIndexes: number[];

  // ui state
  saving: boolean;
  savingProgress: boolean;
  selectedRow: number | null;
  deleteConfirmIdx: number | null;
  lastDeletedItem: BillItem | null;
  lastDeletedIdx: number | null;

  // points config
  pointsConfig: PointsConfig | null;

  // actions
  setItems: (items: BillItem[]) => void;
  updateItems: (items: BillItem[]) => void; // applies pricing rules
  addItem: (item: BillItem) => void;
  removeItem: (idx: number) => void;
  updateItemQty: (idx: number, qty: number) => void;
  updateItemPrice: (idx: number, price: number) => void;
  updateItemShade: (idx: number, shade: string, price: number, cost: number) => void;
  undoDelete: () => void;

  setEntryItem: (v: string) => void;
  setEntryShade: (v: string) => void;
  setEntryQty: (v: number) => void;
  setEntryPrice: (v: string) => void;
  setEntryCost: (v: string) => void;
  clearEntryForm: () => void;

  setCustomer: (c: Customer | null) => void;
  setCustomerName: (v: string) => void;
  setPhone: (v: string) => void;
  setPhone2: (v: string) => void;
  setCustomerType: (v: CustomerType) => void;
  setRedeemPoints: (v: boolean) => void;

  setPaymentMode: (v: PaymentMode) => void;
  setCourierCharges: (v: string) => void;
  setAmountReceived: (v: string) => void;

  setNextBillNo: (v: number) => void;
  setBillTime: (v: string) => void;
  setEditingBill: (billNo: number | null, date?: string, time?: string, rowIndexes?: number[]) => void;

  setSaving: (v: boolean) => void;
  setSavingProgress: (v: boolean) => void;
  setSelectedRow: (v: number | null) => void;
  confirmDelete: (idx: number) => void;
  cancelDelete: () => void;

  setPointsConfig: (c: PointsConfig | null) => void;

  resetBill: () => void; // clear after save
}

// initial state
const now = new Date();
const ISTDate = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
const ISTTime = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });

const INITIAL: Omit<BillingState, keyof ReturnType<typeof actions>> = {
  items: [],
  entryItem: "",
  entryShade: "",
  entryQty: 1,
  entryPrice: "",
  entryCost: "",
  customer: null,
  customerName: "",
  phone: "",
  phone2: "",
  customerType: "walk-in",
  redeemPoints: false,
  paymentMode: "Cash",
  courierCharges: "",
  amountReceived: "",
  nextBillNo: null,
  billDate: ISTDate,
  billTime: ISTTime,
  editingBillNo: null,
  originalBillDate: "",
  originalBillTime: "",
  originalRowIndexes: [],
  saving: false,
  savingProgress: false,
  selectedRow: null,
  deleteConfirmIdx: null,
  lastDeletedItem: null,
  lastDeletedIdx: null,
  pointsConfig: null,
};

// store creation
function actions(set: any, get: any) {
  return {
    setItems: (items: BillItem[]) => set({ items }),
    updateItems: (items: BillItem[]) => set({ items: applyAllPricingRules(items) }),

    addItem: (item: BillItem) => {
      const items = applyAllPricingRules([...get().items, item]);
      set({ items });
    },

    removeItem: (idx: number) => {
      const items = get().items;
      const last = items[idx];
      const newItems = items.filter((_: any, i: number) => i !== idx);
      set({
        items: applyAllPricingRules(newItems),
        lastDeletedItem: last,
        lastDeletedIdx: idx,
        selectedRow: null,
        deleteConfirmIdx: null,
      });
    },

    undoDelete: () => {
      const { lastDeletedItem, lastDeletedIdx, items } = get();
      if (lastDeletedItem === null || lastDeletedIdx === null) return;
      const updated = [...items];
      updated.splice(lastDeletedIdx, 0, lastDeletedItem);
      set({
        items: applyAllPricingRules(updated),
        lastDeletedItem: null,
        lastDeletedIdx: null,
      });
    },

    updateItemQty: (idx: number, qty: number) => {
      if (qty < 1) return;
      const items = get().items.map((it: BillItem, i: number) =>
        i === idx ? { ...it, qty, priceOverridden: false } : it
      );
      set({ items: applyAllPricingRules(items) });
    },

    updateItemPrice: (idx: number, price: number) => {
      const items = get().items.map((it: BillItem, i: number) => {
        if (i !== idx) return it;
        const total = it.qty * price;
        const profit = total - it.cost * it.qty;
        return { ...it, price, total, profit, priceOverridden: true };
      });
      // don't run pricing rules — this is a manual override
      set({ items });
    },

    updateItemShade: (idx: number, shade: string, price: number, cost: number) => {
      const items = get().items.map((it: BillItem, i: number) => {
        if (i !== idx) return it;
        const total = it.qty * price;
        const profit = total - cost * it.qty;
        return { ...it, shade, price, cost, total, profit, priceOverridden: false };
      });
      set({ items: applyAllPricingRules(items) });
    },

    setEntryItem: (entryItem: string) => set({ entryItem }),
    setEntryShade: (entryShade: string) => set({ entryShade }),
    setEntryQty: (entryQty: number) => set({ entryQty }),
    setEntryPrice: (entryPrice: string) => set({ entryPrice }),
    setEntryCost: (entryCost: string) => set({ entryCost }),

    clearEntryForm: () =>
      set({ entryItem: "", entryShade: "", entryQty: 1, entryPrice: "", entryCost: "" }),

    setCustomer: (customer: Customer | null) => set({ customer }),
    setCustomerName: (customerName: string) => set({ customerName }),
    setPhone: (phone: string) => set({ phone }),
    setPhone2: (phone2: string) => set({ phone2 }),
    setCustomerType: (customerType: CustomerType) => set({ customerType }),
    setRedeemPoints: (redeemPoints: boolean) => set({ redeemPoints }),

    setPaymentMode: (paymentMode: PaymentMode) => set({ paymentMode }),
    setCourierCharges: (courierCharges: string) => set({ courierCharges }),
    setAmountReceived: (amountReceived: string) => set({ amountReceived }),

    setNextBillNo: (nextBillNo: number) => set({ nextBillNo }),
    setBillTime: (billTime: string) => set({ billTime }),

    setEditingBill: (billNo: number | null, date = "", time = "", rowIndexes: number[] = []) =>
      set({ editingBillNo: billNo, originalBillDate: date, originalBillTime: time, originalRowIndexes: rowIndexes }),

    setSaving: (saving: boolean) => set({ saving }),
    setSavingProgress: (savingProgress: boolean) => set({ savingProgress }),
    setSelectedRow: (selectedRow: number | null) => set({ selectedRow }),

    confirmDelete: (deleteConfirmIdx: number) => set({ deleteConfirmIdx }),
    cancelDelete: () => set({ deleteConfirmIdx: null }),

    setPointsConfig: (pointsConfig: PointsConfig | null) => set({ pointsConfig }),

    resetBill: () =>
      set({
        items: [],
        entryItem: "",
        entryShade: "",
        entryQty: 1,
        entryPrice: "",
        entryCost: "",
        customer: null,
        customerName: "",
        phone: "",
        phone2: "",
        redeemPoints: false,
        courierCharges: "",
        amountReceived: "",
        selectedRow: null,
        editingBillNo: null,
        originalBillDate: "",
        originalBillTime: "",
        originalRowIndexes: [],
      }),
  };
}

export const useBillingStore = create<BillingState>((set, get) => ({
  ...(INITIAL as any),
  ...actions(set, get),
}));

// derived selectors

/** computed totals - use this in components, never recompute inline */
export function useBillTotals() {
  const { items, courierCharges, paymentMode, amountReceived } = useBillingStore();
  return computeBillTotals(
    items,
    Number(courierCharges) || 0,
    paymentMode,
    Number(amountReceived) || 0
  );
}

export function useDisplayBillMeta() {
  const { nextBillNo, billDate, billTime, editingBillNo, originalBillDate, originalBillTime } = useBillingStore();
  return {
    displayBillNo: editingBillNo ?? nextBillNo,
    displayBillDate: editingBillNo ? (originalBillDate || billDate) : billDate,
    displayBillTime: editingBillNo ? (originalBillTime || billTime) : billTime,
  };
}
