// src/components/print/PrintBill.tsx
import React from "react";
import type { BillItem, Customer, PaymentMode } from "../../types";
import { formatPrice } from "../../utils/formatting";

interface Props {
  id?: string;
  items: BillItem[];
  customerName: string;
  phone: string;
  phone2?: string;
  customer: Customer | null;
  billNo: number | null;
  billDate: string;
  billTime: string;
  courierCharges: number;
  gpayCharges: number;
  finalTotal: number;
  paymentMode: PaymentMode;
  children?: React.ReactNode;
}

export default function PrintBill({
  id = "print-bill",
  items,
  customerName,
  phone,
  phone2,
  customer,
  billNo,
  billDate,
  billTime,
  courierCharges,
  gpayCharges,
  finalTotal,
  children,
}: Props) {
  return (
    <div id={id} style={styles.billArea}>
      {/* Logo */}
      <div style={styles.billHeader}>
        <img src="/logo.svg" alt="logo" className="logo" style={styles.logo} crossOrigin="anonymous" />
        <div style={styles.contactBlock}>
          <div style={styles.contactLine}>Shop No: F-27, First FLoor, Al-Lulu Complex, Bhendi Bazaar, Mumbai - 400003</div>
          <div style={styles.contactLine}>Phone No: +919004452933</div>
        </div>
      </div>

      {/* Customer & Bill Meta */}
      <div style={styles.metaBlock}>
        <div style={styles.metaLeft}>
          {customer?.customerId && (
            <div style={styles.metaRow}><span style={styles.metaLabel}>ID:</span> {customer.customerId}</div>
          )}
          <div style={styles.metaRow}><span style={styles.metaLabel}>Customer:</span> {customerName || ""}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Phone:</span> {phone || ""}</div>
          {phone2 && (
            <div style={styles.metaRow}><span style={styles.metaLabel}>Phone 2:</span> {phone2}</div>
          )}
        </div>
        <div style={styles.metaRight}>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Bill No:</span> #{billNo ?? ""}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Date:</span> {billDate}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Time:</span> {billTime}</div>
        </div>
      </div>

      {/* Items Table */}
      {children ? (
        children
      ) : (
        <table className="bill-table" style={styles.table}>
          <thead>
            <tr style={styles.theadRow}>
              <th style={{ ...styles.th, width: "5%", textAlign: "center" }}>#</th>
              <th style={{ ...styles.th, width: "30%" }}>Item</th>
              <th style={{ ...styles.th, width: "28%" }}>Shade</th>
              <th style={{ ...styles.th, width: "10%", textAlign: "center" }}>Qty</th>
              <th style={{ ...styles.th, width: "12%", textAlign: "right", paddingRight: 10 }}>Price</th>
              <th style={{ ...styles.th, width: "13%", textAlign: "right", paddingRight: 10 }}>Total</th>
              <th className="no-print" style={{ ...styles.th, width: "2%" }}></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "12px 0", color: "#aaa", fontSize: 11 }}>
                  No items added yet
                </td>
              </tr>
            ) : (
              items.map((item, idx) => (
                <tr key={idx} style={idx % 2 === 0 ? styles.trEven : styles.trOdd}>
                  <td style={{ ...styles.td, textAlign: "center", color: "#999", fontSize: 11 }}>{idx + 1}</td>
                  <td style={styles.td}>
                    {item.item}
                    {item.misc && <span className="no-print" style={{ fontSize: 10, color: "#e67e22" }}> (Misc)</span>}
                  </td>
                  <td style={styles.td}>{item.shade}</td>
                  <td style={{ ...styles.td, textAlign: "center" }}>{item.qty}</td>
                  <td style={{ ...styles.td, textAlign: "right", paddingRight: 10 }}>₹{formatPrice(item.price)}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, paddingRight: 10 }}>
                    ₹{formatPrice(item.total)}
                  </td>
                  <td className="no-print" style={styles.td} />
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <hr style={styles.divider} />

      {/* Totals */}
      <div style={styles.totalsBlock}>
        {courierCharges > 0 && (
          <div style={styles.chargeRow}>
            <span>Forwarding Charges:</span>
            <span>+ ₹{formatPrice(courierCharges)}</span>
          </div>
        )}
        {gpayCharges > 0 && (
          <div style={styles.chargeRow}>
            <span>GPay Charges (2%):</span>
            <span>+ ₹{formatPrice(gpayCharges)}</span>
          </div>
        )}
        <div style={styles.grandTotalRow}>
          <span>Grand Total</span>
          <span>₹{formatPrice(finalTotal)}</span>
        </div>
      </div>

      <p style={styles.thankYou}>Thank you for your purchase!</p>
    </div>
  );
}

// styles
const styles: Record<string, React.CSSProperties> = {
  billArea: {
    background: "#ffffff",
    borderRadius: 0,
    padding: "10px 14px 8px",
    boxShadow: "none",
    border: "1.5px solid #1a1a1a",
    pageBreakInside: "avoid",
  },
  billHeader: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 4, paddingTop: 0, },
  logo: { width: 170, height: "auto", objectFit: "contain", display: "block", margin: "0 auto" },
  contactBlock: {
    marginTop: 4,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  contactLine: {
    fontSize: 10,
    fontWeight: 600,
    color: "#334155",
    lineHeight: 1.2,
  },
  metaBlock: {
    border: "1px solid #e2e8f0",
    padding: "8px 10px",
    marginBottom: 0,
    backgroundColor: "#f8f9fb",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  metaLeft: { display: "flex", flexDirection: "column", gap: 2, flex: 1 },
  metaRight: { display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" },
  metaRow: { fontSize: 10, fontWeight: 600 },
  metaLabel: { fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 800 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 11,
    marginTop: 4,
    border: "1px solid #0f172a",
    userSelect: "none",
  },
  theadRow: { backgroundColor: "#f0f1f3" },
  th: {
    padding: "3px 3px",
    color: "#334155",
    fontWeight: 800,
    fontSize: 8,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    textAlign: "left",
    borderBottom: "1px solid #0f172a",
  },
  td: {
    padding: "3px 3px",
    color: "#1e293b",
    fontSize: 11,
    // borderBottom: "1px solid #e0e3e8",
    borderRight: "1px solid #e0e3e8",
    verticalAlign: "middle",
    fontWeight: 500,
  },
  trEven: { backgroundColor: "#ffffff" },
  trOdd: { backgroundColor: "#fbfcfd" },
  totalsBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
    marginTop: 4,
    paddingTop: 4,
    // borderTop: "1px solid #818787",
  },
  chargeRow: {
    display: "flex",
    justifyContent: "space-between",
    minWidth: 200,
    fontSize: 12,
    color: "#dc2626",
    fontWeight: 800,
    letterSpacing: "-0.2px",
  },
  grandTotalRow: {
    display: "flex",
    justifyContent: "space-between",
    minWidth: 200,
    fontSize: 15,
    fontWeight: 600,
    color: "#0f172a",
    //borderTop: "1px solid #cbd5e1",
    paddingTop: 6,
    marginTop: 4,
    letterSpacing: "-0.2px",
  },
  thankYou: {
    textAlign: "center",
    marginTop: 8,
    paddingTop: 6,
    borderTop: "1px solid #cbd5e1",
    fontSize: 10,
    color: "#475569",
    letterSpacing: "0.3px",
    fontWeight: 700,
  },
};
