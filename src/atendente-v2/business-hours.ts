export interface WorkingHour {
  dayOfWeek: number;
  closedAllDay: boolean;
  openAllDay: boolean;
  openHour: number;
  openMinutes: number;
  closeHour: number;
  closeMinutes: number;
}

export interface InboxBusinessHours {
  enabled: boolean;
  timezone: string;
  workingHours: WorkingHour[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function localParts(at: Date, timezone: string): { day: number; minute: number } | null {
  try {
    const parts = formatterFor(timezone).formatToParts(at);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const day = weekday ? WEEKDAYS[weekday] : undefined;
    return day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)
      ? null : { day, minute: hour * 60 + minute };
  } catch {
    return null;
  }
}

function scheduleContainsMinute(
  schedule: WorkingHour | undefined,
  minute: number,
  includeOvernightTail: boolean,
): boolean {
  if (!schedule || schedule.closedAllDay) return false;
  if (schedule.openAllDay) return true;
  const opens = schedule.openHour * 60 + schedule.openMinutes;
  const closes = schedule.closeHour * 60 + schedule.closeMinutes;
  if (opens === closes) return false;
  if (closes > opens) return !includeOvernightTail && minute >= opens && minute < closes;
  return includeOvernightTail ? minute < closes : minute >= opens;
}

function isBusinessMinute(at: Date, config: InboxBusinessHours): boolean | null {
  const local = localParts(at, config.timezone);
  if (!local) return null;
  const current = config.workingHours.find((row) => row.dayOfWeek === local.day);
  if (scheduleContainsMinute(current, local.minute, false)) return true;
  const previousDay = (local.day + 6) % 7;
  const previous = config.workingHours.find((row) => row.dayOfWeek === previousDay);
  return scheduleContainsMinute(previous, local.minute, true);
}

/** Conta minutos realmente abertos no fuso do inbox. Falha fechada se a agenda for inválida. */
export function hasElapsedBusinessHours(
  startedAt: Date,
  now: Date,
  requiredHours: number,
  config: InboxBusinessHours,
): boolean {
  if (!(startedAt instanceof Date) || !(now instanceof Date)
      || Number.isNaN(startedAt.getTime()) || Number.isNaN(now.getTime())
      || now <= startedAt || requiredHours <= 0) return false;

  const requiredMinutes = requiredHours * 60;
  if (!config.enabled) return now.getTime() - startedAt.getTime() >= requiredMinutes * 60_000;
  if (config.workingHours.length === 0) return false;

  let elapsed = 0;
  // Minuto parcial inicial não conta; isso nunca resolve antes da hora combinada.
  let cursor = Math.ceil(startedAt.getTime() / 60_000) * 60_000;
  const end = Math.floor(now.getTime() / 60_000) * 60_000;
  while (cursor < end) {
    const open = isBusinessMinute(new Date(cursor), config);
    if (open === null) return false;
    if (open && ++elapsed >= requiredMinutes) return true;
    cursor += 60_000;
  }
  return false;
}
