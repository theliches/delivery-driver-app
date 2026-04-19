import { useEffect, useState } from "react";

type RoutePositionNumpadProps = {
  open: boolean;
  maxPosition: number;
  onClose: () => void;
  /** 1-baseret position blandt åbne stop */
  onConfirm: (oneBased: number) => void;
};

/**
 * Simpel numpad-dialog til at vælge nyt stopnr. (1 … max) uden pile.
 */
export function RoutePositionNumpad({
  open,
  maxPosition,
  onClose,
  onConfirm,
}: RoutePositionNumpadProps) {
  const [digits, setDigits] = useState("");

  useEffect(() => {
    if (open) setDigits("");
  }, [open]);

  if (!open || maxPosition < 1) return null;

  const append = (d: string) => {
    setDigits((cur) => {
      const next = cur + d;
      const n = parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) return cur;
      if (n > maxPosition) return cur;
      return next;
    });
  };

  const backspace = () => setDigits((cur) => cur.slice(0, -1));

  const confirm = () => {
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n < 1 || n > maxPosition) return;
    onConfirm(n);
    onClose();
  };

  const hint =
    maxPosition === 1
      ? "Kun ét åbent stop — intet at omrokere."
      : `Vælg nr. 1–${maxPosition}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="route-numpad-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Luk"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border-2 border-zinc-300 bg-white p-4 shadow-2xl dark:border-white/25 dark:bg-slate-900">
        <h2
          id="route-numpad-title"
          className="text-center text-base font-extrabold text-zinc-900 dark:text-white"
        >
          Nyt stopnr.
        </h2>
        <p className="mt-1 text-center text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
        <div
          className="mt-4 flex min-h-[52px] items-center justify-center rounded-xl border-2 border-zinc-300 bg-zinc-50 px-3 text-3xl font-black tabular-nums text-zinc-900 dark:border-white/30 dark:bg-slate-800 dark:text-white"
          aria-live="polite"
        >
          {digits || "—"}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => append(d)}
              className="touch-manipulation min-h-[52px] rounded-xl border-2 border-zinc-300 bg-zinc-100 text-lg font-extrabold text-zinc-900 active:scale-[0.98] dark:border-white/30 dark:bg-slate-800 dark:text-white"
            >
              {d}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={backspace}
            className="touch-manipulation min-h-[52px] rounded-xl border-2 border-zinc-300 bg-zinc-100 text-sm font-extrabold text-zinc-800 dark:border-white/30 dark:bg-slate-800 dark:text-zinc-100"
          >
            Slet
          </button>
          <button
            type="button"
            onClick={() => append("0")}
            disabled={digits.length === 0}
            className="touch-manipulation min-h-[52px] rounded-xl border-2 border-zinc-300 bg-zinc-100 text-lg font-extrabold text-zinc-900 disabled:opacity-35 dark:border-white/30 dark:bg-slate-800 dark:text-white"
          >
            0
          </button>
          <button
            type="button"
            onClick={onClose}
            className="touch-manipulation min-h-[52px] rounded-xl border-2 border-zinc-400 bg-white text-sm font-extrabold text-zinc-800 dark:border-white/35 dark:bg-slate-800 dark:text-zinc-100"
          >
            Annuller
          </button>
        </div>
        <button
          type="button"
          onClick={confirm}
          disabled={
            digits.length === 0 ||
            (() => {
              const n = parseInt(digits, 10);
              return !Number.isFinite(n) || n < 1 || n > maxPosition;
            })()
          }
          className="mt-3 w-full touch-manipulation min-h-[52px] rounded-xl border-2 border-accentDeep bg-accent text-base font-extrabold text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          OK — placer som nr. {digits || "?"}
        </button>
      </div>
    </div>
  );
}
