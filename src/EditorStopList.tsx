import type { MouseEvent } from "react";
import {
  formatAddressForNav,
  uniquePostalLabels,
  type ParsedAddress,
} from "./addressParser";
import { AddressIconToggles } from "./AddressIconToggles";
import type { AddressIconFlags, AddressIconKind } from "./addressIconKey";

type Stop = ParsedAddress & { id: string; completed: boolean };

type Cluster = { key: string; stops: Stop[]; minIndex?: number };

export type StopListCitySection = {
  sectionKey: string;
  heading: string;
  clusters: Cluster[];
};

function IconChevronUp() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M18 15l-6-6-6 6" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function EditorStopList(props: {
  /** Stop grupperet efter by/postnr., med bygningsklynger inden for hver gruppe. */
  sectionsByCity: StopListCitySection[];
  activeId: string | null;
  routeStepById: Map<string, number>;
  incompleteStops: Stop[];
  selectStop: (id: string) => void;
  moveStopInRoute: (id: string, dir: "up" | "down") => void;
  /** Tryk på stopnr. — åbner numpad til direkte placering */
  onOpenRoutePositionPicker?: (stopId: string) => void;
  toggleComplete: (id: string) => void;
  copyOneAddress: (
    e: MouseEvent<HTMLButtonElement>,
    s: Stop,
  ) => void | Promise<void>;
  copiedStopId: string | null;
  getAddressIconFlags: (s: Stop) => AddressIconFlags;
  onToggleAddressIcon: (s: Stop, kind: AddressIconKind) => void;
}) {
  const {
    sectionsByCity,
    activeId,
    routeStepById,
    incompleteStops,
    selectStop,
    moveStopInRoute,
    onOpenRoutePositionPicker,
    toggleComplete,
    copyOneAddress,
    copiedStopId,
    getAddressIconFlags,
    onToggleAddressIcon,
  } = props;

  return (
    <section className="flex flex-col gap-4">
      {sectionsByCity.map((section) => {
        const flat = section.clusters.flatMap((c) => c.stops);
        const secDone = flat.filter((s) => s.completed).length;
        const secTotal = flat.length;
        return (
          <div key={section.sectionKey}>
            <h2 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-zinc-700 drop-shadow-sm dark:text-zinc-300">
              {section.heading} ({secDone}/{secTotal})
            </h2>
            <ul className="flex flex-col gap-3">
              {section.clusters.map(({ key, stops: cStops }) => {
        const multi = cStops.length > 1;
        const done = cStops.filter((s) => s.completed).length;
        const clusterActive = cStops.some((s) => s.id === activeId);
        const head = cStops[0]!;
        return (
              <li
                key={`${section.sectionKey}::${key}`}
                className={`list-none overflow-hidden rounded-2xl shadow-sm transition dark:shadow-card ${
                  clusterActive
                    ? "border-4 border-accent"
                    : "border-2 border-zinc-300 dark:border-white/35"
                } bg-white dark:bg-slate-800 ${
                  !multi && head.completed
                    ? "opacity-[0.72] dark:opacity-[0.62]"
                    : "opacity-100"
                }`}
              >
                {multi ? (
                  <div className="border-b-2 border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-white/20 dark:bg-slate-900/80">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                          {head.street} {head.houseNumber}
                        </p>
                        <p className="mt-0.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                          {uniquePostalLabels(cStops)}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-xl border-2 border-accent bg-accent/90 px-2.5 py-1 text-sm font-black tabular-nums text-black dark:border-accent dark:bg-accent/80">
                        {cStops.length}×
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {done}/{cStops.length} leveret · hver række er ét stop
                    </p>
                  </div>
                ) : null}
                {cStops.map((s, idx) => {
                  const isActive = s.id === activeId;
                  const step = routeStepById.get(s.id);
                  const routePos = incompleteStops.findIndex((x) => x.id === s.id);
                  const showReorder =
                    step != null &&
                    incompleteStops.length >= 2 &&
                    routePos >= 0;
                  return (
                    <div
                      key={s.id}
                      className={`${multi && idx > 0 ? "border-t-2 border-zinc-200 dark:border-white/20" : ""} ${
                        multi && s.completed
                          ? "opacity-[0.72] dark:opacity-[0.62]"
                          : ""
                      }`}
                    >
                      <div className="flex min-h-[88px] items-stretch gap-2 px-2 py-2 sm:px-3">
                        <div className="flex min-w-0 flex-1 items-stretch gap-3">
                          {step != null && showReorder && onOpenRoutePositionPicker ? (
                            <button
                              type="button"
                              onClick={() => onOpenRoutePositionPicker(s.id)}
                              title="Tryk for at vælge nyt stopnr."
                              className="touch-manipulation flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border-2 border-accent bg-zinc-100 text-accent transition active:scale-[0.97] dark:bg-[#0a1522]"
                            >
                              <span className="text-[10px] font-bold uppercase leading-none text-zinc-500 dark:text-white/55">
                                Nr.
                              </span>
                              <span className="text-2xl font-black leading-none">
                                {step}
                              </span>
                            </button>
                          ) : step != null ? (
                            <span
                              className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border-2 border-accent bg-zinc-100 text-accent dark:bg-[#0a1522]"
                              aria-hidden
                            >
                              <span className="text-[10px] font-bold uppercase leading-none text-zinc-500 dark:text-white/55">
                                Nr.
                              </span>
                              <span className="text-2xl font-black leading-none">
                                {step}
                              </span>
                            </span>
                          ) : (
                            <span
                              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border-2 border-zinc-300 bg-zinc-100 text-lg font-black text-zinc-400 dark:border-white/25 dark:bg-black/30 dark:text-white/50"
                              aria-hidden
                            >
                              ✓
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => selectStop(s.id)}
                            className="touch-manipulation flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-lg px-2 py-3 text-left transition active:bg-zinc-100 dark:active:bg-white/10"
                          >
                            {isActive ? (
                              <span className="text-xs font-black uppercase tracking-wide text-accent">
                                Valgt · brug NAVIGÉR nedenfor
                              </span>
                            ) : (
                              <span className="text-xs font-bold text-zinc-500 dark:text-zinc-500">
                                Tryk her for at vælge stop
                              </span>
                            )}
                            {multi ? (
                              <>
                                <p className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                                  {s.unit?.trim() || "Levering"}
                                </p>
                                <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-300">
                                  {formatAddressForNav(s)}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-lg font-extrabold leading-tight text-zinc-900 dark:text-white">
                                  {s.street} {s.houseNumber}
                                </p>
                                <p className="text-base font-semibold text-zinc-600 dark:text-zinc-300">
                                  {s.zip} {s.city}
                                </p>
                                {s.unit ? (
                                  <p className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                                    {s.unit}
                                  </p>
                                ) : null}
                              </>
                            )}
                          </button>
                        </div>
                        {showReorder ? (
                          <div
                            className="flex shrink-0 flex-col gap-0.5 self-center"
                            title="Skift kørerækkefølge og stopnr. (Nr.)"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              aria-label="Flyt stop op i kørselsrækkefølgen"
                              disabled={routePos <= 0}
                              onClick={() => moveStopInRoute(s.id, "up")}
                              className="touch-manipulation flex h-9 w-10 items-center justify-center rounded-lg border-2 border-zinc-300 bg-zinc-100 text-zinc-800 disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                            >
                              <IconChevronUp />
                            </button>
                            <button
                              type="button"
                              aria-label="Flyt stop ned i kørselsrækkefølgen"
                              disabled={routePos >= incompleteStops.length - 1}
                              onClick={() => moveStopInRoute(s.id, "down")}
                              className="touch-manipulation flex h-9 w-10 items-center justify-center rounded-lg border-2 border-zinc-300 bg-zinc-100 text-zinc-800 disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                            >
                              <IconChevronDown />
                            </button>
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => void copyOneAddress(e, s)}
                          className={`touch-manipulation shrink-0 self-center rounded-lg border-2 px-2 py-2 text-xs font-extrabold ${
                            copiedStopId === s.id
                              ? "border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-500 dark:bg-emerald-950/60 dark:text-emerald-100"
                              : "border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-white/30 dark:bg-slate-700 dark:text-zinc-100"
                          }`}
                        >
                          {copiedStopId === s.id ? "Kopieret" : "Kopiér"}
                        </button>
                      </div>

                      <div className="border-t border-zinc-200 px-2 py-2 sm:px-3 dark:border-white/15">
                        <AddressIconToggles
                          flags={getAddressIconFlags(s)}
                          onToggle={(kind) => onToggleAddressIcon(s, kind)}
                        />
                      </div>

                      <div className="border-t-2 border-accent bg-zinc-50 px-3 py-2 dark:bg-slate-900/90">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                            Status
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleComplete(s.id);
                            }}
                            aria-pressed={s.completed}
                            className={`touch-manipulation inline-flex min-h-[46px] max-w-[11rem] shrink-0 items-center justify-center gap-2 rounded-xl border-2 px-4 text-sm font-extrabold shadow-md transition active:scale-[0.97] ${
                              s.completed
                                ? "border-accentDeep bg-accent text-black"
                                : "border-zinc-300 bg-zinc-200 text-zinc-900 dark:border-white/35 dark:bg-slate-800 dark:text-white"
                            } `}
                          >
                            <span
                              className={`flex size-7 shrink-0 items-center justify-center rounded-md border-2 text-base font-black ${
                                s.completed
                                  ? "border-black/30 bg-black/10 text-black"
                                  : "border-zinc-400 bg-white/80 text-transparent dark:border-white/40 dark:bg-black/40"
                              }`}
                              aria-hidden
                            >
                              ✓
                            </span>
                            {s.completed ? "Leveret!" : "Leveret"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </li>
        );
      })}
            </ul>
          </div>
        );
      })}

      {sectionsByCity.length === 0 ? (
        <p className="text-center text-base font-medium text-zinc-600 dark:text-zinc-400">
          Indsæt adresser og tryk &quot;Indlæs adresser&quot; — så er du i gang!
        </p>
      ) : null}
    </section>
  );
}
