// domain types

export type PaymentMode = "Cash" | "GPay";
export type CustomerType = "walk-in" | "courier";

export type BillItem = {
  item: string;
  shade: string;
  qty: number;
  cost: number;
  price: number;
  originalPrice: number;
  effectivePrice?: number;
  total: number;
  profit: number;
  misc?: boolean;
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
  redeemRate: number | null;
  minRedeem: number | null;
};

// FIX BUG-04 + BUG-03: add customerId and customer to BillDraft
export type BillDraft = {
  items: BillItem[];
  customerName: string;
  customerId: string;        // FIX BUG-04: store customerId
  phone: string;
  phone2: string;
  redeemPoints: boolean;
  courierCharges: string;
  customerType: CustomerType;
  paymentMode: PaymentMode;
  customer: Customer | null; // FIX BUG-03: preserve full customer for recovery
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
  items: BillItem[];
};

// ─── Draft / Pending Bill System (BUG-11 fix) ─────────────────────────────────

export type DraftBillStatus =
  | "DRAFT"          // in-progress, not yet attempted to save
  | "PENDING_SAVE"   // save was attempted but failed / no confirmation received
  | "SAVED";         // successfully committed to backend

export type DraftBill = {
  draftId: string;             // UUID, client-generated
  status: DraftBillStatus;
  reservedBillNo: number | null; // bill number reserved before save attempt
  createdAt: string;           // ISO timestamp
  updatedAt: string;
  items: BillItem[];
  customerName: string;
  customerId: string;
  phone: string;
  phone2: string;
  redeemPoints: boolean;
  courierCharges: string;
  customerType: CustomerType;
  paymentMode: PaymentMode;
  customer: Customer | null;
  // captured financials at time of save attempt
  finalTotal?: number;
  gpayCharges?: number | null;
  courierChargesNum?: number;
  saveAttempts: number;
  lastError?: string;
};