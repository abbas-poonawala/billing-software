/**
 * EditableCell
 * ────────────
 * Generic double-click-to-edit cell used in the bill table.
 * Fixes the "enter → old price comes back" bug by:
 *  1. Never touching originalPrice on save
 *  2. Keeping editedValue in LOCAL state (no store round-trip during editing)
 *  3. Only committing on Enter / blur, not on every keystroke
 */

import React, { useState, useEffect, useRef } from "react";

interface Props {
  value: string | number;
  onSave: (newValue: string) => void;
  onCancel?: () => void;
  validate?: (val: string) => string | null; // return error message or null
  inputStyle?: React.CSSProperties;
  displayStyle?: React.CSSProperties;
  inputMode?: "text" | "decimal" | "numeric";
  editButton?: boolean;
  editButtonLabel?: string;
  children?: React.ReactNode; // custom display
}

export default function EditableCell({
  value,
  onSave,
  onCancel,
  validate,
  inputStyle,
  displayStyle,
  inputMode = "text",
  editButton = true,
  editButtonLabel = "✏️",
  children,
}: Props) {
  const [editing, setEditing] = useState(false);
  // ⚠️ editedValue is LOCAL - not synced from props while editing
  const [editedValue, setEditedValue] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // when we START editing, snapshot the current value
  const startEditing = () => {
    setEditedValue(String(value));
    setEditing(true);
  };

  // focus input when editing starts
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const trimmed = editedValue.trim();
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        alert(err);
        return;
      }
    }
    onSave(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setEditedValue(String(value));
    onCancel?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode={inputMode}
        value={editedValue}
        onChange={e => setEditedValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        style={{
          width: "80px",
          padding: "2px 4px",
          fontSize: "12px",
          textAlign: "right",
          border: "1px solid #94a3b8",
          borderRadius: "3px",
          outline: "none",
          ...inputStyle,
        }}
      />
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", ...displayStyle }}>
      {children ?? value}
      {editButton && (
        <button
          className="no-print"
          onClick={e => { e.stopPropagation(); startEditing(); }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "12px",
            padding: "2px 3px",
            color: "#94a3b8",
            lineHeight: 1,
          }}
          title="Edit"
        >
          {editButtonLabel}
        </button>
      )}
    </span>
  );
}
