// Idempotently seeds the RegisteredSchool collection with a few sample entries
// so the school-admin signup path has something to match against.
//
// Each doc is upserted by canonical `name`. Re-running the script does not
// create duplicates and does not remove aliases/domains an admin has added
// through other means.
//
// Usage:
//   node --env-file=.env scripts/seedRegisteredSchools.js
//   node --env-file=.env scripts/seedRegisteredSchools.js --dry-run

import "dotenv/config";
import mongoose from "mongoose";
import RegisteredSchool from "../models/RegisteredSchool.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const SEED = [
  {
    name: "Enlighten Demo School",
    aliases: ["Enlighten Demo", "EDS"],
    allowedEmailDomains: ["enlightendemo.edu", "enlightendemo.org"],
    country: "US",
  },
  {
    name: "Diocesan Boys' School",
    aliases: ["DBS", "Diocesan Boys School"],
    allowedEmailDomains: ["dbs.edu.hk"],
    country: "HK",
  },
  {
    name: "Delhi Public School R.K. Puram",
    aliases: ["DPS RK Puram", "DPS R.K. Puram", "DPS Delhi"],
    allowedEmailDomains: ["dpsrkp.net"],
    country: "IN",
  },
];

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.");

  for (const school of SEED) {
    const existing = await RegisteredSchool.findOne({ name: school.name });
    if (existing) {
      console.log(`  = ${school.name} (already present, id=${existing._id})`);
      continue;
    }
    if (dryRun) {
      console.log(`  [dry-run] would insert: ${school.name}`);
      continue;
    }
    const doc = await RegisteredSchool.create({ ...school, status: "active" });
    console.log(`  + inserted ${school.name} (id=${doc._id})`);
  }

  const total = await RegisteredSchool.countDocuments({ status: "active" });
  console.log(`\nActive registered schools in DB: ${total}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
