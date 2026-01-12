// src/lib/googleClient.js
import { google } from "googleapis";
import jwt from "jsonwebtoken";

/* -------------------------- Env & constants -------------------------- */

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_DRIVE_SCOPE,
  JWT_SECRET_KEY,
} = process.env;

// Minimal guard so misconfigured envs fail fast (avoids invalid_grant surprises)
function assertEnv() {
  const missing = [];
  if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!GOOGLE_REDIRECT_URI) missing.push("GOOGLE_REDIRECT_URI");
  if (!GOOGLE_DRIVE_SCOPE) missing.push("GOOGLE_DRIVE_SCOPE");
  if (!JWT_SECRET_KEY) missing.push("JWT_SECRET_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(
        ", "
      )}. Check your deployment configuration.`
    );
  }
}
assertEnv();

// Normalize scopes: allow comma or space separated env values
function normalizeScopes(s) {
  return String(s)
    .split(/[,\s]+/)
    .filter(Boolean);
}

// Always include minimal identity scopes correctly named for Google
const BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DRIVE_SCOPES = normalizeScopes(GOOGLE_DRIVE_SCOPE);
const ALL_SCOPES = Array.from(new Set([...DRIVE_SCOPES, ...BASE_SCOPES]));

/* -------------------------- OAuth client ----------------------------- */

// Build OAuth client with the exact redirect URI (must match Cloud Console)
export function getOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/**
 * Generate consent URL for a specific app user.
 * We sign a short-lived state token to prevent CSRF/user mixups.
 *
 * Tip: Keep `prompt: "consent"` for first-time connection to ensure a refresh_token.
 * If you later want to avoid re-prompting on subsequent connects, you can make
 * `prompt` conditional based on your user.googleDrive.connected flag.
 */
export function getConsentUrl(appUserId) {
  const state = jwt.sign({ uid: appUserId }, JWT_SECRET_KEY, {
    expiresIn: "10m",
  });

  const client = getOAuthClient();

  // Explicitly pass redirect_uri to remove any ambiguity
  return client.generateAuthUrl({
    access_type: "offline", // needed for refresh_token
    prompt: "consent", // ensures refresh_token on first grant
    include_granted_scopes: true, // incremental auth
    scope: ALL_SCOPES,
    state,
    redirect_uri: GOOGLE_REDIRECT_URI,
  });
}

/**
 * Verify the signed state on callback
 */
export function verifyStateToken(state) {
  try {
    const payload = jwt.verify(state, JWT_SECRET_KEY);
    return payload?.uid || null;
  } catch {
    return null;
  }
}

/* ---------------------------- Notes -----------------------------------

1) Make sure the OAuth 2.0 client (type: Web application) in Google Cloud Console
   has this exact Authorized redirect URI:
     ${GOOGLE_REDIRECT_URI}
   The value must match byte-for-byte (no stray slashes or http vs https).

2) In your callback handler, when exchanging the code:
     const oAuth2 = getOAuthClient();
     const { tokens } = await oAuth2.getToken({
       code,
       redirect_uri: process.env.GOOGLE_REDIRECT_URI, // must match exactly
     });
   Passing the same redirect_uri here avoids common "invalid_grant" errors.

3) If your OAuth consent screen is in "Testing", add your Google accounts as Test users.

4) Keep server time in sync (NTP). Clock drift >5 minutes can also trigger invalid_grant.

----------------------------------------------------------------------- */
