import { useState, useEffect, useRef } from "react";
import html2canvas from "html2canvas";
import { Toaster } from "sonner";
import { useBillingStore, useBillTotals, useDisplayBillMeta } from "./store/billingStore";
import { useBillDraft } from "./hooks/useBillDraft";
import { useItemSearch } from "./hooks/useItemSearch";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import SearchDropdown from "./components/SearchDropdown";
import BillTable from "./components/BillTable";
import PrintBill from "./components/print/PrintBill";
import CustomerSection from "./components/CustomerSection";
import { recalcItem } from "./pricing/resolver";
import { showToast } from "./utils/toast";
import {
  fetchNextBillNo as apiFetchNextBillNo,
  fetchBill,
  saveBill as apiSaveBill,
  lookupBarcode,
  fetchStoreRestock,
} from "./services/api";
import { formatPrice, getISTNow } from "./utils/formatting";
import { normalizePhone, isValidPhone, phoneForWhatsApp } from "./utils/phone";
import type { BillItem, RetrievedBill } from "./types";

// print/image helpers [self-contained]

async function svgToPngDataUrl(svgUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 480;
      c.height = img.naturalHeight || 240;
      c.getContext("2d")!.drawImage(img, 0, 0);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = svgUrl;
  });
}

async function captureBillImage(): Promise<Blob | null> {
  const billEl = document.getElementById("print-bill");
  if (!billEl) return null;
  const logoEl = billEl.querySelector<HTMLImageElement>("img[alt='logo']");
  const originalSrc = logoEl?.src ?? "";
  const noPrint = billEl.querySelectorAll<HTMLElement>(".no-print");
  const printOnly = billEl.querySelectorAll<HTMLElement>(".print-only");
  try {
    if (logoEl) {
      try { logoEl.src = await svgToPngDataUrl("/logo.svg"); await new Promise(r => setTimeout(r, 100)); } catch {}
    }
    noPrint.forEach(el => (el.style.display = "none"));
    printOnly.forEach(el => (el.style.display = "inline"));
    await new Promise(r => setTimeout(r, 50));
    const canvas = await html2canvas(billEl, { scale: 2, backgroundColor: "#ffffff", useCORS: true, allowTaint: true, logging: false, imageTimeout: 0 });
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  } finally {
    noPrint.forEach(el => (el.style.display = ""));
    printOnly.forEach(el => (el.style.display = "none"));
    if (logoEl) logoEl.src = originalSrc;
  }
}

