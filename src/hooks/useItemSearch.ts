/**
 * useItemSearch
 * ─────────────
 * Manages item list, shade list, price caching, and Fuse.js search.
 * Replaces the scattered useEffect chains in App.tsx.
 *
 * Caching strategy:
 *  - allItems: sessionStorage (cleared on save)
 *  - shades: in-memory ref (per session)
 *  - prices: in-memory ref (cleared on save)
 */

import { useState, useEffect, useRef, useMemo } from "react";
import Fuse from "fuse.js";
import { fetchItems, fetchShades, fetchPrice, fetchCost } from "../services/api";
import { useBillingStore } from "../store/billingStore";

const ALL_ITEMS_KEY = "allItems";

export function useItemSearch() {
  const [allItems, setAllItems] = useState<string[]>([]);
  const [shades, setShades] = useState<string[]>([]);
  const shadeCache = useRef<Record<string, string[]>>({});
  const priceCache = useRef<Record<string, { price: number; qty: number }>>({});

  const {
    entryItem, entryShade,
    setEntryPrice, setEntryCost,
    showToast,
  } = useBillingStore();

  // load all items
  useEffect(() => {
    const cached = sessionStorage.getItem(ALL_ITEMS_KEY);
    if (cached) {
      setAllItems(JSON.parse(cached));
      return;
    }
    fetchItems().then(items => {
      setAllItems(items);
      sessionStorage.setItem(ALL_ITEMS_KEY, JSON.stringify(items));
    });
  }, []);

  // load shades when item changes
  useEffect(() => {
    if (!entryItem) { setShades([]); setEntryCost(""); return; }
    if (!allItems.includes(entryItem)) { setShades([]); return; }
    if (shadeCache.current[entryItem]) {
      setShades(shadeCache.current[entryItem]);
      return;
    }
    fetchShades(entryItem).then(fetched => {
      shadeCache.current[entryItem] = fetched;
      setShades(fetched);
    });
  }, [entryItem, allItems]);

  // auto-select single standard shade
  useEffect(() => {
    if (shades.length === 1 && shades[0].toLowerCase() === "standard") {
      useBillingStore.getState().setEntryShade(shades[0]);
    }
  }, [shades]);

  // load cost when item+shade changes
  useEffect(() => {
    if (!entryItem || !entryShade || !allItems.includes(entryItem)) return;
    fetchCost(entryItem, entryShade).then(cost => setEntryCost(String(cost || "")));
  }, [entryItem, entryShade, allItems]);

  // load price when item+shade changes
  const warnedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!entryItem || !entryShade) return;
    if (!allItems.includes(entryItem) || !shades.includes(entryShade)) return;

    const key = `${entryItem}__${entryShade}`;

    if (priceCache.current[key]) {
      setEntryPrice(String(priceCache.current[key].price));
      const stock = priceCache.current[key].qty;
      if (stock >= 0 && stock < 2 && warnedKey.current !== key) {
        showToast(`Low stock for ${entryItem} ${entryShade}`, "info");
        warnedKey.current = key;
      }
      return;
    }

    fetchPrice(entryItem, entryShade).then(({ price, qty }) => {
      priceCache.current[key] = { price, qty };
      setEntryPrice(String(price));
      if (qty >= 0 && qty < 2 && warnedKey.current !== key) {
        showToast(`Low stock for ${entryItem} ${entryShade}`, "info");
        warnedKey.current = key;
      }
    });
  }, [entryItem, entryShade, shades, allItems]);

  // fuse search

  const itemFuse = useMemo(
    () => new Fuse(allItems, { threshold: 0.6, distance: 50, includeScore: true, minMatchCharLength: 2 }),
    [allItems]
  );

  const shadeFuse = useMemo(
    () => new Fuse(shades, { threshold: 0.6, distance: 50, includeScore: true, minMatchCharLength: 2 }),
    [shades]
  );

  const filteredItems = useMemo(
    () => entryItem.trim() ? itemFuse.search(entryItem).map(r => r.item).slice(0, 8) : allItems.slice(0, 8),
    [entryItem, itemFuse, allItems]
  );

  const filteredShades = useMemo(() => {
    const query = entryShade.trim();
    if (!query) return shades.slice(0, 8);
    return shades.filter(s => s.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  }, [entryShade, shades]);

  const itemSuggestion = entryItem ? (itemFuse.search(entryItem)[0]?.item ?? null) : null;

  const allShadesNumeric = shades.length > 0 && shades.every(s => /^\d+$/.test(s.trim()));

  const shadeSuggestion = (() => {
    if (!entryShade || allShadesNumeric) return null;
    const trimmed = entryShade.trim();
    if (/^\d+$/.test(trimmed)) {
      return shades.find(s => s.toLowerCase().startsWith(trimmed.toLowerCase())) ?? null;
    }
    return shadeFuse.search(entryShade)[0]?.item ?? null;
  })();

  const isStandard = shades.length === 1 && shades[0].toLowerCase() === "standard";
  const needsShadeDropdown = shades.length > 1;
  const isKnownItem = allItems.some(i => i.toLowerCase() === entryItem.toLowerCase());

  const clearCaches = () => {
    priceCache.current = {};
    shadeCache.current = {};
    warnedKey.current = null;
    sessionStorage.removeItem(ALL_ITEMS_KEY);
    setAllItems([]);
    setShades([]);
  };

  const getShadesForItem = async (itemName: string): Promise<string[]> => {
    if (shadeCache.current[itemName]) return shadeCache.current[itemName];
    const fetched = await fetchShades(itemName);
    shadeCache.current[itemName] = fetched;
    return fetched;
  };

  return {
    allItems,
    shades,
    filteredItems,
    filteredShades,
    itemSuggestion,
    shadeSuggestion,
    isStandard,
    needsShadeDropdown,
    isKnownItem,
    allShadesNumeric,
    clearCaches,
    getShadesForItem,
    shadeCache,
    priceCache,
  };
}
