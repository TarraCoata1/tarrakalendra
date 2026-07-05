// Timezone-aware formatting helpers for Asia/Jerusalem.
const TZ = "Asia/Jerusalem";

export function formatDate(d: Date | string, opts?: Intl.DateTimeFormatOptions) {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    dateStyle: "medium",
    ...opts,
  }).format(date);
}

export function formatTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDateTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Get day-of-week 0-6 (Sunday=0) for a UTC date, in Asia/Jerusalem.
 */
export function jerusalemDayOfWeek(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short",
  }).formatToParts(d);
  const wd = parts.find(p => p.type === "weekday")?.value ?? "Sun";
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
}

/**
 * Given a JS Date and an HH:MM string, return a UTC Date representing that
 * local Asia/Jerusalem time on that date.
 */
export function jerusalemDateTimeToUTC(dateInJerusalem: Date, hhmm: string): Date {
  // Get Y-M-D of the date as seen in Jerusalem
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(dateInJerusalem);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;
  const [hh, mm] = hhmm.split(":");
  // Build an ISO-ish string then determine the actual UTC by computing the
  // offset of that instant in Jerusalem.
  const naiveUtc = new Date(`${y}-${m}-${d}T${hh}:${mm}:00Z`);
  const jerusalemLocal = new Date(naiveUtc.toLocaleString("en-US", { timeZone: TZ }));
  const offsetMs = jerusalemLocal.getTime() - naiveUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs);
}

export const TIMEZONE = TZ;
