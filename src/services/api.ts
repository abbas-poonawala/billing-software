import type { Customer, PointsConfig, RetrievedBill } from "../types";

// inventory
export async function fetchItems(): Promise<string[]> {
  const res = await fetch("/api/core?action=getItems");
  const data = await res.json();
  return data.items || [];
}

export async function fetchShades(item: string): Promise<string[]> {
  const res = await fetch(`/api/core?action=getShades&item=${encodeURIComponent(item)}`);
  const data = await res.json();
  return data.shades || [];
}

export interface PriceResult {
  price: number;
  qty: number;
  method?: string;
}

export async function fetchPrice(item: string, shade: string): Promise<PriceResult> {
  const res = await fetch(
    `/api/core?action=getPrice&item=${encodeURIComponent(item)}&shade=${encodeURIComponent(shade)}`
  );
  const data = await res.json();
  return { price: data.price || 0, qty: data.qty ?? -1, method: data.method };
}

export async function fetchCost(item: string, shade: string): Promise<number> {
  const res = await fetch(
    `/api/core?action=getCost&item=${encodeURIComponent(item)}&shade=${encodeURIComponent(shade)}`
  );
  const data = await res.json();
  return data.cost || 0;
}

export async function fetchPointsConfig(): Promise<PointsConfig | null> {
  try {
    const res = await fetch("/api/core?action=getPointsConfig");
    const data = await res.json();
    return data.config || null;
  } catch {
    return null;
  }
}

// customer search
export async function searchCustomersByName(name: string): Promise<Customer[]> {
  const res = await fetch(
    `/api/core?action=searchCustomersByName&name=${encodeURIComponent(name.trim())}`
  );
  const data = await res.json();
  return data.customers || [];
}

export async function searchCustomersByPhone(phone: string): Promise<Customer | null> {
  const res = await fetch(
    `/api/core?action=searchCustomersByPhone&phone=${encodeURIComponent(phone.trim())}`
  );
  const data = await res.json();
  return data.customer || null;
}

export async function searchCustomersById(customerId: string): Promise<Customer | null> {
  const res = await fetch(
    `/api/core?action=searchCustomersById&customerId=${encodeURIComponent(customerId.trim())}`
  );
  const data = await res.json();
  return data.customer || null;
}

// barcode lookup
export interface BarcodeResult {
  item: string;
  shade: string;
  price: number;
}

export async function lookupBarcode(barcode: string): Promise<BarcodeResult> {
  const res = await fetch(`/api/lookupBarcode?barcode=${encodeURIComponent(barcode)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Product not found");
  return data;
}

// billing
export async function fetchNextBillNo(): Promise<number> {
  const res = await fetch("/api/bill");
  const data = await res.json();
  return (data.billNo || 0) + 1;
}

export async function fetchBill(billNo: number): Promise<RetrievedBill> {
  const res = await fetch(`/api/bill?action=getBill&billNo=${billNo}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Bill not found");
  return data.bill;
}

export interface SaveBillPayload {
  items: any[];
  finalTotal: number;
  courierCharges: number;
  gpayCharges: number | null;
  paymentMode: string;
  customer: {
    name: string;
    phone: string;
    phone2: string;
    type: string;
    courier: boolean;
  };
  earnRate: number;
  redeemRate: number;
  // for edits:
  originalBillNo?: number;
  originalDate?: string;
  originalTime?: string;
  originalRowIndexes?: number[];
}

export async function saveBill(payload: SaveBillPayload): Promise<{ billNo: number; customerId: string; fallbackUsage?: Array<{ item: string; shade: string; individualsUsed: number; packetsOpened: number }> }> {
  const isEdit = Boolean(payload.originalBillNo);
  const url = isEdit ? "/api/bill?action=edit" : "/api/bill";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Save failed");
  return data;
}

// restock
export interface RestockResult {
  message?: string;
  summary?: string;
  waLink?: string;
}

export async function fetchStoreRestock(item: string): Promise<RestockResult> {
  const res = await fetch(`/api/restock?type=store&item=${encodeURIComponent(item)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Restock failed");
  return data;
}

// pricing rules validation
export async function validateItemPrice(
  item: string,
  shade: string,
  currentPrice: number
): Promise<{ price: number; changed: boolean; changeDesc: string }> {
  try {
    const { price } = await fetchPrice(item, shade);
    const changed = price > 0 && price !== currentPrice;
    return {
      price: changed ? price : currentPrice,
      changed,
      changeDesc: changed ? `${item}: ₹${currentPrice} → ₹${price}` : "",
    };
  } catch {
    return { price: currentPrice, changed: false, changeDesc: "" };
  }
}
