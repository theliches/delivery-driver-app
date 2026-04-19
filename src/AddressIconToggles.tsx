import type { ReactNode } from "react";
import type { AddressIconFlags, AddressIconKind } from "./addressIconKey";

function IconDoor({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
      className={on ? "text-zinc-900 dark:text-white" : "text-zinc-400 dark:text-zinc-500"}
    >
      <rect x="5" y="2" width="14" height="20" rx="1" />
      <circle cx="16" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconFrost({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
      className={on ? "text-sky-600 dark:text-sky-300" : "text-zinc-400 dark:text-zinc-500"}
    >
      <path d="M12 2v4M12 18v4M4.5 4.5l2.8 2.8M16.7 16.7l2.8 2.8M2 12h4M18 12h4M4.5 19.5l2.8-2.8M16.7 7.3l2.8-2.8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" opacity={on ? 0.35 : 0.15} />
    </svg>
  );
}

function IconAlert({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
      className={on ? "text-amber-700 dark:text-amber-300" : "text-zinc-400 dark:text-zinc-500"}
    >
      <path d="M12 3L3 20h18L12 3z" />
      <path d="M12 9v5M12 17h.01" />
    </svg>
  );
}

export function AddressIconToggles(props: {
  flags: AddressIconFlags;
  onToggle: (kind: AddressIconKind) => void;
  disabled?: boolean;
}) {
  const { flags, onToggle, disabled } = props;
  const btn = (kind: AddressIconKind, on: boolean, label: string, el: ReactNode) => (
    <button
      key={kind}
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(kind);
      }}
      className={`flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border-2 transition active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-35 ${
        on
          ? "border-accent bg-accent/25 shadow-sm dark:border-accent dark:bg-accent/15"
          : "border-zinc-300 bg-zinc-100 dark:border-white/25 dark:bg-slate-800"
      }`}
    >
      {el}
    </button>
  );
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Adresse-markeringer"
      onClick={(e) => e.stopPropagation()}
    >
      {btn("door", flags.door, "Dør / ring på", <IconDoor on={flags.door} />)}
      {btn("frost", flags.frost, "Glat / frost", <IconFrost on={flags.frost} />)}
      {btn("alert", flags.alert, "OBS", <IconAlert on={flags.alert} />)}
    </div>
  );
}
