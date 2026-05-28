import React, {useRef} from 'react';
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
    customer, customerName, phone, phone2, customerType, paymentMode,
    redeemPoints, courierCharges, pointsConfig,
    setCustomer, setCustomerName, setPhone, setPhone2,
    setCustomerType, setPaymentMode, setRedeemPoints, setCourierCharges,
  } = useBillingStore();

  const [searchResults, setSearchResults] = React.useState<Customer[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [customerId, setCustomerId] = React.useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const customerLabelMap = React.useMemo(() => {
    return new Map(
      searchResults.map(c => [`${c.customerId} — ${c.name}`, c])
    );
  }, [searchResults]);

  // clear all customer fields
  const clearCustomer = () => {
    setCustomer(null);
    setCustomerName("");
    setPhone("");
    setPhone2("");
    setCustomerId("");
    setSearchResults([]);
    setRedeemPoints(false);
  };

  const selectCustomer = (cust: Customer) => {
    setCustomer(cust);
    setCustomerName(cust.name);
    setPhone(cust.phone);
    setPhone2(cust.phone2 || "");
    setCustomerId(cust.customerId.replace(/^LMS-/, ""));
    setSearchResults([]);
    showToast(`Customer: ${cust.name}`, "success");
  };

  const handleNameChange = (val: string) => {
    setCustomerName(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    
    // if cleared, clear customer
    if (!val.trim()) {
      clearCustomer();
      return;
    }
    
    if (val.trim().length < 2) { 
      setSearchResults([]); 
      return; 
    }
    
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchCustomersByName(val);
        setSearchResults(results);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const handlePhoneChange = async (val: string) => {
    setPhone(val);
    const digits = val.replace(/[^0-9]/g, "");
    
    // if cleared, clear customer
    if (!digits) {
      clearCustomer();
      return;
    }
    
    if (digits.length >= 10) {
      const found = await searchCustomersByPhone(val);
      if (found) selectCustomer(found);
    }
  };

  const handlePhone2Change = async (val: string) => {
    setPhone2(val);
    const digits = val.replace(/[^0-9]/g, "");
    
    // if cleared, clear customer
    if (!digits) {
      clearCustomer();
      return;
    }
    
    if (digits.length >= 10) {
      const found = await searchCustomersByPhone(val);
      if (found) selectCustomer(found);
    }
  };

  const handleIdChange = (val: string) => {
    // only allow numeric input
    const numericOnly = val.replace(/[^0-9]/g, "");
    setCustomerId(numericOnly);
    
    // clear if empty
    if (!numericOnly) {
      clearCustomer();
      return;
    }
    
    // debounce ID search - only after numeric input exists
    if (idSearchRef.current) clearTimeout(idSearchRef.current);
    idSearchRef.current = setTimeout(async () => {
      if (numericOnly.length >= 2) {
        const found = await searchCustomersById(`LMS-${numericOnly}`);
        if (found) selectCustomer(found);
      }
    }, 400);
  };

  const switchType = (type: "walk-in" | "courier") => {
    setCustomerType(type);
    if (type === "walk-in") setCourierCharges("");
  };

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
          options={searchResults.map(r => `${r.customerId} — ${r.name}`)}
          placeholder="Search Customer Name..."
          style={si}
          renderOption={(opt, highlighted) => {
            const c = customerLabelMap.get(opt);
            return (
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #f0f0f0", background: highlighted ? "#f0f4f8" : "#fff" }}>
                <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 13 }}>{c?.customerId} — {c?.name}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>📞 {c?.phone}{c?.phone2 ? `, ${c.phone2}` : ""} • {c?.points} pts</div>
              </div>
            );
          }}
          maxVisible={10}
        />

        <input value={phone} onChange={e => handlePhoneChange(e.target.value)} placeholder="Phone 1" style={si} />
        <input value={phone2} onChange={e => handlePhone2Change(e.target.value)} placeholder="Phone 2 (optional)" style={si} />
        
        {/* Customer ID with prefix */}
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
          <span>👤 {customer.customerId} — {customer.name} — {customer.points} pts</span>
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
          {pointsConfig && customer.points >= pointsConfig.minRedeem ? (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={redeemPoints} onChange={e => setRedeemPoints(e.target.checked)} />
              Redeem {customer.points} pts (₹{formatPrice(computePointsValue(customer.points, pointsConfig.redeemRate))} off)
            </label>
          ) : pointsConfig ? (
            <span style={{ fontSize: 12, color: "#aaa" }}>
              {pointsConfig.minRedeem - customer.points} more pts to redeem
            </span>
          ) : null}
        </div>
      )}

      {/* new customer hint */}
      {isNew && (
        <div style={{ fontSize: 13, color: "#888", marginTop: 6, fontWeight: 500 }}>
          🆕 New customer — will be registered on save.
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
