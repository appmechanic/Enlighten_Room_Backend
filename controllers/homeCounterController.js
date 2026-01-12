import Counter from "../models/homeCounter.js";

/** PUT /api/counters  (bulk create-or-update by key; NO _id needed)
 * Body can be one object or an array of objects:
 * [{ key, title, value, order? }, ...]
 */
export async function upsertCounters(req, res) {
  try {
    const payload = Array.isArray(req.body) ? req.body : [req.body];
    if (!payload.length)
      return res
        .status(400)
        .json({ error: "Send items as {key,title,value} (array or object)" });

    // dedupe by key (last wins)
    const map = new Map();
    for (const it of payload) {
      const key = String(it?.key || "")
        .trim()
        .toLowerCase();
      const title = String(it?.title || "").trim();
      const value = Number(it?.value);
      const order = it?.order !== undefined ? Number(it.order) : undefined;

      if (!key) return res.status(400).json({ error: "key is required" });
      if (!title)
        return res.status(400).json({ error: `${key}.title required` });
      if (!Number.isFinite(value))
        return res.status(400).json({ error: `${key}.value must be a number` });

      map.set(key, { title, value, ...(order !== undefined ? { order } : {}) });
    }

    const ops = [];
    for (const [key, data] of map.entries()) {
      ops.push({
        updateOne: {
          filter: { key },
          update: { $set: data },
          upsert: true,
        },
      });
    }

    const result = await Counter.bulkWrite(ops, { ordered: false });
    const keys = [...map.keys()];
    const items = await Counter.find({ key: { $in: keys } }).lean();

    return res.json({
      summary: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        upserted: result.upsertedCount,
      },
      items,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e.message || "Failed to upsert counters" });
  }
}

/** GET /api/counters -> list all (sorted by order, then key) */
export async function listCounters(req, res) {
  const items = await Counter.find().sort({ order: 1, key: 1 }).lean();
  res.json(items);
}

/** GET /api/counters/:key -> get one by key (no _id needed) */
export async function getCounter(req, res) {
  const key = String(req.params.key || "").toLowerCase();
  const doc = await Counter.findOne({ key }).lean();
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
}

/** DELETE /api/counters/:key -> delete by key */
export async function deleteCounter(req, res) {
  const key = String(req.params.key || "").toLowerCase();
  const doc = await Counter.findOneAndDelete({ key }).lean();
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, deletedKey: key });
}
