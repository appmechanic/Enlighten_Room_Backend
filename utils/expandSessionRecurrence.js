// Expand a single Session document (with optional recurrence rule) into
// occurrence Date objects that fall inside [rangeStart, rangeEnd].
//
// Session.recurrence shape:
//   { type: "none"|"daily"|"weekly"|"monthly", slots: [{weekday, time}], untilDate }
//
// "weekly"  → repeats every 7 days from sessionDate
// "monthly" → every 28 days (4 weeks) so the weekday stays stable, matching
//             the frontend preview in SessionTab.jsx
// "daily"   → every day from sessionDate
// "none"    → just sessionDate
//
// Slot times are encoded in sessionDate itself (we always use the first
// occurrence's time-of-day for every generated occurrence), so we only need
// the recurrence type + untilDate to walk forward.
export function expandSessionOccurrences(session, rangeStart, rangeEnd) {
  const start = new Date(session.sessionDate);
  if (Number.isNaN(start.getTime())) return [];

  const type = session?.recurrence?.type || "none";
  const until = session?.recurrence?.untilDate
    ? new Date(session.recurrence.untilDate)
    : null;

  if (type === "none") {
    return start >= rangeStart && start <= rangeEnd ? [start] : [];
  }

  const hardStop = until && until < rangeEnd ? until : rangeEnd;
  const stepDays = type === "monthly" ? 28 : type === "weekly" ? 7 : 1;

  const out = [];
  const cursor = new Date(start);
  // Fast-forward to rangeStart for big windows.
  if (cursor < rangeStart) {
    const diffMs = rangeStart.getTime() - cursor.getTime();
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    const skip = Math.floor(diffDays / stepDays) * stepDays;
    if (skip > 0) cursor.setDate(cursor.getDate() + skip);
  }

  let safety = 0;
  while (cursor <= hardStop && safety < 1000) {
    safety++;
    if (cursor >= rangeStart) out.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return out;
}
