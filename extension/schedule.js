// Schedules: { type: 'off' } | { type: 'daily', time: 'HH:MM' }
//          | { type: 'weekly', days: [0-6, Sunday = 0], time } | { type: 'hours', every: N }
// Times are local to the computer.

export function nextRun(s, from = Date.now()) {
  if (!s || s.type === 'off') return null;
  if (s.type === 'hours') return from + Math.max(1, Number(s.every) || 1) * 3600e3;
  const [h, m] = (s.time || '09:00').split(':').map(Number);
  const days = s.type === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : s.days || [];
  if (!days.length) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > from && days.includes(d.getDay())) return d.getTime();
  }
  return null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeSchedule(s) {
  if (!s || s.type === 'off') return 'Not scheduled';
  if (s.type === 'daily') return `Daily at ${s.time}`;
  if (s.type === 'weekly') return `${(s.days || []).map((d) => DAY_NAMES[d]).join(', ') || 'No days'} at ${s.time}`;
  if (s.type === 'hours') return `Every ${s.every} h`;
  return s.type;
}

export { DAY_NAMES };
