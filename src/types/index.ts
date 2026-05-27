// domain types

export type PaymentMode = "Cash" | "GPay";
export type CustomerType = "walk-in" | "courier";

export type BillItem = {
  item: string;
  shade: string;
  qty: number;
  cost: number;
  // current price may be overridden by user or modified by pricing rules
  price: number;
  // fetched price
  originalPrice: number;
  // price after applying rules, but before manual override
  effectivePrice?: number;
  total: number;
  profit: number;
  misc?: boolean;
  // true only when the cashier has manually overridden the price
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
