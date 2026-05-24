/**
 * BillTable
 * ─────────
 * Renders the live bill items table with:
 * - Qty +/− controls
 * - Inline price edit (EditableCell — no revert bug)
 * - Inline shade edit with dropdown
 * - Row selection
 * - Delete confirmation
 */

import React, { useState } from "react";
import { useBillingStore } from "../store/billingStore";
import EditableCell from "./EditableCell";
import SearchDropdown from "./SearchDropdown";
import { formatPrice } from "../utils/formatting";
import { fetchPrice, fetchCost, fetchShades } from "../services/api";

interface Props {
  shadeCache: React.MutableRefObject<Record<string, string[]>>;
}

export default function BillTable({ shadeCache }: Props) {
  const {
    items,
    selectedRow,
    setSelectedRow,
    updateItemQty,
    updateItemPrice,
    updateItemShade,
    confirmDelete,
  } = useBillingStore();

  // shade editing state
  const [editingShadeRow, setEditingShadeRow] = useState<number | null>(null);
  const [editingShadeValue, setEditingShadeValue] = useState("");
  const [shadeOptions, setShadeOptions] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);

  const startShadeEdit = async (idx: number, currentShade: string) => {
    setEditingShadeRow(idx);
    setEditingShadeValue(currentShade);
    const itemName = items[idx].item;
    let opts = shadeCache.current[itemName] || [];
    if (!opts.length) {
      opts = await fetchShades(itemName);
      shadeCache.current[itemName] = opts;
    }
    setShadeOptions(opts);
  };

  const saveShadeEdit = async (idx: number) => {
    const newShade = editingShadeValue.trim();
    if (!newShade) { alert("Shade cannot be empty"); return; }
    const itemName = items[idx].item;

    const matched = shadeOptions.find(s => s.toLowerCase() === newShade.toLowerCase());
    if (!matched) {
      alert(`"${newShade}" not valid. Available: ${shadeOptions.join(", ")}`);
      setEditingShadeRow(null);
      return;
    }

    setValidating(true);
    try {
      const [{ price }, cost] = await Promise.all([
        fetchPrice(itemName, matched),
        fetchCost(itemName, matched),
      ]);
      updateItemShade(idx, matched, price || items[idx].price, cost || items[idx].cost);
      setEditingShadeRow(null);
    } catch {
      alert("Could not validate shade.");
    } finally {
      setValidating(false);
    }
  };

  if (items.length === 0) {
    return (
      <tr>
        <td colSpan={7} style={{ textAlign: "center", padding: "32px 0", color: "#aaa", fontSize: 13 }}>
          No items added yet
        </td>
      </tr>
    );
  }

  return (
    <>
      {items.map((item, idx) => (
        <tr
          key={idx}
          style={{
            backgroundColor: selectedRow === idx
              ? "#f0f4f8"
              : idx % 2 === 0 ? "#ffffff" : "#fbfcfd",
            cursor: "pointer",
          }}
          onClick={() => setSelectedRow(idx)}
        >
          {/* # */}
          <td style={td}>{idx + 1}</td>

          {/* Item */}
          <td style={td}>
            {item.item}
            {item.misc && <span className="no-print" style={{ fontSize: 10, color: "#e67e22" }}> (Misc)</span>}
          </td>

          {/* Shade */}
          <td style={td}>
            {editingShadeRow === idx ? (
              <SearchDropdown
                value={editingShadeValue}
                onChange={setEditingShadeValue}
                onSelect={val => { setEditingShadeValue(val); saveShadeEdit(idx); }}
                options={shadeOptions.filter(s =>
                  !editingShadeValue.trim() || s.toLowerCase().includes(editingShadeValue.toLowerCase())
                )}
                style={{ minWidth: 120, padding: "3px 6px", fontSize: 12, border: "1px solid #ccc", borderRadius: 3 }}
                disabled={validating}
                onKeyDownExtra={e => {
                  if (e.key === "Enter") { e.preventDefault(); saveShadeEdit(idx); }
                  if (e.key === "Escape") { setEditingShadeRow(null); }
                }}
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ flex: 1, wordBreak: "break-word" }}>{item.shade}</span>
                <button
                  className="no-print"
                  onClick={e => { e.stopPropagation(); startShadeEdit(idx, item.shade); }}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: 4, color: "#94a3b8" }}
                  title="Edit shade"
                >✏️</button>
              </div>
            )}
          </td>

          {/* Qty */}
          <td style={{ ...td, textAlign: "center" }}>
            <span className="no-print" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <button style={qtyBtn} onClick={e => { e.stopPropagation(); updateItemQty(idx, item.qty - 1); }}>−</button>
              <span style={{ minWidth: 28, textAlign: "center", fontWeight: 700 }}>{item.qty}</span>
              <button style={qtyBtn} onClick={e => { e.stopPropagation(); updateItemQty(idx, item.qty + 1); }}>+</button>
            </span>
            <span className="print-only" style={{ display: "none" }}>{item.qty}</span>
          </td>

          {/* Price */}
          <td style={{ ...td, textAlign: "right", paddingRight: 20 }}>
            <EditableCell
              value={`₹${formatPrice(item.price)}`}
              onSave={val => {
                const n = Number(val.replace(/[^0-9.]/g, ""));
                if (isNaN(n) || n <= 0) { alert("Price must be > 0"); return; }
                updateItemPrice(idx, n);
              }}
              validate={val => {
                const n = Number(val.replace(/[^0-9.]/g, ""));
                if (isNaN(n) || n <= 0) return "Price must be greater than 0";
                return null;
              }}
              inputMode="decimal"
              inputStyle={{ width: 80, textAlign: "right" }}
            >
              ₹{formatPrice(item.price)}
              {item.priceOverridden && (
                <span title={`Original: ₹${formatPrice(item.originalPrice)}`} style={{ fontSize: 10, color: "#f59e0b", marginLeft: 2 }}>*</span>
              )}
            </EditableCell>
          </td>

          {/* Total */}
          <td style={{ ...td, textAlign: "right", fontWeight: 700, paddingRight: 20 }}>
            ₹{formatPrice(item.total)}
          </td>

          {/* Delete */}
          <td className="no-print" style={{ ...td, textAlign: "center" }}>
            <button
              style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 15, fontWeight: 700, padding: "2px 6px" }}
              onClick={e => { e.stopPropagation(); confirmDelete(idx); }}
            >✕</button>
          </td>
        </tr>
      ))}
    </>
  );
}

const td: React.CSSProperties = {
  padding: "4px",
  color: "#1e293b",
  fontSize: 12,
  borderBottom: "1px solid #e0e3e8",
  borderRight: "1px solid #e0e3e8",
  verticalAlign: "middle",
  fontWeight: 500,
};

const qtyBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 0,
  border: "1px solid #cbd5e1",
  background: "#f1f5f9",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
