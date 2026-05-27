import React, { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";

interface Props {
  value: string;
  onChange: (val: string) => void;
  onSelect: (val: string) => void;
  options: string[];
  suggestion?: string | null;
  placeholder?: string;
  style?: React.CSSProperties;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  disabled?: boolean;
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

  const visible = useMemo(() => options.slice(0, maxVisible), [options, maxVisible]);
  const showDropdown = open && !disabled && visible.length > 0;
  const showSuggestion = Boolean(suggestion && value && value !== suggestion);

  const selectOption = (opt: string) => {
    onSelect(opt);
    setOpen(false);
    setHighlightIdx(-1);
  };

  useEffect(() => {
    setHighlightIdx(prev => {
      if (!showDropdown) return -1;
      if (prev >= visible.length) return visible.length - 1;
      return prev;
    });
  }, [showDropdown, visible.length]);

  const acceptBestOption = () => {
    if (highlightIdx >= 0 && visible[highlightIdx]) {
      selectOption(visible[highlightIdx]);
      return true;
    }
    if (suggestion) {
      selectOption(suggestion);
      return true;
    }
    if (visible[0]) {
      selectOption(visible[0]);
      return true;
    }
    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx(prev => Math.min(prev + 1, visible.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlightIdx(prev => Math.max(prev - 1, 0));
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setHighlightIdx(-1);
      return;
    }

    if (e.key === "Tab") {
      if (acceptBestOption()) {
        e.preventDefault();
      }
      setOpen(false);
      return;
    }

    if (e.key === "Enter") {
      if (acceptBestOption()) {
        e.preventDefault();
        return;
      }
    }

    onKeyDownExtra?.(e);
  };

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <Command shouldFilter={false} loop>
        <Command.Input
          ref={ref as React.RefObject<HTMLInputElement>}
          value={value}
          onValueChange={v => {
            onChange(v);
            setOpen(true);
            setHighlightIdx(-1);
          }}
          onFocus={() => {
            if (!disabled) setOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setOpen(false);
              setHighlightIdx(-1);
            }, 120);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={style}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />

        {showSuggestion && (
          <span
            style={{
              position: "absolute",
              left: "14px",
              top: "12px",
              color: "#a8adb8",
              pointerEvents: "none",
              fontSize: "14px",
              opacity: 0.7,
              fontWeight: 500,
            }}
          >
            {suggestion}
          </span>
        )}

        {showDropdown && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              backgroundColor: "#fff",
              border: "1px solid #cbd5e1",
              borderRadius: 4,
              maxHeight: 240,
              overflowY: "auto",
              zIndex: 100,
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            }}
          >
            <Command.List>
              <Command.Empty style={{ padding: "10px 12px", fontSize: 12, color: "#64748b" }}>
                No matches
              </Command.Empty>
              {visible.map((opt, idx) => {
                const highlighted = idx === highlightIdx;
                return (
                  <Command.Item
                    key={opt}
                    value={opt}
                    onMouseDown={e => {
                      e.preventDefault();
                      selectOption(opt);
                    }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    style={{
                      cursor: "pointer",
                      backgroundColor: highlighted ? "#e2e8f0" : value.toLowerCase() === opt.toLowerCase() ? "#f0f4f8" : "#fff",
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 13,
                      fontWeight: highlighted ? 600 : 400,
                      padding: 0,
                    }}
                  >
                    {renderOption ? renderOption(opt, highlighted) : (
                      <div style={{ padding: "8px 12px" }}>{opt}</div>
                    )}
                  </Command.Item>
                );
              })}
            </Command.List>
          </div>
        )}
      </Command>
    </div>
  );
}
