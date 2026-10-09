// Simulated clock. Times are whole minutes since 00:00 on the Monday the records start, which is
// the Monday before the current week; the page opens on this week's Monday at 09:00.
// The office is open 08:00–18:00, Monday to Friday; the agent answers at any hour. Visits and
// follow-up steps keep to office hours.
export const DAY = 1440;
const OPEN = 8 * 60;
const CLOSE = 18 * 60;
export const START = 7 * DAY + 9 * 60;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const base = new Date();
base.setHours(0, 0, 0, 0);
base.setDate(base.getDate() - ((base.getDay() + 6) % 7) - 7);
const dateOf = (d) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);

const pad = (n) => String(n).padStart(2, '0');
const workday = (d) => d % 7 < 5;
export const dayOf = (t) => Math.floor(t / DAY);

export const hhmm = (t) => {
  const m = t - dayOf(t) * DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

// "Mon 12 Oct", or "Monday 12 October" with long = true.
export function fmtDay(t, long = false) {
  const d = dayOf(t);
  const dt = dateOf(d);
  return long
    ? `${WEEKDAYS_LONG[d % 7]} ${dt.getDate()} ${MONTHS_LONG[dt.getMonth()]}`
    : `${WEEKDAYS[d % 7]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

export const fmtTime = (t) => `${fmtDay(t)} ${hhmm(t)}`;

// Time of day alone when t is on the same day as ref.
export const fmtNear = (t, ref) => (dayOf(t) === dayOf(ref) ? hhmm(t) : fmtTime(t));

export const isOpen = (t) => {
  const d = dayOf(t);
  const m = t - d * DAY;
  return workday(d) && m >= OPEN && m < CLOSE;
};

// t itself during business hours, otherwise the next opening.
export function nextOpen(t) {
  let d = dayOf(t);
  const m = t - d * DAY;
  if (workday(d) && m >= OPEN && m < CLOSE) return t;
  if (workday(d) && m < OPEN) return d * DAY + OPEN;
  do d++;
  while (!workday(d));
  return d * DAY + OPEN;
}

// The moment `mins` business minutes after t.
export function addBusiness(t, mins) {
  let cur = nextOpen(t);
  for (;;) {
    const close = dayOf(cur) * DAY + CLOSE;
    if (cur + mins <= close) return cur + mins;
    mins -= close - cur;
    cur = nextOpen(close);
  }
}

// 45m, 2h 05m, 3d 4h
export function fmtDur(m) {
  m = Math.round(Math.abs(m));
  if (m < 60) return `${m}m`;
  if (m < DAY) return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  const d = Math.floor(m / DAY);
  const h = Math.floor((m % DAY) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

// The next 21:40 at or after t: an evening, long after the office has closed.
export function nextEvening(t) {
  let d = dayOf(t);
  if (d * DAY + 21 * 60 + 40 < t) d++;
  return d * DAY + 21 * 60 + 40;
}

// The opening of the workday `n` workdays after t's day.
export function workdaysAfter(t, n) {
  let d = dayOf(t);
  while (n > 0) {
    d++;
    if (workday(d)) n--;
  }
  return d * DAY + OPEN;
}

// 17:00 on the last workday before t's day.
export function eveBefore(t) {
  let d = dayOf(t) - 1;
  while (!workday(d)) d--;
  return d * DAY + 17 * 60;
}