// app
export default function App() {
  // store
  const store = useBillingStore();
  const totals = useBillTotals();
  const { displayBillNo, displayBillDate, displayBillTime } = useDisplayBillMeta();

  // hooks
  const { clearDraft } = useBillDraft();
  const search = useItemSearch();

  // local ui area
  const [barcode, setBarcode] = useState("");
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [restockLoading, setRestockLoading] = useState(false);
  const [showBillRetrieval, setShowBillRetrieval] = useState(false);
  const [billSearchNo, setBillSearchNo] = useState("");
  const [retrievedBill, setRetrievedBill] = useState<RetrievedBill | null>(null);
  const [billRetrievalLoading, setBillRetrievalLoading] = useState(false);

  // refs
  const itemRef = useRef<HTMLInputElement>(null);
  const shadeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // bill no refresh
  const refreshBillNo = () => {
    if (store.editingBillNo) return;
    apiFetchNextBillNo().then(n => store.setNextBillNo(n)).catch(() => store.setNextBillNo(1));
  };

  useEffect(() => {
    refreshBillNo();
    const interval = setInterval(refreshBillNo, 30000);
    return () => clearInterval(interval);
  }, [store.editingBillNo]);

  useEffect(() => {
    const handle = () => { 
      if (!store.editingBillNo) { 
        refreshBillNo();
        const { date, time } = getISTNow();
        store.setBillTime(time);
        store.setBillDate(date);
      }
    };
    window.addEventListener("focus", handle);
    return () => window.removeEventListener("focus", handle);
  }, [store.editingBillNo]);

  useEffect(() => {
    if (store.editingBillNo) return;
    const interval = setInterval(() => {
      const { date, time } = getISTNow();
      store.setBillTime(time);
      store.setBillDate(date);
    }, 60000);
    return () => clearInterval(interval);
  }, [store.editingBillNo]);

  // points
  useEffect(() => {
    import("./services/api").then(({ fetchPointsConfig }) =>
      fetchPointsConfig().then(store.setPointsConfig)
    );
  }, []);

  // derived phone no
  const isPhoneValid = isValidPhone(store.phone);

  // add item
  const addItem = async (fromBarcode = false) => {
    const { entryItem, entryShade, entryQty, entryPrice, entryCost } = store;
    if (!entryItem?.trim()) { showToast("Enter item name", "error"); return; }
    if (entryQty <= 0) { showToast("Quantity must be > 0", "error"); return; }
    const priceNum = Number(entryPrice);
    if (isNaN(priceNum) || priceNum <= 0) { showToast("Enter valid price (> 0)", "error"); return; }
    const costNum = Number(entryCost) || 0;

    const itemExists = search.allItems.some(i => i.toLowerCase() === entryItem.toLowerCase());
    let shadeIsValid = false, isMisc = false;

    if (itemExists) {
      const shadesList = await search.getShadesForItem(entryItem);
      shadeIsValid = shadesList.some(s => s.toLowerCase() === entryShade.toLowerCase());
      isMisc = !shadeIsValid;
    } else {
      isMisc = true;
    }

    const finalShade = entryShade || (isMisc ? "Misc" : "");
    if (itemExists && !isMisc && !finalShade) { showToast("Select a shade", "error"); return; }

    const newItem: BillItem = recalcItem({
      item: entryItem,
      shade: finalShade,
      qty: entryQty,
      cost: costNum,
      price: priceNum,
      originalPrice: priceNum,
      misc: isMisc,
      total: 0,
      profit: 0,
      priceOverridden: false,
    });

    store.addItem(newItem);
    store.clearEntryForm();

    setTimeout(() => (fromBarcode ? barcodeRef.current : itemRef.current)?.focus(), 50);
  };

  // barcode scanning
  const handleBarcodeScan = async () => {
    const code = barcode.trim();
    if (!code) return;
    setBarcodeLoading(true);
    try {
      const data = await lookupBarcode(code);
      store.setEntryItem(data.item);
      store.setEntryShade(data.shade);
      store.setEntryPrice(String(data.price || ""));
      setBarcode("");
      await addItem(true);
    } catch (err: any) {
      showToast(err.message || "Failed to lookup barcode", "error");
      setBarcode("");
    } finally {
      setBarcodeLoading(false);
      barcodeRef.current?.focus();
    }
  };

  // save bill
  const saveBill = async (): Promise<boolean> => {
    if (store.items.length === 0 || store.saving) return false;
    if (!isPhoneValid) { showToast("Enter 10-digit phone", "error"); return false; }
    if (store.customerType === "courier" && Number(store.courierCharges) <= 0) {
      showToast("Courier charges required for courier orders", "error"); return false;
    }
    store.setSaving(true);
    store.setSavingProgress(true);
    try {
      const payload = {
        items: store.items.map(i => ({ ...i, total: i.qty * i.price, profit: i.profit })),
        finalTotal: totals.finalTotal,
        courierCharges: store.customerType === "courier" ? Number(store.courierCharges) : 0,
        gpayCharges: store.paymentMode === "GPay" ? totals.gpayCharge : null,
        paymentMode: store.paymentMode,
        billDate: store.billDate,
        billTime: store.billTime,
        customer: {
          name: store.customerName,
          phone: normalizePhone(store.phone),
          phone2: store.phone2,
          type: store.customerType,
          courier: store.customerType === "courier",
        },
        earnRate: store.pointsConfig?.earnRate ?? 0,
        redeemRate: store.pointsConfig?.redeemRate ?? 0,
        ...(store.editingBillNo ? {
          originalBillNo: store.editingBillNo,
          originalDate: store.originalBillDate,
          originalTime: store.originalBillTime,
          originalRowIndexes: store.originalRowIndexes,
        } : {}),
      };

      const response = await apiSaveBill(payload);
      
      // validate response has required data
      if (!response?.billNo) {
        throw new Error("Save failed: No bill number returned");
      }
      
      search.clearCaches();
      clearDraft();
      store.resetBill();
      refreshBillNo();
      
      // Show fallback usage toasts if any
      if (response?.fallbackUsage && response.fallbackUsage.length > 0) {
        for (const fallback of response.fallbackUsage) {
          const msg = `Loft fallback used for ${fallback.item}${fallback.shade ? ` (${fallback.shade})` : ''}`;
          showToast(msg, "info");
        }
      }
      
      showToast(`Bill #${response.billNo} saved!`, "success");
      return true;
    } catch (err: any) {
      showToast(err.message, "error");
      return false;
    } finally {
      store.setSaving(false);
      store.setSavingProgress(false);
    }
  };

  // send through whatsapp
  const sendWhatsApp = async () => {
    if (!store.phone || store.items.length === 0) return;
    if (!isPhoneValid) { showToast("Invalid phone number", "error"); return; }
    const blob = await captureBillImage();
    if (!blob) { showToast("Failed to capture image", "error"); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("Bill image copied. Paste in WhatsApp.", "success");
    } catch {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `bill-${store.nextBillNo ?? "draft"}.png`; a.click();
      URL.revokeObjectURL(url);
      showToast("Image downloaded. Attach in WhatsApp.", "info");
    }
    window.open(`https://wa.me/${phoneForWhatsApp(store.phone)}`, "_blank", "noopener,noreferrer");
  };

  const saveBillAndSend = async () => {
    if (!isPhoneValid || store.items.length === 0 || store.saving) return;
    if (store.customerType === "courier" && Number(store.courierCharges) <= 0) {
      showToast("Courier charges required", "error"); return;
    }
    store.setSavingProgress(true);
    const blob = await captureBillImage();
    let copied = false;
    if (blob) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch {}
    }
    const saved = await saveBill();
    if (!saved) { store.setSavingProgress(false); return; }
    window.open(`https://wa.me/${phoneForWhatsApp(store.phone)}`, "_blank", "noopener,noreferrer");
    showToast(copied ? "Bill copied. Paste in WhatsApp." : "Please attach image manually.", copied ? "success" : "info");
    store.setSavingProgress(false);
  };

  // retrieve bill
  const retrieveBill = async (billNo: number) => {
    if (billNo <= 0) { showToast("Enter valid bill number", "error"); return; }
    setBillRetrievalLoading(true);
    try {
      const bill = await fetchBill(billNo);
      setRetrievedBill(bill);
      showToast(`Bill #${billNo} retrieved`, "success");
    } catch (err: any) {
      showToast(err.message, "error");
      setRetrievedBill(null);
    } finally {
      setBillRetrievalLoading(false);
    }
  };

  const loadBillForEdit = (bill: RetrievedBill) => {
    store.updateItems(bill.items.map(it => recalcItem({ ...it, cost: it.cost || 0, originalPrice: it.price, priceOverridden: false })));
    store.setCustomerName(bill.customerName);
    store.setPhone(bill.customerPhone);
    store.setPhone2(bill.customerPhone2 || "");
    store.setCourierCharges(bill.courierCharges ? String(bill.courierCharges) : "");
    store.setCustomerType(Number(bill.courierCharges) > 0 ? "courier" : "walk-in");
    store.setPaymentMode(bill.paymentMode || "Cash");
    store.setBillDate(bill.date);
    store.setBillTime(bill.time);
    store.setEditingBill(bill.billNo, bill.date, bill.time, bill.originalRowIndexes);
    store.setCustomer(null);
    setShowBillRetrieval(false);
    showToast("Bill loaded. Edit and re-save.", "success");
  };

  // restock
  const generateStoreRestock = async () => {
    const input = window.prompt("Enter item name (or 'all'):");
    if (!input?.trim()) return;
    setRestockLoading(true);
    try {
      const data = await fetchStoreRestock(input.trim());
      if (!data.message) { showToast(data.summary || "No restock needed", "info"); return; }
      if (window.confirm(`Restock Summary:\n${data.summary}\n\nOpen WhatsApp?`) && data.waLink) {
        window.open(data.waLink, "_blank", "noopener,noreferrer");
      }
    } catch (err: any) {
      showToast(err.message || "Unknown error", "error");
    } finally {
      setRestockLoading(false);
    }
  };

  // keyboard
  useKeyboardShortcuts({
    onSaveBill: saveBill,
    onSaveBillAndSend: saveBillAndSend,
  });

  // rendering
  return (
    <div style={styles.container}>
      <style>{globalStyles}</style>
      <Toaster richColors position="top-right" closeButton />

      {/* delete confirm */}
      {store.deleteConfirmIdx !== null && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 800 }}>Delete Item?</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#64748b" }}>
              Delete "<strong>{store.items[store.deleteConfirmIdx]?.item}</strong>"? You can undo.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={store.cancelDelete} style={styles.cancelBtn}>Cancel</button>
              <button onClick={() => {
                if (store.deleteConfirmIdx !== null) {
                  store.removeItem(store.deleteConfirmIdx);
                  showToast("Item removed (Undo available)", "info");
                }
              }} style={styles.deleteBtn}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <h1 className="no-print" style={styles.title}>Billing Counter</h1>
      <div className="no-print" style={styles.shortcuts}>
        <span style={{ fontWeight: 700, textTransform: "uppercase" }}>Shortcuts:</span> Enter to add • Tab autocomplete • Ctrl+S save • Ctrl+Enter save & send
      </div>

      {/* entry form */}
      <div className="no-print" style={styles.card}>
        {/* barcode row */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input
            ref={barcodeRef}
            type="text"
            value={barcode}
            onChange={e => setBarcode(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleBarcodeScan(); } }}
            placeholder="Scan Barcode..."
            style={styles.input}
            disabled={barcodeLoading}
          />
          {barcodeLoading && <span>⌛</span>}
        </div>

        {/* item/shade/qty/price row */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <SearchDropdown
            value={store.entryItem}
            onChange={store.setEntryItem}
            onSelect={val => {
              store.setEntryItem(val);
              setTimeout(() => (search.isStandard ? qtyRef.current : shadeRef.current)?.focus(), 50);
            }}
            options={search.filteredItems}
            suggestion={search.itemSuggestion && store.entryItem !== search.itemSuggestion ? search.itemSuggestion : null}
            placeholder="Item..."
            style={styles.input}
            inputRef={itemRef}
            autoFocus
          />

          {!search.isStandard && (
            <SearchDropdown
              value={store.entryShade}
              onChange={store.setEntryShade}
              onSelect={val => {
                store.setEntryShade(val);
                setTimeout(() => qtyRef.current?.focus(), 50);
              }}
              options={search.filteredShades}
              suggestion={!search.allShadesNumeric && search.shadeSuggestion && store.entryShade !== search.shadeSuggestion ? search.shadeSuggestion : null}
              placeholder="Shade/Variant..."
              style={styles.input}
              inputRef={shadeRef}
            />
          )}

          <input
            ref={qtyRef}
            type="text"
            inputMode="numeric"
            min="1"
            value={store.entryQty}
            onChange={e => store.setEntryQty(Number(e.target.value))}
            onKeyDown={e => {
              // Allow ArrowUp, ArrowDown, Escape to propagate for navigation
              if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Escape") {
                return; // Don't prevent - let it bubble up
              }
            }}
            placeholder="Qty"
            style={{ ...styles.input, maxWidth: 80 }}
          />

          <input
            ref={priceRef}
            type="text"
            inputMode="decimal"
            value={store.entryPrice}
            onChange={e => store.setEntryPrice(e.target.value)}
            onKeyDown={e => {

              if (e.key === "Tab" || (e.ctrlKey && (e.key.toLowerCase() === "s" || e.key === "Enter"))) {
                return; // Don't prevent - let it bubble up
              }
            }}
            placeholder="Price"
            style={{ ...styles.input, maxWidth: 100 }}
          />

          <button style={styles.button} onClick={() => addItem(false)}>Add</button>
        </div>

        {store.entryItem && !search.isKnownItem && (
          <span style={{ fontSize: 11, color: "#e67e22", marginTop: 4, display: "block" }}>
            (New item – no stock deduction)
          </span>
        )}
      </div>

      {/* print bill - always in DOM so html2canvas can capture it */}
      <PrintBill
        id="print-bill"
        items={store.items}
        customerName={store.customerName}
        phone={store.phone}
        customer={store.customer}
        billNo={displayBillNo}
        billDate={displayBillDate}
        billTime={displayBillTime}
        courierCharges={totals.subtotalWithCourier - totals.grandTotal}
        gpayCharges={totals.gpayCharge}
        finalTotal={totals.finalTotal}
        paymentMode={store.paymentMode}
      >
        {/* augmented table with live editing controls */}
        <table className="bill-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 4, border: "1px solid #0f172a" }}>
          <thead>
            <tr style={{ backgroundColor: "#f0f1f3" }}>
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
            <BillTable shadeCache={search.shadeCache} allItems={search.allItems} />
          </tbody>
        </table>
      </PrintBill>

      {/* change to tender */}
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, gap: 16, alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Cash Received:</span>
        <input
          type="text"
          inputMode="decimal"
          value={store.amountReceived}
          onChange={e => store.setAmountReceived(e.target.value)}
          style={{ width: 100, padding: "6px 10px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 0, outline: "none", textAlign: "right" }}
        />
        {totals.changeAmount > 0 && (
          <span style={{ fontSize: 13, fontWeight: 700, color: "#10b981" }}>
            Change: ₹{formatPrice(totals.changeAmount)}
          </span>
        )}
      </div>

      {/* customer section */}
      <div className="no-print">
        <CustomerSection />
      </div>

      {/* action buttons */}
      <div className="no-print" style={styles.actions}>
        {store.lastDeletedItem && (
          <button style={{ ...styles.actionBtn, background: "#8b5cf6" }} onClick={() => { store.undoDelete(); showToast("Item restored", "success"); }}>
            ↶ Undo Delete
          </button>
        )}
        <button style={{ ...styles.actionBtn, background: "#8b5cf6" }} onClick={() => setShowBillRetrieval(v => !v)}>🔍 Retrieve Bill</button>
        <button style={{ ...styles.actionBtn, background: "#22e6ae" }} onClick={generateStoreRestock} disabled={restockLoading}>📋 Store Restock</button>
        <button style={{ ...styles.actionBtn, background: "#25D366" }} onClick={sendWhatsApp} disabled={!isPhoneValid || store.items.length === 0}>📲 Send Bill</button>
        <button style={styles.actionBtn} onClick={() => window.print()}>🖨 Print</button>
        <button
          style={{ ...styles.actionBtn, opacity: store.savingProgress || store.items.length === 0 || !isPhoneValid ? 0.6 : 1 }}
          onClick={saveBill}
          disabled={store.savingProgress || store.items.length === 0 || !isPhoneValid}
        >
          {store.savingProgress ? "⏳ Saving..." : "💾 Save"}
        </button>
        <button
          style={{ ...styles.actionBtn, background: "#0a6ed1", opacity: store.savingProgress || store.items.length === 0 || !isPhoneValid ? 0.6 : 1 }}
          onClick={saveBillAndSend}
          disabled={store.savingProgress || store.items.length === 0 || !isPhoneValid}
        >
          {store.savingProgress ? "⏳ Saving..." : "💾📲 Save & Send"}
        </button>
      </div>

      {/* bill retrieval panel */}
      {showBillRetrieval && (
        <div className="no-print" style={styles.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>🔍 Retrieve Previous Bill</h3>
            <button onClick={() => setShowBillRetrieval(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#666" }}>✕</button>
          </div>
          <form
            onSubmit={e => {
              e.preventDefault();
              retrieveBill(Number(billSearchNo));
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              type="number"
              min="1"
              value={billSearchNo}
              onChange={e => setBillSearchNo(e.target.value)}
              placeholder="Enter bill number..."
              style={{ flex: 1, padding: "8px 10px", fontSize: 13, border: "1px solid #cbd5e1", borderRadius: 4, outline: "none" }}
            />
            <button
              type="submit"
              disabled={billRetrievalLoading}
              style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, background: billRetrievalLoading ? "#ccc" : "#8b5cf6", color: "#fff", border: "none", borderRadius: 4, cursor: billRetrievalLoading ? "not-allowed" : "pointer" }}
            >
              {billRetrievalLoading ? "⏳" : "Search"}
            </button>
          </form>
          {retrievedBill && (
            <div style={{ marginTop: 12, padding: 12, background: "#f9fafb", borderRadius: 4, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Bill #{retrievedBill.billNo}</div>
              <div><strong>Customer:</strong> {retrievedBill.customerName} ({retrievedBill.customerId})</div>
              <div><strong>Phone:</strong> {retrievedBill.customerPhone}</div>
              <div><strong>Date:</strong> {retrievedBill.date} {retrievedBill.time}</div>
              <div style={{ fontWeight: 700, marginTop: 8, borderTop: "1px solid #e5e7eb", paddingTop: 8 }}>Items:</div>
              {retrievedBill.items.map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", paddingBottom: 4, borderBottom: "1px solid #e5e7eb" }}>
                  <span>{it.item} ({it.shade}) × {it.qty}</span>
                  <span>₹{formatPrice(it.total)}</span>
                </div>
              ))}
              <div style={{ marginTop: 8, fontWeight: 700, display: "flex", justifyContent: "space-between" }}>
                <span>Final Total:</span><span>₹{formatPrice(retrievedBill.finalTotal)}</span>
              </div>
              {(retrievedBill.gpayCharges ?? 0) > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", color: "#dc2626", fontSize: 12 }}>
                  <span>GPay Charges (2%):</span><span>₹{formatPrice(retrievedBill.gpayCharges!)}</span>
                </div>
              )}
              <button
                onClick={() => loadBillForEdit(retrievedBill)}
                style={{ marginTop: 12, padding: "8px 12px", width: "100%", fontSize: 13, fontWeight: 600, background: "#10b981", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
              >
                📋 Load for Edit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// styles
const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 900, margin: "28px auto", fontFamily: "'Montserrat', sans-serif", background: "#f8f9fb", padding: 28 },
  title: { textAlign: "center", marginBottom: 28, fontWeight: 800, fontSize: 32, letterSpacing: "-1px", color: "#0f172a", textTransform: "uppercase" },
  shortcuts: { textAlign: "center", fontSize: 11, color: "#64748b", marginBottom: 20, letterSpacing: "0.3px" },
  card: { background: "#fff", padding: 24, borderRadius: 0, marginBottom: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" },
  input: { flex: 1, padding: "12px 14px", fontSize: 14, borderRadius: 0, border: "1px solid #cbd5e1", outline: "none", background: "#fbfcfd", fontWeight: 500 },
  button: { padding: "12px 24px", fontSize: 13, fontWeight: 700, borderRadius: 0, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer", whiteSpace: "nowrap", letterSpacing: "0.3px" },
  th: { padding: "6px 4px", color: "#334155", fontWeight: 800, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.8px", textAlign: "left", borderBottom: "1px solid #0f172a" },
  actions: { display: "flex", gap: 10, marginTop: 24, justifyContent: "flex-end", flexWrap: "wrap" },
  actionBtn: { padding: "12px 24px", fontSize: 12, fontWeight: 700, borderRadius: 0, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer", letterSpacing: "0.3px", textTransform: "uppercase" },
  toast: { position: "fixed", bottom: 24, right: 24, color: "#fff", padding: "14px 20px", borderRadius: 0, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 13, fontWeight: 600, zIndex: 9999, maxWidth: 300, animation: "slideIn 0.3s ease" },
  overlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9998 },
  modal: { background: "#fff", padding: 24, borderRadius: 0, boxShadow: "0 10px 40px rgba(0,0,0,0.2)", maxWidth: 400 },
  cancelBtn: { padding: "10px 18px", fontSize: 12, fontWeight: 700, border: "1px solid #cbd5e1", background: "#f1f5f9", color: "#334155", cursor: "pointer", borderRadius: 0 },
  deleteBtn: { padding: "10px 18px", fontSize: 12, fontWeight: 700, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", borderRadius: 0 },
};

const globalStyles = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
* { font-family: 'Montserrat', sans-serif; }
.bill-table { border-left: 1px solid #c5cad1 !important; border-right: 1px solid #c5cad1 !important; }
.bill-table th, .bill-table td { border-right: 1px solid #c5cad1 !important; }
input:focus { outline: none; box-shadow: 0 0 0 3px rgba(26,26,26,0.1); border-color: #1a1a1a !important; }
button:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
button:active:not(:disabled) { transform: translateY(0); }
@keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@page { size: A4 portrait; margin: 1cm; }
@media print {
  .no-print { display: none !important; }
  .print-only { display: inline !important; }
  html, body { margin: 0; padding: 0; background: white; }
  .app-container { background: white; box-shadow: none; margin: 0; padding: 0; }
  #print-bill { width: 100%; border: 1.5px solid #000 !important; box-shadow: none; border-radius: 0; padding: 12px 16px; box-sizing: border-box; }
}
`;