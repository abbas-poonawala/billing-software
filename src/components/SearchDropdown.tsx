/**
 * SearchDropdown
 * ──────────────
 * Reusable input + dropdown combo used for:
 *  - Item search
 *  - Shade search
 *  - Customer name search
 *
 * Features:
 *  - Arrow Up / Down keyboard navigation
 *  - Enter to select highlighted
 *  - Escape to close
 *  - Tab to accept fuzzy suggestion
 *  - Fuzzy suggestion ghost text
 */

import React, { useRef, useState, useEffect } from "react";

interface Props {
  value: string;
  onChange: (val: string) => void;
  onSelect: (val: string) => void;
  options: string[];
  /** Ghost suggestion (Tab to accept) */
  suggestion?: string | null;
  placeholder?: string;
  style?: React.CSSProperties;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Max options shown in list */
  maxVisible?: number;
  renderOption?: (opt: string, highlighted: boolean) => React.ReactNode;
  onKeyDownExtra?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export default function SearchDropdown({
  value,
  onChange,
  onSelect,
  options,
  suggestion,
  placeholder,
  style,
  inputRef: externalRef,
  autoFocus,
  disabled,
  maxVisible = 8,
  renderOption,
  onKeyDownExtra,
}: Props) {
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = externalRef || internalRef;
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);

  const visible = options.slice(0, maxVisible);

  // Reset highlight when options change
  useEffect(() => {
    setHighlightIdx(-1);
  }, [options]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx(prev => (prev < visible.length - 1 ? prev + 1 : prev));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(prev => (prev > 0 ? prev - 1 : -1));
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setHighlightIdx(-1);
      return;
    }
    if (e.key === "Tab") {
      if (suggestion && value !== suggestion) {
        e.preventDefault();
        onSelect(suggestion);
        setOpen(false);
        return;
      }
      setOpen(false);
    }
    if (e.key === "Enter") {
      if (highlightIdx >= 0 && highlightIdx < visible.length) {
        e.preventDefault();
        onSelect(visible[highlightIdx]);
        setOpen(false);
        setHighlightIdx(-1);
        return;
      }
    }
    onKeyDownExtra?.(e);
  };

  const showDropdown = open && visible.length > 0;
  const showSuggestion = suggestion && value && value !== suggestion;

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
          setHighlightIdx(-1);
        }}
        onFocus={() => value && setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); setHighlightIdx(-1); }, 150)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={style}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
      />

      {/* Ghost suggestion text */}
      {showSuggestion && (
        <span style={{
          position: "absolute",
          left: "14px",
          top: "12px",
          color: "#a8adb8",
          pointerEvents: "none",
          fontSize: "14px",
          opacity: 0.7,
          fontWeight: 500,
        }}>
          {suggestion}
        </span>
      )}

      {/* Dropdown list */}
      {showDropdown && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          marginTop: "2px",
          backgroundColor: "#fff",
          border: "1px solid #cbd5e1",
          borderRadius: "4px",
          maxHeight: "200px",
          overflowY: "auto",
          zIndex: 100,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        }}>
          {visible.map((opt, idx) => {
            const highlighted = idx === highlightIdx;
            if (renderOption) {
              return (
                <div
                  key={opt}
                  style={{ cursor: "pointer", backgroundColor: highlighted ? "#e2e8f0" : "transparent" }}
                  onClick={() => { onSelect(opt); setOpen(false); setHighlightIdx(-1); }}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onMouseLeave={() => setHighlightIdx(-1)}
                >
                  {renderOption(opt, highlighted)}
                </div>
              );
            }
            return (
              <div
                key={opt}
                onClick={() => { onSelect(opt); setOpen(false); setHighlightIdx(-1); }}
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseLeave={() => setHighlightIdx(-1)}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  backgroundColor: highlighted ? "#e2e8f0" : value.toLowerCase() === opt.toLowerCase() ? "#f0f4f8" : "#fff",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: "13px",
                  fontWeight: highlighted ? 600 : 400,
                }}
              >
                {opt}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
