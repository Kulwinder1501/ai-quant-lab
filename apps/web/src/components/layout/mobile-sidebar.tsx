"use client";

import { useEffect, type ReactNode } from "react";
import { classNames } from "../ui/class-names";

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function MobileSidebar({ open, onClose, children }: MobileSidebarProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    if (open) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <>
      <div 
        className={classNames(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <div 
        className={classNames(
          "fixed inset-y-0 left-0 z-50 w-72 transform transition-transform duration-300 ease-in-out shadow-2xl",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="h-full w-full bg-slate-950 overflow-hidden">
          {children}
        </div>
      </div>
    </>
  );
}
