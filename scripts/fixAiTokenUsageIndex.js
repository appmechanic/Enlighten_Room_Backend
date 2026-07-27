/**
 * One-off migration: drop the stale unique index on `aitokenusages`.
 *
 * Background:
 *   The model keys usage by (monthKey, sessionId) — one row per session per
 *   calendar month — and declares a compound unique index
 *   { monthKey: 1, sessionId: 1 }. An earlier schema version had monthKey
 *   unique on its own, which created a `monthKey_1` UNIQUE index in the DB.
 *   Mongoose never drops old indexes, so that stale index survives and makes
 *   the SECOND session in any month collide on insert:
 *     E11000 duplicate key error ... index: monthKey_1 dup key: { monthKey: "2026-07" }
 *
 * This script drops `monthKey_1` (if it is unique) and ensures the model's
 * indexes are in sync. Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/fixAiTokenUsageIndex.js --dry-run
 *   node scripts/fixAiTokenUsageIndex.js --yes
 */

import "dotenv/config";
import mongoose from "mongoose";
import AiTokenUsage from "../models/AiTokenUsageModel.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmed = args.has("--yes");

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }
  if (!dryRun && !confirmed) {
    console.error(
      "Refusing to run without --yes. Use --dry-run to preview, or --yes to apply.",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.");

  const coll = AiTokenUsage.collection;
  const indexes = await coll.indexes();
  console.log("Current indexes on", coll.collectionName + ":");
  indexes.forEach((ix) =>
    console.log(
      `  - ${ix.name}: keys=${JSON.stringify(ix.key)} unique=${Boolean(ix.unique)}`,
    ),
  );

  // The offending index: unique, on monthKey alone. A non-unique monthKey_1
  // (from `index: true` on the field) is harmless and must be left alone.
  const stale = indexes.find(
    (ix) =>
      ix.unique &&
      ix.key &&
      ix.key.monthKey === 1 &&
      Object.keys(ix.key).length === 1,
  );

  if (!stale) {
    console.log(
      "\nNo stale UNIQUE monthKey-only index found — nothing to drop.",
    );
  } else if (dryRun) {
    console.log(
      `\n[dry-run] Would drop unique index "${stale.name}" on { monthKey: 1 }.`,
    );
  } else {
    await coll.dropIndex(stale.name);
    console.log(`\nDropped unique index "${stale.name}".`);
  }

  // Ensure the correct compound unique index exists. createIndex is
  // idempotent — a no-op if it's already there — and, unlike syncIndexes(),
  // it never drops other indexes on the collection.
  const hasCompound = indexes.some(
    (ix) =>
      ix.unique &&
      ix.key &&
      ix.key.monthKey === 1 &&
      ix.key.sessionId === 1 &&
      Object.keys(ix.key).length === 2,
  );
  if (dryRun) {
    console.log(
      hasCompound
        ? "[dry-run] Compound unique index { monthKey, sessionId } already present."
        : "[dry-run] Would create compound unique index { monthKey: 1, sessionId: 1 }.",
    );
  } else {
    await coll.createIndex({ monthKey: 1, sessionId: 1 }, { unique: true });
    console.log("Ensured compound unique index { monthKey: 1, sessionId: 1 }.");
    const after = await coll.indexes();
    console.log("Indexes after migration:");
    after.forEach((ix) =>
      console.log(
        `  - ${ix.name}: keys=${JSON.stringify(ix.key)} unique=${Boolean(ix.unique)}`,
      ),
    );
  }

  await mongoose.disconnect();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
