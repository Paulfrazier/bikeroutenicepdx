/**
 * RowMenu.tsx — a "⋯" button that opens a small action list for one row of the
 * trip.
 *
 * It replaces the old three-button ↑ ↓ ✕ cluster on stop rows: those were 20px
 * wide, well under the 44px minimum touch target, and sat in a column that
 * three actions had already outgrown. Folding them into one menu also leaves
 * room for the role-editing items ("Make this the destination") that make the
 * stop list and the destination one interface rather than two.
 */

import { useEffect, useRef, useState } from "react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Renders in the danger color — for removals. */
  destructive?: boolean;
}

interface RowMenuProps {
  /** Accessible name for the trigger, e.g. "Stop 2 options". */
  label: string;
  items: RowMenuItem[];
}

export function RowMenu({ label, items }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="row-menu" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <ul className="row-menu__list" role="menu" aria-label={label}>
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={
                  item.destructive
                    ? "row-menu__item row-menu__item--destructive"
                    : "row-menu__item"
                }
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
