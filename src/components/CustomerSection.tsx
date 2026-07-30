import React, { useRef, useCallback } from 'react';
import { useBillingStore } from "../store/billingStore";
import SearchDropdown from "./SearchDropdown";
import { searchCustomersByName, searchCustomersByPhone, searchCustomersById } from "../services/api";
import { formatPrice } from "../utils/formatting";
import { showToast } from "../utils/toast";
import type { Customer } from "../types";
import { computePointsValue } from "../pricing/resolver";

const si: React.CSSProperties = {
  flex: 1,
  padding: "12px 14px",
  fontSize: 14,
  borderRadius: 0,
  border: "1px solid #cbd5e1",
  outline: "none",
  background: "#fbfcfd",
  fontWeight: 500,
};

export default function CustomerSection() {
  const {
    customer, customerName, customerId, phone, phone2, customerType, paymentMode,
    redeemPoints, courierCharges, pointsConfig,
    setCustomer, setCustomerName, setCustomerId, setPhone, setPhone2,
    setCustomerType, setPaymentMode, setRedeemPoints, setCourierCharges,
    resetCustomer,
  } = useBillingStore();

  const [searchResults, setSearchResults] = React.useState<Customer[]>([]);
  const [searching, setSearching] = React.useState(false);

  // FIX BUG-10: request cancellation for async race conditions
  const nameSearchAbortRef = useRef<AbortController | null>(null);
  const nameSearchSeqRef = useRef(0);
  const idSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const customerLabelMap = React.useMemo(() => {
    return new Map(
      searchResults.map(c => [`${c.customerId}: ${c.name}`, c])
    );
  }, [searchResults]);

  // FIX BUG-08 / BUG-09: clear customer state only explicitly, not on field edit
  const clearCustomer = useCallback(() => {
    resetCustomer();
    setSearchResults([]);
  }, [resetCustomer]);

  const clearLookupState = useCallback(() => {
    if (nameSearchAbortRef.current) {
      nameSearchAbortRef.current.abort();
      nameSearchAbortRef.current = null;
    }
    if (idSearchRef.current) {
      clearTimeout(idSearchRef.current);
      idSearchRef.current = null;
    }
    setSearching(false);
    setSearchResults([]);
  }, []);

  React.useEffect(() => {
    // Full clear signal from store reset: wipe pending lookup cache too.
    if (!customer && !customerName && !customerId && !phone && !phone2) {
      clearLookupState();
    }
  }, [customer, customerName, customerId, phone, phone2, clearLookupState]);

  const selectCustomer = useCallback((cust: Customer) => {
    setCustomer(cust); // FIX BUG-04: setCustomer now syncs customerId to store
    setSearchResults([]);
    showToast(`Customer: ${cust.name}`, "success");
  }, [setCustomer]);

  // FIX BUG-09: name change only triggers search — does NOT clear confirmed customer
  const handleNameChange = useCallback((val: string) => {
    setCustomerName(val);

    // Cancel any in-flight request
    if (nameSearchAbortRef.current) {
      nameSearchAbortRef.current.abort();
    }

    if (!val.trim() || val.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    // FIX BUG-10: monotonic sequence + AbortController
    const seq = ++nameSearchSeqRef.current;
    const controller = new AbortController();
    nameSearchAbortRef.current = controller;

    const timer = setTimeout(async () => {
      if (controller.signal.aborted) return;
      setSearching(true);
      try {
        const results = await searchCustomersByName(val);
        // Only update if this is still the latest request
        if (seq === nameSearchSeqRef.current && !controller.signal.aborted) {
          setSearchResults(results);
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Name search failed:", err);
        }
      } finally {
        if (seq === nameSearchSeqRef.current) {
          setSearching(false);
        }
      }
    }, 300);

    // Store timer so we can cancel it on abort
    controller.signal.addEventListener("abort", () => clearTimeout(timer));
  }, [setCustomerName]);

  const handlePhoneChange = useCallback(async (val: string) => {
    setPhone(val);
    const digits = val.replace(/[^0-9]/g, "");

    // Never reset typed customer form while editing phone.
    if (customer && digits !== customer.phone.replace(/[^0-9]/g, "")) {
      setCustomer(null);
    }

    if (!digits) return;

    if (digits.length >= 10) {
      try {
        const found = await searchCustomersByPhone(val);
        if (found) selectCustomer(found);
      } catch (err) {
        console.error("Phone lookup failed:", err);
      }
    }
  }, [setPhone, customer, setCustomer, selectCustomer]);

  // FIX BUG-08: phone2 change NEVER clears customer
  const handlePhone2Change = useCallback((val: string) => {
    setPhone2(val);
    // Do NOT call clearCustomer() here — phone2 is optional and clearing it
    // should never erase a confirmed customer. (BUG-08 fix)
  }, [setPhone2]);

  const handleIdChange = useCallback((val: string) => {
    const numericOnly = val.replace(/[^0-9]/g, "");
    setCustomerId(numericOnly);

    if (customer && numericOnly !== customer.customerId.replace(/^LMS-/, "")) {
      setCustomer(null);
    }

    if (!numericOnly) {
      // Only customer ID clear should fully clear the customer form.
      if (customerId.trim().length > 0) {
        clearCustomer();
      }
      return;
    }

    if (idSearchRef.current) clearTimeout(idSearchRef.current);
    idSearchRef.current = setTimeout(async () => {
      if (numericOnly.length >= 2) {
        try {
          const found = await searchCustomersById(`LMS-${numericOnly}`);
          if (found) selectCustomer(found);
        } catch (err) {
          console.error("ID search failed:", err);
        }
      }
    }, 400);
  }, [setCustomerId, customer, customerId, clearCustomer, setCustomer, selectCustomer]);

  const switchType = (type: "walk-in" | "courier") => {
    setCustomerType(type);
    if (type === "walk-in") setCourierCharges("");
  };

  // Show "new customer" hint only when:
  // 1. No confirmed customer object
  // 2. Name is long enough to be real
  // 3. Not currently searching
  const isNew = !customer && customerName.trim().length >= 2 && !searching;

  return (
    <div style={styles.card}>
      {/* Walk-in vs Courier */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={() => switchType("walk-in")}
          style={{ ...styles.typeBtn, background: customerType === "walk-in" ? "#10b981" : "#e5e7eb", color: customerType === "walk-in" ? "#fff" : "#374151", fontWeight: customerType === "walk-in" ? 700 : 500 }}
        >👤 Walk-in</button>
        <button
          onClick={() => switchType("courier")}
          style={{ ...styles.typeBtn, background: customerType === "courier" ? "#3b82f6" : "#e5e7eb", color: customerType === "courier" ? "#fff" : "#374151", fontWeight: customerType === "courier" ? 700 : 500 }}
        >🚚 Courier</button>
      </div>

      {/* Payment Mode */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#666", minWidth: 70 }}>Payment:</span>
        <div style={{ display: "flex", background: "#e5e7eb", borderRadius: 4, padding: 3 }}>
          {(["Cash", "GPay"] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setPaymentMode(mode)}
              style={{
                padding: "6px 16px",
                fontSize: 12,
                fontWeight: paymentMode === mode ? 600 : 500,
                background: paymentMode === mode ? (mode === "Cash" ? "#10b981" : "#3b82f6") : "transparent",
                color: paymentMode === mode ? "#fff" : "#666",
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              {mode === "Cash" ? "💵 Cash" : "📱 GPay"}
            </button>
          ))}
        </div>
      </div>

      {/* customer search inputs */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {/* name search with dropdown */}
        <SearchDropdown
          value={customerName}
          onChange={handleNameChange}
          onSelect={opt => {
            const c = customerLabelMap.get(opt);
            if (c) selectCustomer(c);
          }}
          options={searchResults.map(r => `${r.customerId}: ${r.name}`)}
          placeholder="Search Customer Name..."
          style={si}
          renderOption={(opt, highlighted) => {
            const c = customerLabelMap.get(opt);
            return (
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0", background: highlighted ? "#f0f4f8" : "#fff" }}>
                <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 13 }}>{c?.customerId}: {c?.name}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>📞 {c?.phone}{c?.phone2 ? `, ${c.phone2}` : ""} • {c?.points} pts</div>
              </div>
            );
          }}
          maxVisible={10}
        />

        <input value={phone} onChange={e => handlePhoneChange(e.target.value)} placeholder="Phone 1" style={si} />
        <input
          value={phone2}
          onChange={e => handlePhone2Change(e.target.value)} // FIX BUG-08
          placeholder="Phone 2 (optional)"
          style={si}
        />

        {/* Customer ID with prefix — reads from store (FIX BUG-04) */}
        <div style={{ ...si, display: "flex", alignItems: "center", padding: 0, gap: 0, flex: 1 }}>
          <span style={{ padding: "12px 14px", background: "#f0f4f8", fontWeight: 700, color: "#0f172a", fontSize: 14, borderRight: "1px solid #cbd5e1" }}>LMS-</span>
          <input
            value={customerId}
            onChange={e => handleIdChange(e.target.value)}
            placeholder="Search by ID..."
            style={{ ...si, flex: 1, margin: 0, padding: "12px 14px", border: "none", borderLeft: "none" }}
            inputMode="numeric"
          />
        </div>

        {searching && <span>🔍</span>}
      </div>

      {/* customer info */}
      {customer && (
        <div style={styles.customerInfo}>
          <span>👤 {customer.customerId}: {customer.name}<br/>Points: {customer.points}</span>
          <button
            onClick={clearCustomer}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              background: "#ef4444",
              color: "#fff",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            ✕ Remove
          </button>
          {pointsConfig && pointsConfig.minRedeem != null && customer.points >= pointsConfig.minRedeem ? (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={redeemPoints} onChange={e => setRedeemPoints(e.target.checked)} />
              Redeem {customer.points} pts ({pointsConfig.redeemRate != null ? `₹${formatPrice(computePointsValue(customer.points, pointsConfig.redeemRate))} off` : "points available"})
            </label>
          ) : pointsConfig && pointsConfig.minRedeem != null ? (
            <span style={{ fontSize: 12, color: "#aaa" }}>
              {pointsConfig.minRedeem - customer.points} more pts to redeem
            </span>
          ) : null}
        </div>
      )}

      {/* new customer hint */}
      {isNew && (
        <div style={{ fontSize: 13, color: "#888", marginTop: 6, fontWeight: 500 }}>
          🆕 New customer, will be registered on save.
        </div>
      )}

      {/* courier charges */}
      {customerType === "courier" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 120 }}>Courier Charges:</span>
          <input
            type="text"
            inputMode="decimal"
            value={courierCharges}
            onChange={e => setCourierCharges(e.target.value)}
            style={{ width: 100, padding: "8px 10px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 0, outline: "none" }}
          />
        </div>
      )}
      {customerType === "walk-in" && (
        <div style={{ fontSize: 12, color: "#aaa", marginTop: 8 }}>Walk-in mode: No courier charges</div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#ffffff",
    padding: 24,
    borderRadius: 0,
    marginTop: 24,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    border: "1px solid #e2e8f0",
  },
  typeBtn: {
    flex: 1,
    padding: "8px 12px",
    fontSize: 13,
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  },
  customerInfo: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    marginTop: 14,
    fontSize: 13,
    color: "#1e293b",
    fontWeight: 600,
  },
};