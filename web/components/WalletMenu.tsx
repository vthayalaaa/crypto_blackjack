"use client";

import { useEffect, useRef, useState } from "react";
import { profilePath, type ProfileChain } from "../lib/profile";

export function WalletMenu({
  chain,
  address,
  label,
  onDisconnect,
  onChange,
}: {
  chain: ProfileChain;
  address: string;
  label: string;
  onDisconnect: () => void;
  onChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="wallet-menu" ref={root}>
      <button
        className="solid"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className="wallet-pop" role="menu">
          <a role="menuitem" href={profilePath(chain, address)}>Profile</a>
          {onChange ? (
            <button role="menuitem" type="button" onClick={() => { setOpen(false); onChange(); }}>
              Change wallet
            </button>
          ) : null}
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onDisconnect(); }}>
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
