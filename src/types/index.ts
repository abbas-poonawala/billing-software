// ─── Domain Types ──────────────────────────────────────────────────────────────

export type PaymentMode = "Cash" | "GPay";
export type CustomerType = "walk-in" | "courier";

export type BillItem = {
  item: string;
  shade: string;
  qty: number;
  cost: number;
  /** The price currently shown / used for calculation */
  price: number;
  /** The price fetched from the sheet — never mutated after add */
  originalPrice: number;
  /** The effective price shown to the user (same as price, kept for clarity) */
  effectivePrice?: number;
  total: number;
  profit: number;
  misc?: boolean;
  /** True only when the cashier has manually overridden the price */
  priceOverridden?: boolean;
};

export type Customer = {
  customerId: string;
  name: string;
  phone: string;
  phone2?: string;
  points: number;
  totalSpend: number;
  totalBills: number;
};

export type PointsConfig = {
  earnRate: number;
  redeemRate: number;
  minRedeem: number;
};

export type BillDraft = {
  items: BillItem[];
  customerName: string;
  phone: string;
  phone2: string;
  redeemPoints: boolean;
  courierCharges: string;
  customerType: CustomerType;
  paymentMode: PaymentMode;
};

export type RetrievedBill = {
  billNo: number;
  items: BillItem[];
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerPhone2?: string;
  date: string;
  time: string;
  courierCharges: number;
  paymentMode: PaymentMode;
  gpayCharges?: number | null;
  finalTotal: number;
  lastUpdated?: string;
  originalRowIndexes: number[];
};

export type Toast = {
  message: string;
  type: "success" | "error" | "info";
};

export type PriceContext = {
  item: string;
  shade: string;
  qty: number;
  paymentMode: PaymentMode;
  courierCharges: number;
  items: BillItem[]; // full bill (for slab pricing)
};
