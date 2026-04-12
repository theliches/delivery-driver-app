const LS_KEY = "delivery-driver-daily-routes";

type DailyPayload = { date: string; count: number };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const MAX_PER_DAY = 10;

export function canGenerateRouteToday(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const today = todayIso();
    if (!raw) return true;
    const o = JSON.parse(raw) as DailyPayload;
    if (o.date !== today) return true;
    return (o.count ?? 0) < MAX_PER_DAY;
  } catch {
    return true;
  }
}

/** Efter vellykket rute-generering (Optimér). */
export function recordRouteGenerated(): void {
  try {
    const today = todayIso();
    const raw = localStorage.getItem(LS_KEY);
    let count = 1;
    if (raw) {
      const o = JSON.parse(raw) as DailyPayload;
      if (o.date === today) count = (o.count ?? 0) + 1;
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ date: today, count }));
  } catch {
    /* fail open */
  }
}

export function getDailyRouteUsageLabel(): string {
  try {
    const today = todayIso();
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return `0/${MAX_PER_DAY} ruter i dag`;
    const o = JSON.parse(raw) as DailyPayload;
    if (o.date !== today) return `0/${MAX_PER_DAY} ruter i dag`;
    return `${Math.min(o.count ?? 0, MAX_PER_DAY)}/${MAX_PER_DAY} ruter i dag`;
  } catch {
    return "";
  }
}

export const DAILY_ROUTE_LIMIT = MAX_PER_DAY;
