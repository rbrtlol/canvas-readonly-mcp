// Display times in the user's zone; storage stays ISO UTC. The zone comes from DISPLAY_TZ or the
// Canvas profile (set at startup via setDisplayTimeZone), falling back to UTC.

export let DISPLAY_TZ = "UTC";
let partsFmt = makeFormatter(DISPLAY_TZ);

function makeFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** Switch the display zone; returns false (and keeps the current one) for an unknown IANA name. */
export function setDisplayTimeZone(tz: string): boolean {
  try {
    partsFmt = makeFormatter(tz);
    DISPLAY_TZ = tz;
    return true;
  } catch {
    return false;
  }
}

/** Local date ("2026-11-13"), time ("19:00") and weekday ("Fri") of an instant in DISPLAY_TZ. */
export function localParts(d: Date): { date: string; time: string; weekday: string } {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

/** "Fri 2026-11-13 19:00" */
export function fmtLocal(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = localParts(d);
  return `${p.weekday} ${p.date} ${p.time}`;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Recursively rewrite ISO timestamps in tool output to local display time. */
export function localizeTimes<T>(value: T): T {
  if (typeof value === "string") return (ISO_RE.test(value) ? fmtLocal(value) : value) as T;
  if (Array.isArray(value)) return value.map(localizeTimes) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeTimes(v)])) as T;
  }
  return value;
}
