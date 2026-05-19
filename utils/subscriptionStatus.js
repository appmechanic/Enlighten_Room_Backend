// Compute "active" | "expired" | "unknown" for a transaction document.
// Active = its billing period covers "now".

function safeDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(a, b) {
  const s = safeDate(a);
  const e = safeDate(b);
  if (!s || !e) return null;
  const ms = e.getTime() - s.getTime();
  if (ms <= 0) return 0;
  return Math.round(ms / 86_400_000);
}

function addUnits(date, unit, n) {
  const d = new Date(date);
  if (unit === "month") d.setMonth(d.getMonth() + n);
  else if (unit === "year") d.setFullYear(d.getFullYear() + n);
  else if (unit === "week") d.setDate(d.getDate() + n * 7);
  else d.setDate(d.getDate() + n);
  return d;
}

export function computeExpiry(txn) {
  const direct =
    safeDate(txn?.stripe?.periodEnd) || safeDate(txn?.paypal?.periodEnd);
  if (direct) return direct;

  const start =
    safeDate(txn?.stripe?.periodStart) ||
    safeDate(txn?.paypal?.periodStart) ||
    safeDate(txn?.createdAt);
  if (!start) return null;

  const unit = (
    txn?.stripe?.interval ||
    txn?.paypal?.interval ||
    ""
  )
    .toString()
    .toLowerCase();
  const count =
    Number(txn?.stripe?.intervalCount) ||
    Number(txn?.paypal?.intervalCount) ||
    1;
  if (unit) return addUnits(start, unit, count);

  // Last-ditch: month/year cue from human-friendly fields.
  const label = (txn?.duration ?? txn?.period ?? "").toString().toLowerCase();
  if (label.includes("month")) return addUnits(start, "month", 1);
  if (label.includes("year") || label.includes("annual"))
    return addUnits(start, "year", 1);

  const span = daysBetween(txn?.stripe?.periodStart, txn?.stripe?.periodEnd);
  if (span && span > 0) return new Date(start.getTime() + span * 86_400_000);

  return null;
}

export function computeSubscriptionStatus(txn) {
  if (!txn) return "unknown";
  const status = String(txn?.status || "").toLowerCase();
  if (status === "canceled" || status === "cancelled") {
    // Explicit cancellation (user replaced plan) — distinct from natural expiry.
    return "canceled";
  }
  if (status === "refunded" || status === "failed") {
    return "expired";
  }
  const exp = computeExpiry(txn);
  if (!exp) return "unknown";
  return exp.getTime() > Date.now() ? "active" : "expired";
}
