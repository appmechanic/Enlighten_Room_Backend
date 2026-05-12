/**
 * One-off cleanup: delete every document in the Transaction collection.
 *
 * Safety:
 *   - Refuses to run unless you pass --yes (so it can't fire on accident).
 *   - Pass --dry-run to see the count without deleting.
 *
 * Usage:
 *   node scripts/deleteAllTransactions.js --dry-run
 *   node scripts/deleteAllTransactions.js --yes
 */

import "dotenv/config";
import mongoose from "mongoose";
import Transaction from "../models/transactionModel.js";

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
      "Refusing to run without --yes. Use --dry-run to preview, or --yes to delete."
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.");

  const count = await Transaction.countDocuments();
  console.log(`Transactions in DB: ${count}`);

  if (dryRun) {
    console.log("Dry run — nothing deleted.");
  } else {
    const result = await Transaction.deleteMany({});
    console.log(`Deleted ${result.deletedCount} transaction(s).`);
  }

  await mongoose.disconnect();
  console.log("Disconnected.");
}

main().catch(async (err) => {
  console.error("Script failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
