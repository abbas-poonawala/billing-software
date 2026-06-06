import { useEffect } from "react";
import { useBillingStore } from "../store/billingStore";
import { validateItemPrice } from "../services/api";
import { showToast } from "../utils/toast";
import type { BillDraft } from "../types";

const DRAFT_KEY = "billDraft";

export function useBillDraft() {
  const {
  items,
  customerName,
  customerId,
  customer,
  phone,
  phone2,
  redeemPoints,
  courierCharges,
  customerType,
  paymentMode,

  updateItems,
  setCustomerName,
  setCustomerId,
  setCustomer,
  setPhone,
  setPhone2,
  setRedeemPoints,
  setCourierCharges,
  setCustomerType,
  setPaymentMode,
} = useBillingStore();

  // auto-save whenever bill data changes
  useEffect(() => {
    if (items.length === 0) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    const draft: BillDraft = {
      items,
      customerName,
      customerId,
      customer,
      phone,
      phone2,
      redeemPoints,
      courierCharges,
      customerType,
      paymentMode,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [items, customerName, customerId, customer, phone, phone2, redeemPoints, courierCharges, customerType, paymentMode]);

  // recover on mount
  useEffect(() => {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;

    let draft: BillDraft;
    try {
      draft = JSON.parse(raw);
    } catch {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }

    if (!draft.items?.length) return;

    const shouldRecover = window.confirm("You have an unsaved bill. Recover it?");
    if (!shouldRecover) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }

    // validate prices for non-misc items
    (async () => {
      const changes: string[] = [];
      const validatedItems = await Promise.all(
        draft.items.map(async item => {
          if (item.misc) return item;
          const result = await validateItemPrice(item.item, item.shade, item.price);
          if (result.changed) changes.push(result.changeDesc);
          return { ...item, price: result.price, priceOverridden: false };
        })
      );

      updateItems(validatedItems);
      setCustomerName(draft.customerName || "");
      setCustomerId(draft.customerId ?? "");
      setCustomer(draft.customer ?? null);
      setPhone(draft.phone || "");
      setPhone2(draft.phone2 || "");
      setRedeemPoints(draft.redeemPoints || false);
      setCourierCharges(draft.courierCharges || "");
      setCustomerType(draft.customerType === "courier" ? "courier" : "walk-in");
      setPaymentMode(draft.paymentMode === "GPay" ? "GPay" : "Cash");

      if (changes.length > 0) {
        showToast(`⚠️ Price changes since last session: ${changes.join(", ")}`, "info");
      } else {
        showToast("Bill recovered from draft", "success");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // call this after a successful save to clear the draft
  const clearDraft = () => localStorage.removeItem(DRAFT_KEY);

  return { clearDraft };
}
