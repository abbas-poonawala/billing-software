import { useMemo } from "react";
import { create } from "zustand";
import type { BillItem, Customer, CustomerType, PaymentMode, PointsConfig } from "../types";
import { applyAllPricingRules, computeBillTotals } from "../pricing/resolver";

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
  customerId: string; // FIX BUG-04: moved from local CustomerSection state to store
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
  updateItems: (items: BillItem[]) => void;
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
  setCustomerId: (v: string) => void; // FIX BUG-04
  setPhone: (v: string) => void;
  setPhone2: (v: string) => void;
  setCustomerType: (v: CustomerType) => void;
  setRedeemPoints: (v: boolean) => void;

  setPaymentMode: (v: PaymentMode) => void;
  setCourierCharges: (v: string) => void;
  setAmountReceived: (v: string) => void;

  setNextBillNo: (v: number) => void;
  setBillTime: (v: string) => void;
  setBillDate: (v: string) => void;
  setEditingBill: (billNo: number | null, date?: string, time?: string, rowIndexes?: number[]) => void;

  setSaving: (v: boolean) => void;
  setSavingProgress: (v: boolean) => void;
  setSelectedRow: (v: number | null) => void;
  confirmDelete: (idx: number) => void;
  cancelDelete: () => void;

  setPointsConfig: (c: PointsConfig | null) => void;

  resetBill: () => void;
  resetCustomer: () => void; // FIX BUG-04: separate customer reset
}

function getCurrentISTDateTime(): { date: string; time: string } {
  const opts = { timeZone: "Asia/Kolkata" } as const;
  return {
    date: new Date().toLocaleDateString("en-IN", opts),
    time: new Date().toLocaleTimeString("en-IN", { ...opts, hour: "2-digit", minute: "2-digit", hour12: true }),
  };
}

const { date: initialDate, time: initialTime } = getCurrentISTDateTime();

const INITIAL_CUSTOMER_STATE = {
  customer: null as Customer | null,
  customerName: "",
  customerId: "", // FIX BUG-04
  phone: "",
  phone2: "",
  customerType: "walk-in" as CustomerType,
  redeemPoints: false,
};

const INITIAL_BILL_STATE = {
  items: [] as BillItem[],
  entryItem: "",
  entryShade: "",
  entryQty: 1,
  entryPrice: "",
  entryCost: "",
  paymentMode: "Cash" as PaymentMode,
  courierCharges: "",
  amountReceived: "",
  nextBillNo: null as number | null,
  billDate: initialDate,
  billTime: initialTime,
  editingBillNo: null as number | null,
  originalBillDate: "",
  originalBillTime: "",
  originalRowIndexes: [] as number[],
  saving: false,
  savingProgress: false,
  selectedRow: null as number | null,
  deleteConfirmIdx: null as number | null,
  lastDeletedItem: null as BillItem | null,
  lastDeletedIdx: null as number | null,
  pointsConfig: null as PointsConfig | null,
};

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

    setCustomer: (customer: Customer | null) => {
      if (customer) {
        // FIX BUG-04: sync customerId to store when customer is set
        set({
          customer,
          customerId: customer.customerId.replace(/^LMS-/, ""),
          customerName: customer.name,
          phone: customer.phone,
          phone2: customer.phone2 || "",
        });
      } else {
        set({ customer });
      }
    },
    setCustomerName: (customerName: string) => set({ customerName }),
    setCustomerId: (customerId: string) => set({ customerId }), // FIX BUG-04
    setPhone: (phone: string) => set({ phone }),
    setPhone2: (phone2: string) => set({ phone2 }),
    setCustomerType: (customerType: CustomerType) => set({ customerType }),
    setRedeemPoints: (redeemPoints: boolean) => set({ redeemPoints }),

    setPaymentMode: (paymentMode: PaymentMode) => set({ paymentMode }),
    setCourierCharges: (courierCharges: string) => set({ courierCharges }),
    setAmountReceived: (amountReceived: string) => set({ amountReceived }),

    setNextBillNo: (nextBillNo: number) => set({ nextBillNo }),
    setBillTime: (billTime: string) => set({ billTime }),
    setBillDate: (billDate: string) => set({ billDate }),
    setEditingBill: (billNo: number | null, date = "", time = "", rowIndexes: number[] = []) =>
      set({ editingBillNo: billNo, originalBillDate: date, originalBillTime: time, originalRowIndexes: rowIndexes }),

    setSaving: (saving: boolean) => set({ saving }),
    setSavingProgress: (savingProgress: boolean) => set({ savingProgress }),
    setSelectedRow: (selectedRow: number | null) => set({ selectedRow }),

    confirmDelete: (deleteConfirmIdx: number) => set({ deleteConfirmIdx }),
    cancelDelete: () => set({ deleteConfirmIdx: null }),

    setPointsConfig: (pointsConfig: PointsConfig | null) => set({ pointsConfig }),

    // FIX BUG-04: separate customer reset from bill reset
    resetCustomer: () => {
      set({
        ...INITIAL_CUSTOMER_STATE,
      });
    },

    resetBill: () => {
      const { date: currentDate, time: currentTime } = getCurrentISTDateTime();
      set({
        items: [],
        entryItem: "",
        entryShade: "",
        entryQty: 1,
        entryPrice: "",
        entryCost: "",
        // Customer state is intentionally not touched here.
        // Call resetCustomer() after a confirmed save when a fresh customer entry is required.
        redeemPoints: false,
        courierCharges: "",
        amountReceived: "",
        selectedRow: null,
        editingBillNo: null,
        originalBillDate: "",
        originalBillTime: "",
        originalRowIndexes: [],
        billDate: currentDate,
        billTime: currentTime,
        lastDeletedItem: null,
        lastDeletedIdx: null,
      });
    },
  };
}

export const useBillingStore = create<BillingState>((set, get) => ({
  ...INITIAL_CUSTOMER_STATE,
  ...INITIAL_BILL_STATE,
  ...actions(set, get),
}));

// FIX BUG-14: atomic selector to prevent torn state reads
export function useBillTotals() {
  const items = useBillingStore((state) => state.items);
  const courierCharges = useBillingStore((state) => state.courierCharges);
  const paymentMode = useBillingStore((state) => state.paymentMode);
  const amountReceived = useBillingStore((state) => state.amountReceived);
  const customerType = useBillingStore((state) => state.customerType);

  return useMemo(() => {
    const effectiveCourier = customerType === "courier" ? Number(courierCharges) || 0 : 0;
    return computeBillTotals(items, effectiveCourier, paymentMode, Number(amountReceived) || 0);
  }, [items, courierCharges, paymentMode, amountReceived, customerType]);
}

export function useDisplayBillMeta() {
  const nextBillNo = useBillingStore((state) => state.nextBillNo);
  const billDate = useBillingStore((state) => state.billDate);
  const billTime = useBillingStore((state) => state.billTime);
  const editingBillNo = useBillingStore((state) => state.editingBillNo);
  const originalBillDate = useBillingStore((state) => state.originalBillDate);
  const originalBillTime = useBillingStore((state) => state.originalBillTime);

  return useMemo(() => ({
    displayBillNo: editingBillNo ?? nextBillNo,
    displayBillDate: editingBillNo ? (originalBillDate || billDate) : billDate,
    displayBillTime: editingBillNo ? (originalBillTime || billTime) : billTime,
  }), [nextBillNo, billDate, billTime, editingBillNo, originalBillDate, originalBillTime]);
}