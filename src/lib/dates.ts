// Calendar-date helpers on "YYYY-MM-DD" strings, all in UTC.

const DAY_MS = 86_400_000;

export function toEpochDay(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

// Whole days from `from` to `to` (negative when `from` is later).
export function daysBetween(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
