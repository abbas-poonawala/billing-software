/**
 * PrintBill
 * ─────────
 * Isolated print layout. Gets all data as props.
 * Never reads from global state directly — safe to render independently.
 *
 * Usage:
 *   <PrintBill id="print-bill" {...billData} />
 *
 * Print CSS lives in print.css (imported in main.tsx or index.css).
 */

import React from "react";
import type { BillItem, Customer, PaymentMode } from "../../types";
import { formatPrice } from "../../utils/formatting";

interface Props {
  id?: string;
  items: BillItem[];
  customerName: string;
  phone: string;
  customer: Customer | null;
  billNo: number | null;
  billDate: string;
  billTime: string;
  courierCharges: number;
  gpayCharges: number;
  finalTotal: number;
  paymentMode: PaymentMode;
}

export default function PrintBill({
  id = "print-bill",
  items,
  customerName,
  phone,
  customer,
  billNo,
  billDate,
  billTime,
  courierCharges,
  gpayCharges,
  finalTotal,
  paymentMode,
}: Props) {
  return (
    <div id={id} style={styles.billArea}>
      {/* Logo */}
      <div style={styles.billHeader}>
        <img src="/logo.svg" alt="logo" className="logo" style={styles.logo} crossOrigin="anonymous" />
      </div>

      {/* Customer & Bill Meta */}
      <div style={styles.metaBlock}>
        <div style={styles.metaLeft}>
          {customer?.customerId && (
            <div style={styles.metaRow}><span style={styles.metaLabel}>ID:</span> {customer.customerId}</div>
          )}
          <div style={styles.metaRow}><span style={styles.metaLabel}>Customer:</span> {customerName || "—"}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Phone:</span> {phone || "—"}</div>
        </div>
        <div style={styles.metaRight}>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Bill No:</span> #{billNo ?? "—"}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Date:</span> {billDate}</div>
          <div style={styles.metaRow}><span style={styles.metaLabel}>Time:</span> {billTime}</div>
        </div>
      </div>

      {/* Items Table */}
      <table className="bill-table" style={styles.table}>
        <thead>
          <tr style={styles.theadRow}>
            <th style={{ ...styles.th, width: "5%", textAlign: "center" }}>#</th>
            <th style={{ ...styles.th, width: "30%" }}>Item</th>
            <th style={{ ...styles.th, width: "28%" }}>Shade</th>
            <th style={{ ...styles.th, width: "10%", textAlign: "center" }}>Qty</th>
            <th style={{ ...styles.th, width: "12%", textAlign: "right", paddingRight: 20 }}>Price</th>
            <th style={{ ...styles.th, width: "13%", textAlign: "right", paddingRight: 20 }}>Total</th>
            <th className="no-print" style={{ ...styles.th, width: "2%" }}></th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ textAlign: "center", padding: "24px 0", color: "#aaa" }}>
                No items added yet
              </td>
            </tr>
          ) : (
            items.map((item, idx) => (
              <tr key={idx} style={idx % 2 === 0 ? styles.trEven : styles.trOdd}>
                <td style={{ ...styles.td, textAlign: "center", color: "#999", fontSize: 13 }}>{idx + 1}</td>
                <td style={styles.td}>
                  {item.item}
                  {item.misc && <span className="no-print" style={{ fontSize: 10, color: "#e67e22" }}> (Misc)</span>}
                </td>
                <td style={styles.td}>{item.shade}</td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.qty}</td>
                <td style={{ ...styles.td, textAlign: "right", paddingRight: 20 }}>₹{formatPrice(item.price)}</td>
                <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, paddingRight: 20 }}>
                  ₹{formatPrice(item.total)}
                </td>
                <td className="no-print" style={styles.td} />
              </tr>
            ))
          )}
        </tbody>
      </table>

      <hr style={styles.divider} />

      {/* Totals */}
      <div style={styles.totalsBlock}>
        {courierCharges > 0 && (
          <div style={styles.chargeRow}>
            <span>Handling Charges:</span>
            <span>+ ₹{formatPrice(courierCharges)}</span>
          </div>
        )}
        {gpayCharges > 0 && (
          <div style={styles.chargeRow}>
            <span>GPay Charges (2%):</span>
            <span>+ ₹{formatPrice(gpayCharges)}</span>
          </div>
        )}
        <div style={styles.paymentModeRow}>
          <span>Payment Mode:</span>
          <span>{paymentMode}</span>
        </div>
        <div style={styles.grandTotalRow}>
          <span>Grand Total</span>
          <span>₹{formatPrice(finalTotal)}</span>
        </div>
      </div>

      <p style={styles.thankYou}>Thank you for your purchase!</p>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  billArea: {
    background: "#ffffff",
    borderRadius: 0,
    padding: "32px 36px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1.5px solid #1a1a1a",
    pageBreakInside: "avoid",
  },
  billHeader: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 0 },
  logo: { width: 300, height: "auto", objectFit: "contain", display: "block", margin: "0 auto" },
  metaBlock: {
    border: "1px solid #e2e8f0",
    padding: "12px 14px",
    marginBottom: 0,
    backgroundColor: "#f8f9fb",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 24,
  },
  metaLeft: { display: "flex", flexDirection: "column", gap: 3, flex: 1 },
  metaRight: { display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" },
  metaRow: { fontSize: 11, fontWeight: 600 },
  metaLabel: { fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", fontWeight: 800 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
    marginTop: 10,
    border: "1px solid #0f172a",
    userSelect: "none",
  },
  theadRow: { backgroundColor: "#f0f1f3" },
  th: {
    padding: "6px 4px",
    color: "#334155",
    fontWeight: 800,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.8px",
    textAlign: "left",
    borderBottom: "1px solid #0f172a",
  },
  td: {
    padding: "4px 4px",
    color: "#1e293b",
    fontSize: 12,
    borderBottom: "1px solid #e0e3e8",
    borderRight: "1px solid #e0e3e8",
    verticalAlign: "middle",
    fontWeight: 500,
  },
  trEven: { backgroundColor: "#ffffff" },
  trOdd: { backgroundColor: "#fbfcfd" },
  divider: { border: "none", borderTop: "1px dotted #cbd5e1", margin: "10px 0" },
  totalsBlock: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px dotted #cbd5e1",
  },
  chargeRow: {
    display: "flex",
    justifyContent: "space-between",
    minWidth: 260,
    fontSize: 14,
    color: "#dc2626",
    fontWeight: 800,
    letterSpacing: "-0.3px",
  },
  paymentModeRow: {
    display: "flex",
    justifyContent: "space-between",
    minWidth: 260,
    fontSize: 14,
    color: "#666",
  },
  grandTotalRow: {
    display: "flex",
    justifyContent: "space-between",
    minWidth: 260,
    fontSize: 17,
    fontWeight: 600,
    color: "#0f172a",
    borderTop: "1px solid #cbd5e1",
    paddingTop: 10,
    marginTop: 8,
    letterSpacing: "-0.3px",
  },
  thankYou: {
    textAlign: "center",
    marginTop: 16,
    paddingTop: 12,
    borderTop: "1px dotted #cbd5e1",
    fontSize: 11,
    color: "#475569",
    letterSpacing: "0.4px",
    fontWeight: 700,
    textTransform: "uppercase",
  },
};
