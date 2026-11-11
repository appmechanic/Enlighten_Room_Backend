// scripts/configureSpacesCors.js
//
// One-shot: configures CORS on the DigitalOcean Spaces bucket so that
// browser-side canvas code can draw cross-origin images (question images)
// and still call `toDataURL()` without the canvas becoming tainted.
//
// Background:
//   Spaces objects are uploaded with ACL=public-read, which makes them
//   downloadable via <img src="..."> but does NOT set the
//   `Access-Control-Allow-Origin` response header. A <canvas> that draws
//   such an image is marked tainted; subsequent toDataURL / getImageData
//   throw a SecurityError.
//
//   Task 4 stamps the question image onto the student's handwriting board
//   and exports the composite as PNG on submit — so we need CORS headers
//   on every image GET.
//
// Usage:
//   node scripts/configureSpacesCors.js
//
// The script reads DO_SPACE_* credentials from .env (same as s3.js), so
// the environment you run it in determines which bucket gets configured.
// Run against production once — new uploads inherit the bucket-level CORS,
// no per-object change needed.
//
// Safe to re-run: putBucketCors replaces the rules atomically.

import "dotenv/config";
import { PutBucketCorsCommand, GetBucketCorsCommand } from "@aws-sdk/client-s3";
import { s3 } from "../utils/s3.js";

const bucketName = process.env.DO_SPACE_BUCKET;

// Wildcard origin is safe here because:
//   1. Every object in this bucket is already ACL=public-read (so the
//      content is not confidential).
//   2. CORS only governs browser read access; server-side callers never
//      hit CORS checks.
//   3. Wildcard also lets localhost dev + any future preview URL fetch
//      the images without needing an origin-allowlist maintenance burden.
const CORS_RULES = [
  {
    AllowedOrigins: ["*"],
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["*"],
    // Expose nothing extra — the browser only needs the data, not metadata.
    ExposeHeaders: [],
    // 1h preflight cache. Images don't preflight (they're simple GETs via
    // <img crossOrigin>), but the field is required by the spec.
    MaxAgeSeconds: 3600,
  },
];

async function main() {
  if (!bucketName) {
    console.error("DO_SPACE_BUCKET missing from environment. Aborting.");
    process.exit(1);
  }

  console.log(`Target bucket: ${bucketName}`);
  console.log(`Endpoint: ${process.env.DO_SPACE_ENDPOINT || "(sdk default)"}`);
  console.log("");

  // Print existing config for audit before overwriting.
  try {
    const existing = await s3.send(new GetBucketCorsCommand({ Bucket: bucketName }));
    console.log("Existing CORS rules:");
    console.log(JSON.stringify(existing?.CORSRules || [], null, 2));
  } catch (err) {
    if (err?.name === "NoSuchCORSConfiguration") {
      console.log("Existing CORS rules: (none — bucket has no CORS configured)");
    } else {
      console.warn(`Could not read existing CORS: ${err?.message || err}`);
    }
  }
  console.log("");

  console.log("New CORS rules to apply:");
  console.log(JSON.stringify(CORS_RULES, null, 2));
  console.log("");

  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: { CORSRules: CORS_RULES },
    })
  );

  console.log("✅ CORS rules applied.");
  console.log(
    "Verify with:  curl -I -H 'Origin: http://localhost:5173' <any-image-url>  (should see Access-Control-Allow-Origin: *)"
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
