import React from "react";
import type { DraftBill } from "../types";
import { formatPrice } from "../utils/formatting";

interface Props {
  bills: DraftBill[];
  onRetry: (bill: DraftBill) => void;
  onLoad: (bill: DraftBill) => void;
  onDelete: (draftId: string) => void;
  onClose: () => void;
}

function statusLabel(status: DraftBill["status"]): { text: string; color: string } {
  switch (status) {
    case "DRAFT": return { text: "Draft", color: "#8b5cf6" };
    case "PENDING_SAVE": return { text: "Save Failed", color: "#ef4444" };
    case "SAVED": return { text: "Saved", color: "#10b981" };
  }
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
  } catch {
    return iso;
  }
}

export default function PendingBillsPanel({ bills, onRetry, onLoad, onDelete, onClose }: Props) {
  const pending = bills.filter(b => b.status !== "SAVED");
  const saved = bills.filter(b => b.status === "SAVED").slice(0, 5);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <h2 style={styles.title}>📋 Pending Bills</h2>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>

        {bills.length === 0 && (
          <div style={{ padding: "32px 0", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
            No pending bills. All clear! ✅
          </div>
        )}

        {pending.length > 0 && (
          <div>
            <div style={styles.sectionLabel}>Unsaved Bills ({pending.length})</div>
            {pending.map(bill => (
              <BillCard
                key={bill.draftId}
                bill={bill}
                onRetry={onRetry}
                onLoad={onLoad}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}

        {saved.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={styles.sectionLabel}>Recently Saved</div>
            {saved.map(bill => (
              <BillCard
                key={bill.draftId}
                bill={bill}
                onRetry={onRetry}
                onLoad={onLoad}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BillCard({ bill, onRetry, onLoad, onDelete }: {
  bill: DraftBill;
  onRetry: (bill: DraftBill) => void;
  onLoad: (bill: DraftBill) => void;
  onDelete: (draftId: string) => void;
}) {
  const status = statusLabel(bill.status);
  const itemCount = bill.items.length;
  const subtotal = bill.items.reduce((s, i) => s + i.total, 0);

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              ...styles.badge,
              background: status.color + "20",
              color: status.color,
              border: `1px solid ${status.color}40`,
            }}
          >
            {status.text}
          </span>
          {bill.reservedBillNo && (
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
              Bill #{bill.reservedBillNo}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{formatTs(bill.updatedAt)}</span>
      </div>

      <div style={styles.cardBody}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {bill.customerName || <span style={{ color: "#94a3b8" }}>No customer</span>}
          </div>
          {bill.phone && <div style={{ fontSize: 12, color: "#64748b" }}>{bill.phone}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
            ₹{formatPrice(bill.finalTotal ?? subtotal)}
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{itemCount} item{itemCount !== 1 ? "s" : ""}</div>
        </div>
      </div>

      {/* Item preview */}
      {bill.items.slice(0, 3).map((item, i) => (
        <div key={i} style={styles.itemRow}>
          <span>{item.item} ({item.shade}) ×{item.qty}</span>
          <span>₹{formatPrice(item.total)}</span>
        </div>
      ))}
      {itemCount > 3 && (
        <div style={{ fontSize: 11, color: "#94a3b8", paddingLeft: 4 }}>
          +{itemCount - 3} more item(s)
        </div>
      )}

      {/* Error message */}
      {bill.lastError && (
        <div style={styles.errorBox}>
          ⚠️ Last error: {bill.lastError}
          {bill.saveAttempts > 0 && (
            <span style={{ marginLeft: 8, color: "#94a3b8" }}>({bill.saveAttempts} attempt{bill.saveAttempts !== 1 ? "s" : ""})</span>
          )}
        </div>
      )}

      {/* Actions */}
      <div style={styles.actions}>
        {bill.status === "PENDING_SAVE" && (
          <button
            style={{ ...styles.btn, background: "#ef4444" }}
            onClick={() => onRetry(bill)}
          >
            🔄 Retry Save
          </button>
        )}
        {bill.status === "DRAFT" && (
          <button
            style={{ ...styles.btn, background: "#8b5cf6" }}
            onClick={() => onLoad(bill)}
          >
            ✏️ Continue Editing
          </button>
        )}
        {bill.status === "PENDING_SAVE" && (
          <button
            style={{ ...styles.btn, background: "#3b82f6" }}
            onClick={() => onLoad(bill)}
          >
            ✏️ Edit & Retry
          </button>
        )}
        {bill.status !== "SAVED" && (
          <button
            style={{ ...styles.btn, background: "#94a3b8" }}
            onClick={() => {
              if (window.confirm("Discard this bill? This cannot be undone.")) {
                onDelete(bill.draftId);
              }
            }}
          >
            🗑️ Discard
          </button>
        )}
        {bill.status === "SAVED" && (
          <button
            style={{ ...styles.btn, background: "#94a3b8" }}
            onClick={() => onDelete(bill.draftId)}
          >
            ✕ Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    zIndex: 9000,
    padding: 16,
  },
  panel: {
    background: "#fff",
    width: "min(480px, 100vw - 32px)",
    maxHeight: "calc(100vh - 32px)",
    overflowY: "auto",
    borderRadius: 0,
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
    border: "1.5px solid #e2e8f0",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    borderBottom: "1px solid #e2e8f0",
    position: "sticky",
    top: 0,
    background: "#fff",
    zIndex: 1,
  },
  title: { margin: 0, fontSize: 18, fontWeight: 800, color: "#0f172a" },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 20,
    cursor: "pointer",
    color: "#94a3b8",
    padding: "4px 8px",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.8px",
    color: "#94a3b8",
    padding: "12px 20px 4px",
  },
  card: {
    padding: "14px 20px",
    borderBottom: "1px solid #f1f5f9",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  badge: {
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 4,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  cardBody: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  itemRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    color: "#64748b",
    padding: "2px 0 2px 4px",
    borderLeft: "2px solid #e2e8f0",
    marginLeft: 2,
    marginBottom: 2,
  },
  errorBox: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 4,
    padding: "6px 10px",
    fontSize: 12,
    color: "#ef4444",
    marginTop: 8,
  },
  actions: {
    display: "flex",
    gap: 8,
    marginTop: 10,
    flexWrap: "wrap",
  },
  btn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    border: "none",
    borderRadius: 0,
    cursor: "pointer",
    letterSpacing: "0.2px",
  },
};