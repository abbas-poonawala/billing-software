import { useState, useEffect, useRef, useMemo } from "react";
import Fuse from "fuse.js";
import html2canvas from "html2canvas";

type BillItem = {
  item: string;
  shade: string;
  qty: number;
  cost: number;
  price: number;
  originalPrice?: number;
  total: number;
  profit: number;
  misc?: boolean;
  priceOverridden?: boolean;
};

type Customer = { customerId: string; name: string; phone: string; phone2?: string; points: number; totalSpend: number; totalBills: number };
type PointsConfig = { earnRate: number; redeemRate: number; minRedeem: number };

export default function App() {
  const [items, setItems] = useState<BillItem[]>([]);
  const [allItems, setAllItems] = useState<string[]>([]);
  const [shades, setShades] = useState<string[]>([]);
  const [item, setItem] = useState("");
  const [shade, setShade] = useState("");
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [warnedKey, setWarnedKey] = useState<string | null>(null);
  const [nextBillNo, setNextBillNo] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [pointsConfig, setPointsConfig] = useState<PointsConfig | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(false);
  const [restockLoading, setRestockLoading] = useState(false);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [barcode, setBarcode] = useState("");
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [lastDeletedItem, setLastDeletedItem] = useState<BillItem | null>(null);
  const [lastDeletedIdx, setLastDeletedIdx] = useState<number | null>(null);
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [savingProgress, setSavingProgress] = useState(false);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const shadeCache = useRef<Record<string, string[]>>({});
  const priceCache = useRef<Record<string, { price: number; qty: number }>>({});
  const itemRef = useRef<HTMLInputElement>(null);
  const shadeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const [editingShadeRow, setEditingShadeRow] = useState<number | null>(null);
  const [editingShadeValue, setEditingShadeValue] = useState("");
  const [editShadeSuggestion, setEditShadeSuggestion] = useState<string | null>(null);
  const [validatingShade, setValidatingShade] = useState(false);
  const [customerSearchResults, setCustomerSearchResults] = useState<Customer[]>([]);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [printPreview, setPrintPreview] = useState(false);
  const [courierCharges, setCourierCharges] = useState("");
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [itemDropdownIndex, setItemDropdownIndex] = useState(-1);
  const [showShadeDropdown, setShowShadeDropdown] = useState(false);
  const [shadeDropdownIndex, setShadeDropdownIndex] = useState(-1);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [customerDropdownIndex, setCustomerDropdownIndex] = useState(-1);
  const [customerType, setCustomerType] = useState<"walk-in" | "courier">("walk-in");
  const [showBillRetrieval, setShowBillRetrieval] = useState(false);
  const [billSearchNo, setBillSearchNo] = useState("");
  const [retrievedBill, setRetrievedBill] = useState<any>(null);
  const [billRetrievalLoading, setBillRetrievalLoading] = useState(false);
  const [editingBillNo, setEditingBillNo] = useState<number | null>(null);
  const [originalBillDate, setOriginalBillDate] = useState("");
  const [originalBillTime, setOriginalBillTime] = useState("");
  const [originalRowIndexes, setOriginalRowIndexes] = useState<number[]>([]);
  const [amountReceived, setAmountReceived] = useState("");
  const [editingPriceRow, setEditingPriceRow] = useState<number | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState("");
  const [editShadeFilteredList, setEditShadeFilteredList] = useState<string[]>([]);
  const [editShadeDropdownIndex, setEditShadeDropdownIndex] = useState(-1);

  const recalcItem = (i: BillItem): BillItem => {
    const q = Number(i.qty) || 0;
    const p = Number(i.price) || 0;
    const c = Number(i.cost) || 0;
    const total = q * p;
    const profit = total - (c * q);
    return { ...i, total, profit };
  };

  const formatPrice = (price: number): string => {
    const num = Number(price) || 0;
    if (Number.isInteger(num)) {
      return num.toString();
    }
    return num.toFixed(2).replace(/\.?0+$/, '');
  };

  editShadeSuggestion;

  const applyTriosoftPricing = (itemsList: BillItem[]): BillItem[] => {
    // Get all non-overridden triosoft items
    const triosoftItems = itemsList
      .map((i, idx) => ({ item: i, idx }))
      .filter(x => x.item.item.toLowerCase() === "triosoft" && !x.item.priceOverridden);
    
    if (triosoftItems.length === 0) {
      return itemsList.map(i => recalcItem(i));
    }

    // Calculate total qty and how many should get ₹110 (complete groups of 6)
    const totalTriosoftQty = triosoftItems.reduce((sum, x) => sum + x.item.qty, 0);
    const qty110 = Math.floor(totalTriosoftQty / 6) * 6;

    // Assign prices: items are assigned ₹110 until we run out of qty110 slots
    let slots110Remaining = qty110;
    const updated = [...itemsList];
    
    for (const { item: trioItem, idx } of triosoftItems) {
      const price = slots110Remaining >= trioItem.qty ? 110 : 120;
      updated[idx] = {
        ...trioItem,
        price: price,
        originalPrice: trioItem.originalPrice || trioItem.price
      };
      slots110Remaining -= trioItem.qty;
    }

    return updated.map(i => recalcItem(i));
  };

  const updateItems = (newItems: BillItem[]) => {
    setItems(applyTriosoftPricing(newItems));
  };

  const courierChargesNum = Number(courierCharges) || 0;
  const amountReceivedNum = Number(amountReceived) || 0;
  const grandTotal = items.reduce((sum, i) => sum + i.total, 0);
  const finalTotal = grandTotal + courierChargesNum;
  const changeAmount = amountReceivedNum > finalTotal ? amountReceivedNum - finalTotal : 0;

  const validateRecoveredPrices = async (recoveredItems: any[]) => {
    const changes: string[] = [];
    const validatedItems = await Promise.all(
      recoveredItems.map(async (it) => {
        if (!it.misc && allItems.includes(it.item)) {
          try {
            const priceRes = await fetch(`/api/core?action=getPrice&item=${encodeURIComponent(it.item)}&shade=${encodeURIComponent(it.shade)}`);
            const priceData = await priceRes.json();
            const currentPrice = priceData.price || it.price;
            if (currentPrice !== it.price) {
              changes.push(`${it.item}: ₹${formatPrice(it.price)} → ₹${formatPrice(currentPrice)}`);
              return { ...it, price: currentPrice, total: it.qty * currentPrice, priceOverridden: false };
            }
          } catch (err) { console.error(err); }
        }
        return { ...it, priceOverridden: false };
      })
    );
    return { items: validatedItems, isValid: changes.length === 0, changes };
  };

  // auto-save draft
  useEffect(() => {
    if (items.length > 0) {
      const draft = { items, customerName, phone, phone2, redeemPoints, courierCharges, customerType };
      localStorage.setItem("billDraft", JSON.stringify(draft));
    }
  }, [items, customerName, phone, phone2, redeemPoints, courierCharges, customerType]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // recover draft
  useEffect(() => {
    const draft = localStorage.getItem("billDraft");
    if (draft) {
      try {
        const { items: draftItems, customerName: draftName, phone: draftPhone, phone2: draftPhone2, redeemPoints: draftRedeem, courierCharges: draftCourier, customerType: draftType } = JSON.parse(draft);
        if (draftItems?.length > 0) {
          const shouldRecover = window.confirm("You have an unsaved bill. Recover?");
          if (shouldRecover) {
            validateRecoveredPrices(draftItems).then(res => {
              if (!res.isValid) setToast({ message: `⚠️ Price changes: ${res.changes.join(", ")}`, type: "info" });
              updateItems(res.items);
            });
            setCustomerName(draftName || "");
            setPhone(draftPhone || "");
            setPhone2(draftPhone2 || "");
            setRedeemPoints(draftRedeem || false);
            setCourierCharges(draftCourier ? String(draftCourier) : "");
            setCustomerType(draftType === "courier" ? "courier" : "walk-in");
            setToast({ message: "Bill recovered from draft", type: "success" });
          } else localStorage.removeItem("billDraft");
        }
      } catch (err) { console.error(err); }
    }
  }, []);

  // Fetch price when shade or item changes
  useEffect(() => {
    if (!item) return;
    (async () => {
      const fetchedPrice = await fetchPrice(item, shade);
      if (fetchedPrice !== null && fetchedPrice > 0) {
        setPrice(String(fetchedPrice));
      }
    })();
  }, [shade, item]);

  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => setToast({ message: msg, type });

  const confirmDeleteItem = (idx: number) => setDeleteConfirmIdx(idx);
  const cancelDelete = () => setDeleteConfirmIdx(null);
  const undoDelete = () => {
    if (lastDeletedItem !== null && lastDeletedIdx !== null) {
      const updated = [...items];
      updated.splice(lastDeletedIdx, 0, lastDeletedItem);
      updateItems(updated);
      setLastDeletedItem(null);
      setLastDeletedIdx(null);
      setSelectedRow(null);
      showToast("Item restored", "success");
    }
  };

  const startEditShade = (idx: number, currentShade: string) => {
    if (validatingShade) return;
    setEditingShadeRow(idx);
    setEditingShadeValue(currentShade);
    setEditShadeSuggestion(null);
  };

  const saveEditShade = async (idx: number) => {
    const newShade = editingShadeValue.trim();
    if (!newShade) { alert("Shade cannot be empty"); return; }
    const itemName = items[idx].item;
    setValidatingShade(true);
    try {
      let shadesList: string[] = [];
      if (shadeCache.current[itemName]) shadesList = shadeCache.current[itemName];
      else {
        const res = await fetch(`/api/core?action=getShades&item=${encodeURIComponent(itemName)}`);
        const data = await res.json();
        shadesList = data.shades || [];
        shadeCache.current[itemName] = shadesList;
      }
      const matched = shadesList.find(s => s.toLowerCase() === newShade.toLowerCase());
      if (!matched) {
        alert(`"${newShade}" not valid. Available: ${shadesList.join(", ")}`);
        setEditingShadeRow(null);
        setEditingShadeValue("");
        return;
      }
      let newPrice = items[idx].price, newCost = items[idx].cost;
      try {
        const priceRes = await fetch(`/api/core?action=getPrice&item=${encodeURIComponent(itemName)}&shade=${encodeURIComponent(matched)}`);
        const priceData = await priceRes.json();
        newPrice = priceData.price || items[idx].price;
      } catch (err) { console.error(err); }
      try {
        const costRes = await fetch(`/api/core?action=getCost&item=${encodeURIComponent(itemName)}&shade=${encodeURIComponent(matched)}`);
        const costData = await costRes.json();
        newCost = costData.cost || items[idx].cost;
      } catch (err) { console.error(err); }
      const updated = [...items];
      updated[idx] = recalcItem({ ...updated[idx], shade: matched, price: newPrice, cost: newCost, priceOverridden: false });
      updateItems(updated);
      setEditingShadeRow(null);
      setEditingShadeValue("");
    } catch (err) {
      console.error(err);
      alert("Could not validate shade.");
    } finally { setValidatingShade(false); }
  };

  const cancelEditShade = () => {
    if (validatingShade) return;
    setEditingShadeRow(null);
    setEditingShadeValue("");
    setEditShadeFilteredList([]);
    setEditShadeDropdownIndex(-1);
  };

  const startEditPrice = (idx: number, currentPrice: number) => {
    setEditingPriceRow(idx);
    setEditingPriceValue(String(currentPrice));
  };

  const saveEditPrice = (idx: number) => {
    const newPrice = Number(editingPriceValue);
    if (isNaN(newPrice) || newPrice <= 0) {
      alert("Price must be > 0");
      return;
    }
    const updated = [...items];
    updated[idx] = recalcItem({ ...updated[idx], price: newPrice, priceOverridden: true });
    updateItems(updated);
    setEditingPriceRow(null);
    setEditingPriceValue("");
  };

  const cancelEditPrice = () => {
    setEditingPriceRow(null);
    setEditingPriceValue("");
  };

  const [billDate] = useState(() => new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }));
  const [billTime, setBillTime] = useState(() => new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }));

  const displayBillNo = editingBillNo ?? nextBillNo;
  const displayBillDate = editingBillNo ? (originalBillDate || billDate) : billDate;
  const displayBillTime = editingBillNo ? (originalBillTime || billTime) : billTime;

  const normalizedPhone = phone.replace(/[^0-9]/g, "");
  const isPhoneValid = normalizedPhone.length >= 10;
  const phoneWithCountryCode = () => {
    if (!phone.trim()) return "";
    if (phone.startsWith("+")) return phone; // already has country code
    return `+91${normalizedPhone.slice(-10)}`; // prepend +91, take last 10 digits
  };

  const fetchNextBillNo = () => {
    fetch("/api/bill")
      .then(res => res.json())
      .then(data => setNextBillNo((data.billNo || 0) + 1))
      .catch(() => setNextBillNo(1));
  };

  const searchCustomersByName = async (name: string) => {
    if (name.trim().length < 2) { setCustomerSearchResults([]); setShowCustomerDropdown(false); return; }
    setCustomerSearchLoading(true);
    try {
      const res = await fetch(`/api/core?action=searchCustomersByName&name=${encodeURIComponent(name.trim())}`);
      const data = await res.json();
      setCustomerSearchResults(data.customers || []);
      setShowCustomerDropdown(data.customers?.length > 0);
    } catch { setCustomerSearchResults([]); setShowCustomerDropdown(false); }
    finally { setCustomerSearchLoading(false); }
  };

  const searchCustomersById = async (custId: string) => {
    if (custId.trim().length < 2) { setCustomer(null); return; }
    setCustomerSearchLoading(true);
    try {
      const res = await fetch(`/api/core?action=searchCustomersById&customerId=${encodeURIComponent(custId.trim())}`);
      const data = await res.json();
      if (data.customer) {
        setCustomer(data.customer);
        setCustomerName(data.customer.name);
        setPhone(data.customer.phone);
        setPhone2(data.customer.phone2 || "");
        setShowCustomerDropdown(false);
        showToast(`Customer found: ${data.customer.name}`, "success");
      } else { setCustomer(null); showToast("Customer ID not found", "error"); }
    } catch { setCustomer(null); showToast("Error searching customer", "error"); }
    finally { setCustomerSearchLoading(false); }
  };

  const searchCustomersByPhone = async (phoneVal: string) => {
    if (phoneVal.trim().length < 10) { setCustomer(null); return; }
    setCustomerSearchLoading(true);
    try {
      const res = await fetch(`/api/core?action=searchCustomersByPhone&phone=${encodeURIComponent(phoneVal.trim())}`);
      const data = await res.json();
      if (data.customer) {
        setCustomer(data.customer);
        setCustomerName(data.customer.name);
        setPhone(data.customer.phone);
        setPhone2(data.customer.phone2 || "");
        showToast(`Customer found: ${data.customer.name}`, "success");
      } else { setCustomer(null); }
    } catch { setCustomer(null); }
    finally { setCustomerSearchLoading(false); }
  };

  const selectCustomerFromSearch = (cust: Customer) => {
    setCustomer(cust);
    setCustomerName(cust.name);
    setPhone(cust.phone);
    setPhone2(cust.phone2 || "");
    setCustomerSearchResults([]);
    setShowCustomerDropdown(false);
    showToast(`Customer selected: ${cust.name}`, "success");
  };

  useEffect(() => {
    if (editingBillNo) return;
    fetchNextBillNo();
  }, [editingBillNo]);
  useEffect(() => {
    if (editingBillNo) return;
    const interval = setInterval(() => fetchNextBillNo(), 30000);
    return () => clearInterval(interval);
  }, [editingBillNo]);
  useEffect(() => {
    if (editingBillNo) return;
    const interval = setInterval(() => {
      setBillTime(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }));
    }, 60000);
    return () => clearInterval(interval);
  }, [editingBillNo]);
  useEffect(() => {
    const handleFocus = () => {
      if (editingBillNo) return;
      fetchNextBillNo();
      setBillTime(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }));
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [editingBillNo]);
  useEffect(() => {
    const cached = sessionStorage.getItem("allItems");
    if (cached) { setAllItems(JSON.parse(cached)); return; }
    fetch("/api/core?action=getItems")
      .then(res => res.json())
      .then(data => {
        setAllItems(data.items || []);
        sessionStorage.setItem("allItems", JSON.stringify(data.items || []));
      })
      .catch(console.error);
  }, []);
  useEffect(() => {
    fetch("/api/core?action=getPointsConfig")
      .then(res => res.json())
      .then(data => setPointsConfig(data.config || null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!item) { setShades([]); setShade(""); setPrice(""); setCost(""); return; }
    if (!allItems.includes(item)) { setShades([]); return; }
    if (shadeCache.current[item]) { setShades(shadeCache.current[item]); return; }
    fetch(`/api/core?action=getShades&item=${encodeURIComponent(item)}`)
      .then(res => res.json())
      .then(data => {
        const fetched = data.shades || [];
        shadeCache.current[item] = fetched;
        setShades(fetched);
      })
      .catch(console.error);
  }, [item, allItems]);
  useEffect(() => {
    if (shades.length === 1 && shades[0].toLowerCase() === "standard") setShade(shades[0]);
  }, [shades]);
  useEffect(() => {
    if (!item || !shade) return;
    if (!allItems.includes(item)) return;
    fetch(`/api/core?action=getCost&item=${encodeURIComponent(item)}&shade=${encodeURIComponent(shade)}`)
      .then(res => res.json())
      .then(data => setCost(String(data.cost || "")))
      .catch(() => setCost(""));
  }, [item, shade, allItems]);
  useEffect(() => {
    if (!item || !shade) return;
    if (!allItems.includes(item) || !shades.includes(shade)) return;
    const key = `${item}__${shade}`;
    if (priceCache.current[key]) {
      setPrice(String(priceCache.current[key].price));
      const sq = priceCache.current[key].qty;
      if (sq >= 0 && sq < 2 && warnedKey !== `${item}-${shade}`) {
        window.alert("Low stock for this shade. Check sheet.");
        setWarnedKey(`${item}-${shade}`);
      }
      return;
    }
    fetch(`/api/core?action=getPrice&item=${encodeURIComponent(item)}&shade=${encodeURIComponent(shade)}`)
      .then(res => res.json())
      .then(data => {
        const p = data.price || 0;
        const q = Number(data.qty ?? -1);
        priceCache.current[key] = { price: p, qty: q };
        setPrice(String(p));
        if (q >= 0 && q < 2 && warnedKey !== `${item}-${shade}`) {
          window.alert("Low stock for this shade. Check sheet.");
          setWarnedKey(`${item}-${shade}`);
        }
      })
      .catch(() => setPrice(""));
  }, [item, shade, shades, warnedKey, allItems]);

  const isStandard = shades.length === 1 && shades[0].toLowerCase() === "standard";
  const itemFuse = useMemo(() => new Fuse(allItems, { threshold: 0.6, distance: 50, includeScore: true, minMatchCharLength: 2 }), [allItems]);
  const shadeFuse = useMemo(() => new Fuse(shades, { threshold: 0.6, distance: 50, includeScore: true, minMatchCharLength: 2 }), [shades]);
  const itemSuggestion = item ? itemFuse.search(item)[0]?.item ?? null : null;
  const allShadesAreNumeric = shades.length > 0 && shades.every(s => /^\d+$/.test(s.trim()));
  let shadeSuggestion = null;
  if (shade && !allShadesAreNumeric) {
    const trimmed = shade.trim();
    const isNumeric = /^\d+$/.test(trimmed);
    if (isNumeric) shadeSuggestion = shades.find(s => s.trim().toLowerCase().startsWith(trimmed.toLowerCase())) || null;
    else shadeSuggestion = shadeFuse.search(shade)[0]?.item ?? null;
  }
  const selectItem = (val: string) => {
    setItem(val);
    setTimeout(() => isStandard ? qtyRef.current?.focus() : shadeRef.current?.focus(), 50);
  };
  const selectShade = (val: string) => {
    setShade(val);
    setTimeout(() => qtyRef.current?.focus(), 50);
  };
  const needsShadeDropdown = shades.length > 1;
  const filteredItems = item.trim() ? itemFuse.search(item).map(r => r.item).slice(0, 8) : allItems.slice(0, 8);

  const handleBarcodeScan = async () => {
    const code = barcode.trim();
    if (!code) return;
    setBarcodeLoading(true);
    try {
      const res = await fetch(`/api/lookupBarcode?barcode=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Product not found");
      setItem(data.item);
      setShade(data.shade);
      setPrice(String(data.price || ""));
      setBarcode("");
      addItem(true);
    } catch (err: any) {
      alert(err.message || "Failed to lookup barcode");
      setBarcode("");
    } finally {
      setBarcodeLoading(false);
      if (barcodeInputRef.current) barcodeInputRef.current.focus();
    }
  };

  useEffect(() => {
    const fields = [itemRef, shadeRef, qtyRef, priceRef];
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (isPhoneValid && items.length > 0 && !saving) saveBill(); return; }
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (isPhoneValid && items.length > 0 && !saving) saveBillAndSend(); return; }
      if (e.key === "ArrowRight" && tag === "INPUT") {
        const idx = fields.findIndex(r => r.current === target);
        if (idx !== -1 && idx < fields.length - 1) { e.preventDefault(); fields[idx + 1].current?.focus(); }
        return;
      }
      if (e.key === "ArrowLeft" && tag === "INPUT") {
        const idx = fields.findIndex(r => r.current === target);
        if (idx > 0) { e.preventDefault(); fields[idx - 1].current?.focus(); }
        return;
      }
      if (e.key === "ArrowDown" && tag !== "INPUT") { e.preventDefault(); setSelectedRow(prev => (prev === null ? 0 : Math.min(prev + 1, items.length - 1))); return; }
      if (e.key === "ArrowUp" && tag !== "INPUT") { e.preventDefault(); setSelectedRow(prev => (prev === null ? 0 : Math.max(prev - 1, 0))); return; }
      if (e.key === "Escape") { setSelectedRow(null); return; }
      if (e.key === "Tab") {
        if (target === barcodeInputRef.current && barcode) { e.preventDefault(); handleBarcodeScan(); return; }
        if (target === itemRef.current && itemSuggestion && item !== itemSuggestion) { e.preventDefault(); selectItem(itemSuggestion); return; }
        if (target === shadeRef.current && shadeSuggestion && shade !== shadeSuggestion && !allShadesAreNumeric) { e.preventDefault(); selectShade(shadeSuggestion); return; }
      }
      if (e.key !== "Enter") return;
      if (target === barcodeInputRef.current && barcode) { e.preventDefault(); handleBarcodeScan(); return; }
      if (target === itemRef.current) {
        if (itemSuggestion && item !== itemSuggestion) { e.preventDefault(); selectItem(itemSuggestion); }
        else if (item) { e.preventDefault(); if (isStandard) qtyRef.current?.focus(); else shadeRef.current?.focus(); }
        return;
      }
      if (target === shadeRef.current) {
        if (shadeSuggestion && shade !== shadeSuggestion && !allShadesAreNumeric) { e.preventDefault(); selectShade(shadeSuggestion); }
        else if (shade) { e.preventDefault(); qtyRef.current?.focus(); }
        return;
      }
      if (target === qtyRef.current) { e.preventDefault(); priceRef.current?.focus(); return; }
      if (target === priceRef.current && item && shade && price) { e.preventDefault(); addItem(false); return; }
      if (tag !== "BUTTON" && item && shade && price) { e.preventDefault(); addItem(false); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, shade, price, qty, cost, shades, items, itemSuggestion, shadeSuggestion, isStandard, allItems, allShadesAreNumeric, barcode, isPhoneValid, saving, shadeDropdownIndex]);

  const addItem = async (fromBarcode = false) => {
    if (!item?.trim()) { alert("Enter item name"); return; }
    if (qty <= 0) { alert("Quantity must be >0"); return; }
    const priceNum = Number(price);
    if (isNaN(priceNum) || priceNum < 0) { alert("Enter valid price"); return; }
    if (priceNum === 0) { alert("Price cannot be 0. Use Misc if free."); return; }
    const costNum = Number(cost);
    if (isNaN(costNum) || costNum < 0) { alert("Enter valid cost"); return; }

    const itemExists = allItems.some(i => i.toLowerCase() === item.toLowerCase());
    let shadeIsValid = false, isMisc = false;
    if (itemExists) {
      let shadesList: string[] = [];
      if (shadeCache.current[item]) shadesList = shadeCache.current[item];
      else {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(`/api/core?action=getShades&item=${encodeURIComponent(item)}`, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error(`Server ${res.status}`);
          const data = await res.json();
          shadesList = data.shades || [];
          if (!shadesList.length) { alert(`No shades found for ${item}`); return; }
          shadeCache.current[item] = shadesList;
        } catch (err: any) {
          if (err.name === 'AbortError') alert("Lookup timed out");
          else alert(`Failed to fetch shades: ${err.message}`);
          return;
        }
      }
      if (shade) shadeIsValid = shadesList.some(s => s.toLowerCase() === shade.toLowerCase());
      else shadeIsValid = false;
      isMisc = !shadeIsValid;
    } else isMisc = true;
    const finalShade = shade || (isMisc ? "Misc" : "");
    if (itemExists && !isMisc && !finalShade) { alert("Select a shade"); return; }

    const newItem = recalcItem({
      item, shade: finalShade, qty, cost: costNum, price: priceNum, originalPrice: priceNum, misc: isMisc,
      total: 0, profit: 0, priceOverridden: false,
    });
    updateItems([...items, newItem]);

    if (fromBarcode) {
      setItem(""); setShade(""); setQty(1); setPrice(""); setCost("");
      setShowItemDropdown(false); setShowShadeDropdown(false);
      setTimeout(() => barcodeInputRef.current?.focus(), 50);
    } else {
      setItem(""); setShade(""); setQty(1); setPrice(""); setCost("");
      setTimeout(() => itemRef.current?.focus(), 50);
    }
  };

  const updateQty = (idx: number, newQty: number) => {
    if (newQty < 1) return;
    const updated = [...items];
    updated[idx] = recalcItem({ ...updated[idx], qty: newQty, priceOverridden: false });
    updateItems(updated);
  };

  const fetchPrice = async (itemName: string, selectedShade?: string): Promise<number | null> => {
    try {
      if (!selectedShade) return null;
      const res = await fetch(`/api/core?action=getPrice&item=${encodeURIComponent(itemName)}&shade=${encodeURIComponent(selectedShade)}`);
      const data = await res.json();
      return data.price || null;
    } catch (err) {
      console.error(err);
      return null;
    }
  };

  const removeItem = (idx: number) => {
    setLastDeletedItem(items[idx]);
    setLastDeletedIdx(idx);
    const newItems = items.filter((_, i) => i !== idx);
    updateItems(newItems);
    setSelectedRow(null);
    setDeleteConfirmIdx(null);
    showToast("Item removed (Undo available)", "info");
  };

  const captureBillImage = async (): Promise<Blob | null> => {
    const billEl = document.getElementById("print-bill");
    if (!billEl) return null;
    const logoEl = billEl.querySelector<HTMLImageElement>("img[alt='logo']");
    const originalSrc = logoEl?.src ?? "";
    const noPrint = billEl.querySelectorAll<HTMLElement>(".no-print");
    const printOnly = billEl.querySelectorAll<HTMLElement>(".print-only");
    try {
      if (logoEl) {
        try {
          const pngUrl = await svgToPngDataUrl("/logo.svg");
          logoEl.src = pngUrl;
          await new Promise(r => setTimeout(r, 100));
        } catch {}
      }
      noPrint.forEach(el => el.style.display = "none");
      printOnly.forEach(el => el.style.display = "inline");
      await new Promise(r => setTimeout(r, 50));
      const canvas = await html2canvas(billEl, { scale: 2, backgroundColor: "#ffffff", useCORS: true, allowTaint: true, logging: false, imageTimeout: 0 });
      return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    } catch (err) { console.error(err); return null; }
    finally {
      noPrint.forEach(el => el.style.display = "");
      printOnly.forEach(el => el.style.display = "none");
      if (logoEl) logoEl.src = originalSrc;
    }
  };

  const svgToPngDataUrl = (svgUrl: string): Promise<string> => new Promise((resolve, reject) => {
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

  const saveBill = async () => {
    if (items.length === 0 || saving) return false;
    if (!isPhoneValid) { alert("Enter 10-digit phone (with or without +91)"); return false; }
    const courierChargesNum = Number(courierCharges) || 0;
    if (customerType === "courier" && courierChargesNum <= 0) {
      alert("Courier charges required for courier orders");
      return false;
    }
    setSaving(true);
    setSavingProgress(true);
    try {
      const url = editingBillNo ? "/api/bill?action=edit" : "/api/bill";
      const body: any = {
        items: items.map(i => ({ ...i, total: i.qty * i.price, profit: i.profit })),
        finalTotal,
        courierCharges: customerType === "courier" ? courierChargesNum : 0,
        customer: { name: customerName, phone: phoneWithCountryCode(), phone2, type: customerType, courier: customerType === "courier" },
        earnRate: pointsConfig?.earnRate ?? 0,
        redeemRate: pointsConfig?.redeemRate ?? 0,
      };
      if (editingBillNo) {
        body.originalBillNo = editingBillNo;
        body.originalDate = originalBillDate;
        body.originalTime = originalBillTime;
        body.originalRowIndexes = originalRowIndexes;
      }
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      priceCache.current = {};
      shadeCache.current = {};
      sessionStorage.removeItem("allItems");
      localStorage.removeItem("billDraft");
      fetchNextBillNo();
      setItems([]);
      setItem("");
      setShade("");
      setSelectedRow(null);
      setCustomer(null);
      setCustomerName("");
      setPhone("");
      setPhone2("");
      setRedeemPoints(false);
      setCourierCharges("");
      setAmountReceived("");
      setEditingBillNo(null);
      setOriginalBillDate("");
      setOriginalBillTime("");
      setOriginalRowIndexes([]);
      showToast(`Bill #${nextBillNo} saved!`, "success");
      return true;
    } catch (err: any) {
      showToast(err.message, "error");
      return false;
    } finally {
      setSaving(false);
      setSavingProgress(false);
    }
  };

  const sendWhatsAppWithBlob = async (blob: Blob) => {
    const cleaned = phone.replace(/[^0-9]/g, "");
    if (!cleaned) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("Bill image copied. Paste in WhatsApp.", "success");
    } catch {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bill-${nextBillNo ?? "draft"}.png`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Image downloaded. Attach in WhatsApp.", "info");
    }
    const waLink = `https://wa.me/${cleaned}`;
    const anchor = document.createElement("a");
    anchor.href = waLink;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  };

  const sendWhatsApp = async () => {
    if (!phone || items.length === 0) return;
    if (!isPhoneValid) { showToast("Invalid phone number", "error"); return; }
    const blob = await captureBillImage();
    if (!blob) { showToast("Failed to capture image", "error"); return; }
    await sendWhatsAppWithBlob(blob);
  };

  const saveBillAndSend = async () => {
    if (items.length === 0 || saving) return;
    if (!isPhoneValid) { alert("Enter valid phone"); return; }
    const courierChargesNum = Number(courierCharges) || 0;
    if (customerType === "courier" && courierChargesNum <= 0) {
      alert("Courier charges required for courier orders");
      return;
    }
    const cleaned = normalizedPhone;
    setSavingProgress(true);
    const blob = await captureBillImage();
    let copied = false;
    if (blob) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (err) { console.error(err); }
    } else showToast("Image fetch failed. Bill will be saved.", "error");
    const saved = await saveBill();
    if (!saved) { setSavingProgress(false); return; }
    if (cleaned) {
      const waLink = `https://wa.me/${cleaned}`;
      const anchor = document.createElement("a");
      anchor.href = waLink;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      if (copied) showToast("Bill copied. Paste in WhatsApp.", "success");
      else showToast("Please attach image manually.", "info");
    }
    setSavingProgress(false);
  };

  const generateStoreRestock = async () => {
    const input = window.prompt("Enter item name (or 'all'):");
      if (!input?.trim()) return;
      const item = input.trim();
      let alternate: string | null = null;

      // optional alternate for 816
      if (item.toLowerCase() !== "all" && item.toLowerCase() === "816") {
        alternate = window.prompt("Enter alternate shade to restock (optional, leave blank to restock all low shades):");
        if (alternate && alternate.trim() === "") alternate = null;
        // no alert if empty – it's optional
      }

    setRestockLoading(true);
    try {
      let url = `/api/restock?type=store&item=${encodeURIComponent(item)}`;
      if (alternate) url += `&alternate=${encodeURIComponent(alternate)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!data.message) {
        alert(data.summary || "No restock needed");
        return;
        }
      if (window.confirm(`Restock Summary:\n${data.summary}\n\nOpen WhatsApp?`)) {
        const anchor = document.createElement("a");
        anchor.href = data.waLink;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.click();
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setRestockLoading(false);
    }
  };

  const retrieveBillByNo = async (billNo: number) => {
    if (!billNo || billNo <= 0) { showToast("Enter valid bill number", "error"); return; }
    setBillRetrievalLoading(true);
    try {
      const res = await fetch(`/api/bill?action=getBill&billNo=${billNo}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRetrievedBill({ ...data.bill, originalRowIndexes: data.bill.originalRowIndexes });
      showToast(`Bill #${billNo} retrieved`, "success");
    } catch (err: any) { showToast(err.message, "error"); setRetrievedBill(null); }
    finally { setBillRetrievalLoading(false); }
  };

  const loadBillForEdit = (bill: any) => {
    const loadedItems = bill.items.map((it: any) => recalcItem({ ...it, cost: it.cost || 0, originalPrice: it.price, priceOverridden: false }));
    updateItems(loadedItems);
    setCustomerName(bill.customerName);
    setPhone(bill.customerPhone);
    setPhone2(bill.customerPhone2 || "");
    setCourierCharges(bill.courierCharges ? String(bill.courierCharges) : "");
    setCustomerType(Number(bill.courierCharges) > 0 ? "courier" : "walk-in");
    setEditingBillNo(bill.billNo);
    setOriginalBillDate(bill.date);
    setOriginalBillTime(bill.time);
    setCustomer(null);
    setOriginalRowIndexes(bill.originalRowIndexes);
    setShowBillRetrieval(false);
    showToast("Bill loaded. Edit and re-save.", "success");
  };

  return (
    <div className="app-container" style={styles.container}>
<style>{`@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
* { font-family: 'Montserrat', sans-serif; }
.bill-table { border-left: 1px solid #c5cad1 !important; border-right: 1px solid #c5cad1 !important; }
.bill-table th, .bill-table td { border-right: 1px solid #c5cad1 !important; }
.bill-table th:first-child, .bill-table td:first-child { border-left: 1px solid #c5cad1 !important; }
.bill-table th:last-child, .bill-table td:last-child { border-right: none !important; }
input, button { font-family: 'Montserrat', sans-serif; }
input:focus { outline: none; box-shadow: 0 0 0 3px rgba(26,26,26,0.1); border-color: #1a1a1a !important; }
button:hover:not(:disabled) { background-color: #333 !important; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
button:active:not(:disabled) { transform: translateY(0); }
@page { size: A4 portrait; margin: 1cm; }
@media print {
  .no-print { display: none !important; }
  .print-only { display: inline !important; }
  html, body { margin: 0; padding: 0; background: white; width: 210mm; height: 297mm; }
  .app-container { background: white; box-shadow: none; margin: 0; padding: 0; width: 210mm; }
  #print-bill { width: 100%; border: 1.5px solid #000 !important; box-shadow: none; border-radius: 0; padding: 16px 20px; box-sizing: border-box; page-break-inside: avoid; }
  #print-bill .logo { width: 160px !important; margin-bottom: 20px !important; margin-top: 10px !important; }
  .bill-table { font-size: 12px; margin-top: 10px; }
  .bill-table th, .bill-table td { padding: 6px 4px; font-size: 12px; }
  .bill-table th { font-size: 11px; }
  .grandTotalRow { font-size: 16px; }
  .metaLabel, .metaValue { font-size: 11px; }
  hr { margin: 12px 0; }
  .totalsBlock { margin-top: 12px; padding-top: 8px; }
  .thankYou { margin-top: 16px; padding-top: 8px; font-size: 12px; }
}`}</style>

      {toast && <div style={{ position: "fixed", bottom: "24px", right: "24px", background: toast.type === 'success' ? '#10b981' : toast.type === 'error' ? '#ef4444' : '#3b82f6', color: '#fff', padding: "14px 20px", borderRadius: "0px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: "13px", fontWeight: 600, zIndex: 9999, maxWidth: "300px", animation: "slideIn 0.3s ease", fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.3px" }}>{toast.message}</div>}
      {deleteConfirmIdx !== null && <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9998 }}>
        <div style={{ background: "#fff", padding: "24px", borderRadius: "0px", boxShadow: "0 10px 40px rgba(0,0,0,0.2)", maxWidth: "400px" }}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: "16px", fontWeight: 800 }}>Delete Item?</h3>
          <p style={{ margin: "0 0 20px 0", fontSize: "13px", color: "#64748b" }}>Are you sure you want to delete "<strong>{items[deleteConfirmIdx]?.item}</strong>"? You can undo.</p>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button onClick={cancelDelete} style={{ padding: "10px 18px", fontSize: "12px", fontWeight: 700, border: "1px solid #cbd5e1", background: "#f1f5f9", color: "#334155", cursor: "pointer", borderRadius: "0px" }}>Cancel</button>
            <button onClick={(e) => { e.preventDefault(); if (deleteConfirmIdx !== null) removeItem(deleteConfirmIdx); }} style={{ padding: "10px 18px", fontSize: "12px", fontWeight: 700, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", borderRadius: "0px" }}>Delete</button>
          </div>
        </div>
      </div>}

      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }`}</style>
      <h1 className="no-print" style={styles.title}>Billing Counter</h1>
      <div className="no-print" style={{ textAlign: "center", fontSize: "11px", color: "#64748b", marginBottom: "20px", letterSpacing: "0.3px" }}>
        <span style={{ fontWeight: 700, textTransform: "uppercase" }}>Keyboard Shortcuts:</span> Enter to add • Tab autocomplete • Ctrl+S save • Ctrl+Enter save & send
      </div>

      <div className="no-print" style={styles.card}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
          <input ref={barcodeInputRef} type="text" value={barcode} onChange={e => setBarcode(e.target.value)} onKeyDown={e => e.key === "Enter" && (e.preventDefault(), handleBarcodeScan())} placeholder="Scan Barcode..." style={styles.smallInput} disabled={barcodeLoading} />
          {barcodeLoading && <span>⌛</span>}
        </div>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", marginTop: "12px" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input 
              ref={itemRef} 
              value={item} 
              onChange={e => { setItem(e.target.value); setShowItemDropdown(true); setItemDropdownIndex(-1); }} 
              onFocus={() => item && setShowItemDropdown(true)}
              onBlur={() => setTimeout(() => setShowItemDropdown(false), 200)}
              onKeyDown={e => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setShowItemDropdown(true);
                  setItemDropdownIndex(prev => prev < filteredItems.length - 1 ? prev + 1 : prev);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setItemDropdownIndex(prev => prev > 0 ? prev - 1 : -1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (itemDropdownIndex >= 0 && itemDropdownIndex < filteredItems.length) {
                    setItem(filteredItems[itemDropdownIndex]);
                    setShowItemDropdown(false);
                    setItemDropdownIndex(-1);
                    shadeRef.current?.focus();
                  }
                } else if (e.key === "Escape") {
                  setShowItemDropdown(false);
                  setItemDropdownIndex(-1);
                } else if (e.key === "Tab") {
                  setShowItemDropdown(false);
                  setItemDropdownIndex(-1);
                }
              }}
              placeholder="Item..." 
              style={styles.smallInput} 
              autoFocus 
              autoComplete="off" 
            />
            {itemSuggestion && item !== itemSuggestion && <span style={styles.suggestion}>{itemSuggestion}</span>}
            {showItemDropdown && filteredItems.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: "2px", backgroundColor: "#fff", border: "1px solid #cbd5e1", borderRadius: "4px", maxHeight: "200px", overflowY: "auto", zIndex: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
              {filteredItems.map((n, idx) => <div key={n} style={{ padding: "8px 12px", cursor: "pointer", backgroundColor: itemDropdownIndex === idx ? "#cbd5e1" : item.toLowerCase() === n.toLowerCase() ? "#f0f4f8" : "#fff", borderBottom: "1px solid #f0f0f0", fontSize: "13px", fontWeight: itemDropdownIndex === idx ? 600 : 400 }} onClick={() => { setItem(n); setShowItemDropdown(false); setItemDropdownIndex(-1); }} onMouseEnter={() => setItemDropdownIndex(idx)} onMouseLeave={() => setItemDropdownIndex(-1)}>{n}</div>)}
            </div>}
            {item && !allItems.some(i => i.toLowerCase() === item.toLowerCase()) && <span style={{ fontSize: 11, color: "#e67e22", marginLeft: 8 }}>(New item – no stock deduction)</span>}
          </div>
          {!isStandard && <div style={{ position: "relative", flex: 1 }}>
            {needsShadeDropdown ? <input 
              ref={shadeRef} 
              value={shade} 
              onChange={e => { setShade(e.target.value); setShowShadeDropdown(true); setShadeDropdownIndex(-1); }} 
              onFocus={() => shade && setShowShadeDropdown(true)}
              onBlur={() => setTimeout(() => { setShowShadeDropdown(false); setShadeDropdownIndex(-1); }, 200)}
              onKeyDown={e => { 
                if (e.key === "Tab") { 
                  setShowShadeDropdown(false); 
                  setShadeDropdownIndex(-1); 
                } else if (e.key === "ArrowDown") { 
                  e.preventDefault();
                  setShowShadeDropdown(true);
                  const filtered = shades.filter(s => !shade.trim() || s.toLowerCase().includes(shade.toLowerCase())).slice(0,8); 
                  setShadeDropdownIndex(prev => prev < filtered.length-1 ? prev+1 : prev); 
                } else if (e.key === "ArrowUp") { 
                  e.preventDefault(); 
                  setShadeDropdownIndex(prev => prev > 0 ? prev-1 : -1); 
                } else if (e.key === "Enter") { 
                  e.preventDefault(); 
                  const filtered = shades.filter(s => !shade.trim() || s.toLowerCase().includes(shade.toLowerCase())).slice(0,8); 
                  if (shadeDropdownIndex >=0 && shadeDropdownIndex < filtered.length) { 
                    setShade(filtered[shadeDropdownIndex]); 
                    setShowShadeDropdown(false); 
                    setShadeDropdownIndex(-1); 
                    setTimeout(() => qtyRef.current?.focus(), 50);
                  }
                } else if (e.key === "Escape") {
                  setShowShadeDropdown(false);
                  setShadeDropdownIndex(-1);
                }
              }} 
              placeholder="Shade/Variant..." 
              style={styles.smallInput} 
              autoComplete="off" 
            /> : <input ref={shadeRef} value={shade} onChange={e => setShade(e.target.value)} placeholder="Shade/Variant..." style={styles.smallInput} autoComplete="off" />}
            {needsShadeDropdown && showShadeDropdown && shades.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: "2px", backgroundColor: "#fff", border: "1px solid #cbd5e1", borderRadius: "4px", maxHeight: "200px", overflowY: "auto", zIndex: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
              {shades.filter(s => !shade.trim() || s.toLowerCase().includes(shade.toLowerCase())).slice(0,8).map((sv, i) => <div key={sv} style={{ padding: "8px 12px", cursor: "pointer", backgroundColor: shadeDropdownIndex === i ? "#cbd5e1" : shade.toLowerCase() === sv.toLowerCase() ? "#f0f4f8" : "#fff", borderBottom: "1px solid #f0f0f0", fontSize: "13px", fontWeight: shadeDropdownIndex === i ? 600 : 400 }} onClick={() => { setShade(sv); setShowShadeDropdown(false); setShadeDropdownIndex(-1); }} onMouseEnter={() => setShadeDropdownIndex(i)} onMouseLeave={() => setShadeDropdownIndex(-1)}>{sv}</div>)}
            </div>}
            {!needsShadeDropdown && shadeSuggestion && shade !== shadeSuggestion && <span style={styles.suggestion}>{shadeSuggestion}</span>}
          </div>}
          <input ref={qtyRef} type="number" min="1" value={qty} onChange={e => setQty(Number(e.target.value))} placeholder="Qty" style={{ ...styles.smallInput, maxWidth: 80 }} />
          <input ref={priceRef} type="text" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="Price" style={{ ...styles.smallInput, maxWidth: 100 }} />
          <button style={styles.button} onClick={() => addItem(false)}>Add</button>
        </div>
      </div>

      <div id="print-bill" style={styles.billArea}>
        <div style={styles.billHeader}><img src="/logo.svg" alt="logo" className="logo" style={styles.logo} crossOrigin="anonymous" /></div>
        <div style={{ border: "1px solid #e2e8f0", padding: "12px 14px", marginBottom: "0px", backgroundColor: "#f8f9fb", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "24px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px", flex: 1 }}>
            {customer?.customerId && <div style={{ fontSize: "11px", fontWeight: 700 }}><span style={styles.metaLabel}>ID:</span> {customer.customerId}</div>}
            <div style={{ fontSize: "11px", fontWeight: 600 }}><span style={styles.metaLabel}>Customer:</span> {customerName || ""}</div>
            <div style={{ fontSize: "11px", fontWeight: 600 }}><span style={styles.metaLabel}>Phone:</span> {phone || ""}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px", alignItems: "flex-start" }}>
            <div style={{ fontSize: "12px", fontWeight: 700 }}><span style={styles.metaLabel}>Bill No:</span> #{displayBillNo ?? ""}</div>
            <div style={{ fontSize: "12px", fontWeight: 700 }}><span style={styles.metaLabel}>Date:</span> {displayBillDate}</div>
            <div style={{ fontSize: "12px", fontWeight: 700 }}><span style={styles.metaLabel}>Time:</span> {displayBillTime}</div>
          </div>
        </div>
        <table className="bill-table" style={styles.table}>
          <thead><tr style={styles.theadRow}>
            <th style={{ ...styles.th, width: "5%", textAlign: "center" }}>#</th>
            <th style={{ ...styles.th, width: "30%" }}>Item</th>
            <th style={{ ...styles.th, width: "28%" }}>Shade</th>
            <th style={{ ...styles.th, width: "10%", textAlign: "center" }}>Qty</th>
            <th style={{ ...styles.th, width: "12%", textAlign: "right", paddingRight: "20px" }}>Price</th>
            <th style={{ ...styles.th, width: "13%", textAlign: "right", paddingRight: "20px" }}>Total</th>
            <th className="no-print" style={{ ...styles.th, width: "5%" }}></th>
          </tr></thead>
          <tbody>
            {items.length === 0 ? <tr><td colSpan={7} style={{ textAlign: "center", padding: "24px 0", color: "#aaa" }}>No items added yet</td></tr> :
              items.map((i, idx) => <tr key={idx} style={{ ...(idx%2===0?styles.trEven:styles.trOdd), backgroundColor: selectedRow===idx?styles.selectedRow.backgroundColor:undefined, cursor:"pointer" }} onClick={()=>setSelectedRow(idx)}>
                <td style={{ ...styles.td, textAlign:"center", color:"#999", fontSize:13 }}>{idx+1}</td>
                <td style={styles.td}>{i.item}{i.misc && <span className="no-print" style={{ fontSize:10, color:"#e67e22" }}> (Misc)</span>}</td>
                <td style={styles.td}>
                  {editingShadeRow === idx ? (
                    <div style={{ position: "relative", width: "100%" }}>
                      <input
                        type="text"
                        value={editingShadeValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditingShadeValue(val);
                          const shadesList = shadeCache.current[items[idx].item] || [];
                          const filtered = shadesList.filter(s =>
                            s.toLowerCase().includes(val.toLowerCase())
                          ).slice(0, 8);
                          setEditShadeFilteredList(filtered);
                          setEditShadeDropdownIndex(-1);
                        }}
                        onBlur={() => saveEditShade(idx)}
                        onKeyDown={(e) => {
                          if (e.key === "Tab" && editShadeFilteredList.length > 0 && editShadeDropdownIndex >= 0) {
                            e.preventDefault();
                            setEditingShadeValue(editShadeFilteredList[editShadeDropdownIndex]);
                            setEditShadeFilteredList([]);
                            setEditShadeDropdownIndex(-1);
                            return;
                          }
                          if (e.key === "Enter") {
                            e.preventDefault();
                            saveEditShade(idx);
                            return;
                          }
                          if (e.key === "Escape") {
                            cancelEditShade();
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setEditShadeDropdownIndex(prev =>
                              prev < editShadeFilteredList.length - 1 ? prev + 1 : prev
                            );
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setEditShadeDropdownIndex(prev => (prev > 0 ? prev - 1 : -1));
                          }
                        }}
                        autoFocus
                        disabled={validatingShade}
                        style={{
                          width: "100%",
                          minWidth: "120px",
                          padding: "4px 6px",
                          fontSize: "12px",
                          border: "1px solid #ccc",
                          borderRadius: "4px",
                          boxSizing: "border-box",
                        }}
                      />
                      {editShadeFilteredList.length > 0 && (
                        <div style={{
                          position: "absolute",
                          top: "100%",
                          left: 0,
                          right: 0,
                          marginTop: "2px",
                          backgroundColor: "#fff",
                          border: "1px solid #cbd5e1",
                          borderRadius: "4px",
                          maxHeight: "150px",
                          overflowY: "auto",
                          zIndex: 10,
                          boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                        }}>
                          {editShadeFilteredList.map((shadeOpt, sidx) => (
                            <div
                              key={shadeOpt}
                              style={{
                                padding: "4px 8px",
                                cursor: "pointer",
                                backgroundColor: editShadeDropdownIndex === sidx ? "#e2e8f0" : "#fff",
                                fontSize: "11px",
                                borderBottom: "1px solid #e9ecef",
                              }}
                              onClick={() => {
                                setEditingShadeValue(shadeOpt);
                                setEditShadeFilteredList([]);
                                saveEditShade(idx);
                              }}
                              onMouseEnter={() => setEditShadeDropdownIndex(sidx)}
                            >
                              {shadeOpt}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <span style={{ flex: 1, wordBreak: "break-word", whiteSpace: "normal" }}>{i.shade}</span>
                      <button className="no-print" onClick={() => startEditShade(idx, i.shade)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "14px", padding: "4px", color: "#666", borderRadius: "4px" }} title="Edit shade">✏️</button>
                    </div>
                  )}
                </td>
                <td style={{ ...styles.td, textAlign: "center" }}>
                  <span className="no-print" style={styles.qtyControls}>
                    <button style={styles.qtyBtn} onClick={(e)=>{ e.stopPropagation(); updateQty(idx, i.qty-1); }}>−</button>
                    <span style={styles.qtyNum}>{i.qty}</span>
                    <button style={styles.qtyBtn} onClick={(e)=>{ e.stopPropagation(); updateQty(idx, i.qty+1); }}>+</button>
                  </span>
                  <span className="print-only" style={{ display: "none" }}>{i.qty}</span>
                </td>
                <td style={{ ...styles.td, textAlign: "right", paddingRight: "20px" }}>
                  {editingPriceRow === idx ? (
                    <input
                      type="text"
                      inputMode="decimal"
                      value={editingPriceValue}
                      onChange={(e) => setEditingPriceValue(e.target.value)}
                      onBlur={() => saveEditPrice(idx)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEditPrice(idx);
                        if (e.key === "Escape") cancelEditPrice();
                      }}
                      autoFocus
                      style={{
                        width: "80px",
                        padding: "2px 4px",
                        fontSize: "12px",
                        textAlign: "right",
                        border: "1px solid #ccc",
                        borderRadius: "4px",
                      }}
                    />
                  ) : (
                    <>
                      ₹{formatPrice(i.price)}
                      <button
                        className="no-print"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditPrice(idx, i.price);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: "12px",
                          padding: "2px 4px",
                          marginLeft: "6px",
                          color: "#666",
                        }}
                        title="Edit price"
                      >
                        ✏️
                      </button>
                    </>
                  )}
                </td>
                <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, paddingRight: "20px" }}>₹{formatPrice(i.total)}</td>
                <td className="no-print" style={{ ...styles.td, textAlign: "center" }}>
                  <button style={styles.removeBtn} onClick={(e)=>{ e.stopPropagation(); confirmDeleteItem(idx); }}>✕</button>
                </td>
              </tr>)}
          </tbody>
        </table>
        <hr style={styles.divider} />
        <div style={styles.totalsBlock}>
          {courierChargesNum > 0 && <div style={{ ...styles.discountRow, display:"flex", justifyContent:"space-between", paddingRight:"8px", color:"#dc2626" }}><span>Handling Charges: </span><span>+ ₹{formatPrice(courierChargesNum)}</span></div>}
          <div style={{ ...styles.grandTotalRow, display:"flex", justifyContent:"space-between" }}><span>Grand Total</span><span>₹{formatPrice(finalTotal)}</span></div>
        </div>
        <p style={styles.thankYou}>Thank you for your purchase!</p>
      </div>

      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px", gap: "16px", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Cash Received:</span>
        <input
          type="text"
          inputMode="decimal"
          value={amountReceived}
          onChange={(e) => setAmountReceived(e.target.value)}
          placeholder=""
          style={{
            width: "100px",
            padding: "6px 10px",
            fontSize: "13px",
            border: "1px solid #cbd5e1",
            borderRadius: "0px",
            outline: "none",
            textAlign: "right",
            fontFamily: "'Montserrat', sans-serif",
          }}
        />
        {changeAmount > 0 && (
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#10b981" }}>
            Change: ₹{formatPrice(changeAmount)}
          </span>
        )}
      </div>

      <div className="no-print" style={styles.customerCard}>
        <div style={{ display:"flex", gap:"8px", marginBottom:"12px" }}>
          <button onClick={()=>{ setCustomerType("walk-in"); setCustomerName(""); setPhone(""); setPhone2(""); setCustomer(null); setCourierCharges(""); setAmountReceived(""); }} style={{ flex:1, padding:"8px12px", fontSize:"13px", fontWeight:customerType==="walk-in"?700:500, backgroundColor:customerType==="walk-in"?"#10b981":"#e5e7eb", color:customerType==="walk-in"?"#fff":"#374151", border:"none", borderRadius:"4px", cursor:"pointer" }}>👤 Walk-in</button>
          <button onClick={()=>{ setCustomerType("courier"); setCustomerName(""); setPhone(""); setPhone2(""); setCustomer(null); }} style={{ flex:1, padding:"8px12px", fontSize:"13px", fontWeight:customerType==="courier"?700:500, backgroundColor:customerType==="courier"?"#3b82f6":"#e5e7eb", color:customerType==="courier"?"#fff":"#374151", border:"none", borderRadius:"4px", cursor:"pointer" }}>🚚 Courier</button>
        </div>
        <div style={{ display:"flex", gap:"12px", flexWrap:"wrap", alignItems:"center" }}>
          <div style={{ position:"relative", flex:1 }}>
            <input 
              value={customerName} 
              onChange={e=>{ setCustomerName(e.target.value); searchCustomersByName(e.target.value); setCustomerDropdownIndex(-1); }}
              onFocus={() => customerSearchResults.length > 0 && setShowCustomerDropdown(true)}
              onBlur={() => setTimeout(() => { setShowCustomerDropdown(false); setCustomerDropdownIndex(-1); }, 200)}
              onKeyDown={e => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setShowCustomerDropdown(true);
                  setCustomerDropdownIndex(prev => prev < customerSearchResults.length - 1 ? prev + 1 : prev);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCustomerDropdownIndex(prev => prev > 0 ? prev - 1 : -1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (customerDropdownIndex >= 0 && customerDropdownIndex < customerSearchResults.length) {
                    selectCustomerFromSearch(customerSearchResults[customerDropdownIndex]);
                    setShowCustomerDropdown(false);
                    setCustomerDropdownIndex(-1);
                  }
                } else if (e.key === "Escape") {
                  setShowCustomerDropdown(false);
                  setCustomerDropdownIndex(-1);
                } else if (e.key === "Tab") {
                  setShowCustomerDropdown(false);
                  setCustomerDropdownIndex(-1);
                }
              }}
              placeholder="Search Customer Name..." 
              style={styles.smallInput} 
            />
            {showCustomerDropdown && customerSearchResults.length>0 && <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", border:"1px solid #cbd5e1", borderTop:"none", borderRadius:"0 0 6px 6px", maxHeight:"200px", overflowY:"auto", zIndex:1000 }}>
              {customerSearchResults.map((cust,idx)=> <div 
                key={idx} 
                onClick={()=>{ selectCustomerFromSearch(cust); setShowCustomerDropdown(false); setCustomerDropdownIndex(-1); }} 
                onMouseEnter={() => setCustomerDropdownIndex(idx)}
                onMouseLeave={() => setCustomerDropdownIndex(-1)}
                style={{ 
                  padding:"10px 12px", 
                  borderBottom:idx<customerSearchResults.length-1?"1px solid #f0f0f0":"none", 
                  cursor:"pointer", 
                  fontSize:"13px",
                  backgroundColor: customerDropdownIndex === idx ? "#f0f4f8" : "#fff",
                  fontWeight: customerDropdownIndex === idx ? 600 : 400
                }}
              >
                <div style={{ fontWeight:600, color:"#0f172a" }}>{cust.customerId} — {cust.name}</div>
                <div style={{ fontSize:"11px", color:"#64748b", marginTop:"2px" }}>📞 {cust.phone}{cust.phone2?`, ${cust.phone2}`:""} • {cust.points} pts</div>
              </div>)}
            </div>}
          </div>
          <input value={phone} onChange={e=>{ setPhone(e.target.value); searchCustomersByPhone(e.target.value); }} placeholder="Phone 1" style={styles.smallInput} />
          <input value={phone2} onChange={e=>{ setPhone2(e.target.value); if(e.target.value.trim().length >= 10) searchCustomersByPhone(e.target.value); }} placeholder="Phone 2 (optional)" style={styles.smallInput} />
          <input value={customer?.customerId||""} onChange={e=>{ if(e.target.value.trim()) searchCustomersById(e.target.value); }} placeholder="Or search by ID..." style={styles.smallInput} />
          {customerSearchLoading && <span>🔍</span>}
        </div>
        {customer && <div style={styles.customerInfo}>
          <span>👤 {customer.customerId} — {customer.name} — {customer.points} pts</span>
          {pointsConfig && customer.points >= pointsConfig.minRedeem && <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}><input type="checkbox" checked={redeemPoints} onChange={e=>setRedeemPoints(e.target.checked)} /> Redeem {customer.points} points (₹{formatPrice(Math.floor(customer.points*pointsConfig.redeemRate))} off)</label>}
          {pointsConfig && customer.points < pointsConfig.minRedeem && <span style={{ fontSize:12, color:"#aaa" }}>{pointsConfig.minRedeem - customer.points} more points needed</span>}
        </div>}
        {customerType === "courier" && <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:"8px" }}><span style={{ fontSize:"13px", fontWeight:600, minWidth:"120px" }}>Courier Charges:</span><input type="text" inputMode="decimal" value={courierCharges} onChange={e=>setCourierCharges(e.target.value)} placeholder="" style={{ width:"100px", padding:"8px10px", fontSize:"13px", border:"1px solid #cbd5e1", borderRadius:"0px", outline:"none", boxSizing:"border-box" }} /></div>}
        {customerType === "walk-in" && <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:"8px", color:"#aaa" }}><span style={{ fontSize:"12px" }}>Walk-in mode: No courier charges</span></div>}
        {!customer && customerName.trim().length>=2 && !customerSearchLoading && <div style={{ fontSize:13, color:"#888", marginTop:6, fontWeight:500 }}>🆕 New customer, will be registered on save.</div>}
      </div>

      <div className="no-print" style={styles.actions}>
        {lastDeletedItem && <button style={{ ...styles.printBtn, background:"#8b5cf6" }} onClick={undoDelete}>↶ Undo Delete</button>}
        <button style={{ ...styles.printBtn, background:"#8b5cf6" }} onClick={()=>setShowBillRetrieval(!showBillRetrieval)}>🔍 Retrieve Bill</button>
        <button style={{ ...styles.printBtn, background:"#22e6ae" }} onClick={generateStoreRestock} disabled={restockLoading}>📋 Store Restock (WhatsApp)</button>
        <button style={{ ...styles.printBtn, background:"#25D366" }} onClick={sendWhatsApp} disabled={!isPhoneValid || items.length===0}>📲 Send Bill</button>
        <button style={styles.printBtn} onClick={()=>setPrintPreview(true)}>👁 Preview</button>
        <button style={styles.printBtn} onClick={()=>window.print()}>🖨 Print Bill</button>
        <button style={{ ...styles.printBtn, opacity: (savingProgress || items.length===0 || !isPhoneValid) ? 0.6 : 1 }} onClick={saveBill} disabled={savingProgress || items.length===0 || !isPhoneValid}>{savingProgress ? "⏳ Saving..." : "💾 Save to Sheets"}</button>
        <button style={{ ...styles.printBtn, background:"#0a6ed1", opacity: (savingProgress || items.length===0 || !isPhoneValid) ? 0.6 : 1 }} onClick={saveBillAndSend} disabled={savingProgress || items.length===0 || !isPhoneValid}>{savingProgress ? "⏳ Saving..." : "💾📲 Save & Send"}</button>
      </div>

      {showBillRetrieval && <div className="no-print" style={styles.customerCard}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"12px" }}>
          <h3 style={{ margin:0, fontSize:"14px", fontWeight:700 }}>🔍 Retrieve Previous Bill</h3>
          <button onClick={()=>setShowBillRetrieval(false)} style={{ background:"none", border:"none", fontSize:"20px", cursor:"pointer", color:"#666" }}>✕</button>
        </div>
        <div style={{ display:"flex", gap:"8px" }}>
          <input type="number" min="1" value={billSearchNo} onChange={e=>setBillSearchNo(e.target.value)} placeholder="Enter bill number..." style={{ flex:1, padding:"8px10px", fontSize:"13px", border:"1px solid #cbd5e1", borderRadius:"4px", outline:"none" }} />
          <button onClick={()=>retrieveBillByNo(Number(billSearchNo))} disabled={billRetrievalLoading} style={{ padding:"8px12px", fontSize:"13px", fontWeight:600, backgroundColor:billRetrievalLoading?"#ccc":"#8b5cf6", color:"#fff", border:"none", borderRadius:"4px", cursor:billRetrievalLoading?"not-allowed":"pointer" }}>{billRetrievalLoading ? "⏳" : "Search"}</button>
        </div>
        {retrievedBill && <div style={{ marginTop:"12px", padding:"12px", background:"#f9fafb", borderRadius:"4px", fontSize:"13px" }}>
          <div style={{ fontWeight:700, marginBottom:"8px" }}>Bill #{retrievedBill.billNo}</div>
          <div><strong>Customer:</strong> {retrievedBill.customerName} ({retrievedBill.customerId})</div>
          <div><strong>Phone:</strong> {retrievedBill.customerPhone}</div>
          <div><strong>Date & Time:</strong> {retrievedBill.date} {retrievedBill.time}</div>
          <div style={{ fontWeight:700, marginTop:"8px", borderTop:"1px solid #e5e7eb", paddingTop:"8px" }}>Items:</div>
          {retrievedBill.items.map((it:any, idx:number)=> <div key={idx} style={{ display:"flex", justifyContent:"space-between", paddingBottom:"4px", borderBottom:"1px solid #e5e7eb" }}><span>{it.item} ({it.shade}) × {it.qty}</span><span>₹{formatPrice(it.total)}</span></div>)}
          <div style={{ marginTop:"8px", fontWeight:700, display:"flex", justifyContent:"space-between" }}><span>Final Total:</span><span>₹{formatPrice(retrievedBill.finalTotal)}</span></div>
          {retrievedBill.courierCharges > 0 && <div style={{ display:"flex", justifyContent:"space-between", color:"#dc2626", fontSize:"12px" }}><span>Courier:</span><span>₹{formatPrice(retrievedBill.courierCharges)}</span></div>}
          <button onClick={()=>loadBillForEdit(retrievedBill)} style={{ marginTop:"12px", padding:"8px12px", width:"100%", fontSize:"13px", fontWeight:600, backgroundColor:"#10b981", color:"#fff", border:"none", borderRadius:"4px", cursor:"pointer" }}>📋 Load for Reprint</button>
        </div>}
      </div>}

      {printPreview && <div style={styles.previewOverlay} onClick={()=>setPrintPreview(false)}><div style={styles.previewModal} onClick={e=>e.stopPropagation()}>
        <div style={styles.previewHeader}><h2 style={{ margin:0, fontSize:"18px", fontWeight:700 }}>Print Preview</h2><button onClick={()=>setPrintPreview(false)} style={{ background:"none", border:"none", fontSize:"20px", cursor:"pointer", color:"#666" }}>✕</button></div>
        <div style={styles.previewContent}><div id="preview-bill" style={{ ...styles.billArea, maxHeight:"600px", overflow:"auto" }}>
          <div style={styles.billHeader}><img src="/logo.svg" alt="logo" style={styles.logo} crossOrigin="anonymous" /></div>
          <div style={{ border:"1px solid #e2e8f0", padding:"12px14px", backgroundColor:"#f8f9fb", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:"24px" }}>
            <div style={{ display:"flex", flexDirection:"column", gap:"3px", flex:1 }}>
              {customer?.customerId && <div><span style={styles.metaLabel}>ID:</span> {customer.customerId}</div>}
              <div><span style={styles.metaLabel}>Customer:</span> {customerName || ""}</div>
              <div><span style={styles.metaLabel}>Phone:</span> {phone || ""}</div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:"3px", alignItems:"flex-start" }}>
              <div><span style={styles.metaLabel}>Bill No:</span> #{displayBillNo ?? ""}</div>
              <div><span style={styles.metaLabel}>Date:</span> {displayBillDate}</div>
              <div><span style={styles.metaLabel}>Time:</span> {displayBillTime}</div>
            </div>
          </div>
          <div style={{ fontSize:"9px", color:"#999", textAlign:"center", marginTop:"6px" }}>A4 Page Preview (210mm × 297mm)</div>
        </div></div>
        <div style={styles.previewFooter}><button style={{ ...styles.button, marginRight:"10px" }} onClick={()=>window.print()}>🖨 Print</button><button style={styles.button} onClick={()=>setPrintPreview(false)}>Close</button></div>
      </div></div>}
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  container: { maxWidth: 900, margin: "28px auto", fontFamily: "'Montserrat', sans-serif", background: "#f8f9fb", padding: "28px", borderRadius: "0px" },
  title: { textAlign: "center", marginBottom: "28px", fontWeight: 800, fontSize: "32px", letterSpacing: "-1px", color: "#0f172a", textTransform: "uppercase" },
  card: { background: "#ffffff", padding: "24px", borderRadius: "0px", marginBottom: "28px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" },
  row: { display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" },
  smallInput: { flex: 1, padding: "12px 14px", fontSize: "14px", borderRadius: "0px", border: "1px solid #cbd5e1", outline: "none", background: "#fbfcfd", fontWeight: 500, transition: "border-color 0.2s, box-shadow 0.2s" },
  autofillWrapper: { position: "relative", flex: 1 },
  suggestion: { position: "absolute", left: "14px", top: "12px", color: "#a8adb8", pointerEvents: "none", fontSize: "14px", opacity: 0.7, fontWeight: 500 },
  button: { padding: "12px 24px", fontSize: "13px", fontWeight: 700, borderRadius: "0px", border: "none", background: "#0f172a", color: "#fff", cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.2s ease", letterSpacing: "0.3px" },
  billArea: { background: "#ffffff", borderRadius: "0px", padding: "32px 36px", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", border: "1.5px solid #1a1a1a", pageBreakInside: "avoid" },
  billHeader: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "0px", gap: "0px", paddingBottom: "0px" },
  logo: { width: "300px", height: "auto", objectFit: "contain", display: "block", margin: "0 auto 0px auto" },
  metaLabel: { fontSize: "10px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", fontWeight: 800, minWidth: "52px" },
  metaValue: { fontSize: "15px", fontWeight: 700, color: "#0f172a", textAlign: "right", minWidth: "80px", letterSpacing: "-0.3px" },
  divider: { border: "none", borderTop: "1px dotted #cbd5e1", margin: "10px 0", padding: "0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "12px", marginTop: "10px", border: "1px solid #0f172a", userSelect: "none" },
  theadRow: { backgroundColor: "#f0f1f3" },
  th: { padding: "6px 4px", color: "#334155", fontWeight: 800, fontSize: "9px", textTransform: "uppercase", letterSpacing: "0.8px", textAlign: "left", borderBottom: "1px solid #0f172a", userSelect: "none" },
  td: { padding: "4px 4px", color: "#1e293b", fontSize: "12px", borderBottom: "1px solid #e0e3e8", borderRight: "1px solid #e0e3e8", verticalAlign: "middle", fontWeight: 500, userSelect: "none" },
  trEven: { backgroundColor: "#ffffff" },
  trOdd: { backgroundColor: "#fbfcfd" },
  selectedRow: { backgroundColor: "#f0f4f8" },
  qtyControls: { display: "inline-flex", alignItems: "center", gap: "6px" },
  qtyBtn: { width: "28px", height: "28px", borderRadius: "0px", border: "1px solid #cbd5e1", background: "#f1f5f9", cursor: "pointer", fontSize: "13px", fontWeight: 700, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0", transition: "all 0.2s ease", color: "#0f172a" },
  qtyNum: { minWidth: "28px", textAlign: "center", fontWeight: 700, fontSize: "13px" },
  removeBtn: { background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontSize: "15px", fontWeight: 700, padding: "2px 6px", borderRadius: "0px", transition: "color 0.2s" },
  totalsBlock: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", marginTop: "8px", paddingTop: "8px", borderTop: "1px dotted #cbd5e1" },
  discountRow: { display: "flex", gap: "64px", fontSize: "14px", color: "#059669", fontWeight: 800, justifyContent: "space-between", minWidth: "260px", letterSpacing: "-0.3px" },
  grandTotalRow: { display: "flex", gap: "64px", fontSize: "17px", fontWeight: 600, color: "#0f172a", borderTop: "1px solid #cbd5e1", paddingTop: "10px", marginTop: "8px", justifyContent: "space-between", minWidth: "260px", letterSpacing: "-0.3px" },
  thankYou: { textAlign: "center", marginTop: "16px", paddingTop: "12px", borderTop: "1px dotted #cbd5e1", fontSize: "11px", color: "#475569", letterSpacing: "0.4px", fontWeight: 700, textTransform: "uppercase" },
  customerCard: { background: "#ffffff", padding: "24px", borderRadius: "0px", marginTop: "24px", boxShadow: "0 1px 3px rgba(0,0,0,0.08)", border: "1px solid #e2e8f0" },
  customerInfo: { display: "flex", alignItems: "center", gap: "20px", marginTop: "14px", fontSize: "13px", color: "#1e293b", fontWeight: 600 },
  actions: { display: "flex", gap: "10px", marginTop: "24px", justifyContent: "flex-end", flexWrap: "wrap" },
  printBtn: { padding: "12px 24px", fontSize: "12px", fontWeight: 700, borderRadius: "0px", border: "none", background: "#0f172a", color: "#fff", cursor: "pointer", transition: "all 0.2s ease", letterSpacing: "0.3px", textTransform: "uppercase" },
  previewOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 },
  previewModal: { backgroundColor: "#fff", borderRadius: "8px", boxShadow: "0 10px 40px rgba(0, 0, 0, 0.2)", width: "90%", maxWidth: "600px", maxHeight: "90vh", display: "flex", flexDirection: "column" },
  previewHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #e2e8f0" },
  previewContent: { flex: 1, overflow: "auto", padding: "20px", backgroundColor: "#f8f9fb" },
  previewFooter: { display: "flex", justifyContent: "flex-end", gap: "10px", padding: "16px 20px", borderTop: "1px solid #e2e8f0" },
};