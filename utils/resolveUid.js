// utils/driveMeta.js
import User from "../models/user.js";

/**
 * Resolve app user either by:
 *  - req.user._id / id / userId (your auth), OR
 *  - googleId (from req.user.googleId OR X-Google-Id header OR query/body)
 *
 * Normalizes req.user._id so downstream code keeps working.
 * Returns: { uid, user }
 */
export async function resolveUidAndUser(req) {
  // 1) App user id set by your auth middleware
  const directUid = req.user?._id || req.user?.id || req.user?.userId;
  if (directUid) {
    const userDoc = await User.findById(directUid).lean();
    if (!userDoc) {
      const err = new Error("User not found for provided _id");
      err.status = 401;
      throw err;
    }
    req.user._id = userDoc._id;
    return { uid: userDoc._id, user: userDoc };
  }

  // 2) Otherwise use Google Drive account id
  const googleId =
    req.user?.googleId ||
    req.headers["x-google-id"] ||
    req.query.googleId ||
    req.body.googleId;

  if (!googleId) {
    const err = new Error("Unauthorized: missing user _id or googleId");
    err.status = 401;
    throw err;
  }

  const userDoc = await User.findOne({
    "googleDrive.googleId": String(googleId),
  }).lean();

  if (!userDoc) {
    const err = new Error("No user found for provided googleId");
    err.status = 404;
    throw err;
  }

  req.user = {
    ...(req.user || {}),
    _id: userDoc._id,
    googleId: String(googleId),
  };
  return { uid: userDoc._id, user: userDoc };
}

/**
 * Get Drive file meta + app user in one call.
 * Adds owner Google info for cross-checks.
 *
 * Returns:
 *  {
 *    file,                      // full Drive file resource (requested fields)
 *    appUser,                   // your DB user
 *    ownerEmail,                // file owner email (if available)
 *    ownerGooglePermissionId    // file owner permission id (if available)
 *  }
 *
 * extraFields: optional string of extra Drive fields to include.
 */
export async function getFileMetaWithUser(
  drive,
  req,
  fileId,
  extraFields = ""
) {
  const { user: appUser } = await resolveUidAndUser(req);

  const defaultFields = [
    "id",
    "name",
    "mimeType",
    "parents",
    "trashed",
    "appProperties", // for uploaderId, etc.
    "owners(displayName,emailAddress,permissionId,me)",
    "lastModifyingUser(displayName,emailAddress,permissionId,me)",
    "driveId",
  ].join(",");

  const fields = extraFields
    ? `${defaultFields},${extraFields}`
    : defaultFields;

  const { data: file } = await drive.files.get({
    fileId,
    fields,
    supportsAllDrives: true,
  });

  const owner =
    Array.isArray(file.owners) && file.owners.length ? file.owners[0] : null;

  return {
    file,
    appUser,
    ownerEmail: owner?.emailAddress || null,
    ownerGooglePermissionId: owner?.permissionId || null,
  };
}

/**
 * Minimal version keeping your original name/signature but now
 * also returning the app user + owner info.
 *
 * NOTE: now requires `req` (to resolve the user).
 */
export async function getFileMeta(drive, req, fileId, fields) {
  const { user: appUser } = await resolveUidAndUser(req);
  const fallbackFields =
    "id,name,mimeType,parents,trashed,appProperties,owners(displayName,emailAddress,permissionId,me),driveId";

  const { data: file } = await drive.files.get({
    fileId,
    fields: fields || fallbackFields,
    supportsAllDrives: true,
  });

  const owner =
    Array.isArray(file.owners) && file.owners.length ? file.owners[0] : null;

  return {
    file,
    appUser,
    ownerEmail: owner?.emailAddress || null,
    ownerGooglePermissionId: owner?.permissionId || null,
  };
}
