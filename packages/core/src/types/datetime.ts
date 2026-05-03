const isoDateTimePattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?<zone>Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;

export function isIsoDateTimeString(value: string): boolean {
  const match = isoDateTimePattern.exec(value);
  if (match?.groups === undefined || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match.groups["year"]);
  const month = Number(match.groups["month"]);
  const day = Number(match.groups["day"]);
  const hour = Number(match.groups["hour"]);
  const minute = Number(match.groups["minute"]);
  const second = Number(match.groups["second"]);
  if (!isValidDatePart(year, month, day)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  if (match.groups["zone"] !== "Z") {
    const offsetHour = Number(match.groups["offsetHour"]);
    const offsetMinute = Number(match.groups["offsetMinute"]);
    if (offsetHour < 0 || offsetHour > 23) return false;
    if (offsetMinute < 0 || offsetMinute > 59) return false;
  }
  return true;
}

function isValidDatePart(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}
