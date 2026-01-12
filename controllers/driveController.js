import DriveSetup from "../models/DriveSetupModel.js";
import Student from "../models/studentModel.js";
import User from "../models/user.js";
import { google } from "googleapis";
import multer from "multer";
import fs from "fs";

import {
  getOAuthClient,
  getConsentUrl,
  verifyStateToken,
} from "../utils/googleClient.js";
import {
  ensureFolder,
  ensureDrivePath,
  uploadFileToDrive,
  shareAnyoneWithLink,
  shareToUser,
} from "../utils/driveHelpers.js";

// Multer for uploads
export const upload = multer({ dest: "tmp_uploads" });

export const setupDrive = async (req, res) => {
  try {
    const { userId, driveFolderUrl, permissionGranted } = req.body;

    if (!userId || !driveFolderUrl || permissionGranted === undefined) {
      return res.status(400).json({ error: "All fields are required." });
    }

    // 🔍 Check if student exists
    const studentExists = await User.findOne({
      _id: userId,
      userRole: "student",
    });
    if (!studentExists) {
      return res.status(404).json({ error: "Student not found." });
    }

    const existing = await DriveSetup.findOne({ userId });

    if (existing) {
      existing.driveFolderUrl = driveFolderUrl;
      existing.permissionGranted = permissionGranted;
      await existing.save();
      return res
        .status(200)
        .json({ message: "Drive setup updated", data: existing });
    }

    const newSetup = new DriveSetup({
      userId,
      driveFolderUrl,
      permissionGranted,
    });
    await newSetup.save();

    res.status(201).json({ message: "Drive setup created", data: newSetup });
  } catch (error) {
    console.error("Drive setup error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const reconnectGoogleDrive = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Mark drive as disconnected or pending reconnection
    user.driveConnected = true;
    await user.save();

    // You may optionally trigger OAuth URL generation logic here

    res.status(200).json({
      message: "Drive Connected",
      userId: user._id,
    });
  } catch (error) {
    console.error("Reconnect error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ------------------------------------------------------------------
// Build an authenticated Drive client for a specific app user
// ------------------------------------------------------------------
async function buildUserDrive(userId) {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const gd = user.googleDrive || {};
  if (!gd.connected || !gd.refresh_token) {
    const err = new Error("Google Drive not connected");
    err.status = 400;
    throw err;
  }

  const oAuth2 = getOAuthClient();
  const baseCreds = { refresh_token: gd.refresh_token };
  if (gd.access_token) baseCreds.access_token = gd.access_token;
  if (gd.expiry_date) baseCreds.expiry_date = gd.expiry_date;
  if (gd.token_type) baseCreds.token_type = gd.token_type;
  oAuth2.setCredentials(baseCreds);

  // Persist refreshed tokens from Google
  oAuth2.on("tokens", async (t) => {
    const $set = {};
    if (t.access_token) $set["googleDrive.access_token"] = t.access_token;
    if (typeof t.expiry_date === "number")
      $set["googleDrive.expiry_date"] = t.expiry_date;
    if (t.refresh_token) $set["googleDrive.refresh_token"] = t.refresh_token;
    if (Object.keys($set).length) {
      try {
        await User.updateOne({ _id: user._id }, { $set });
      } catch (e) {
        console.warn("[buildUserDrive] persist tokens:", e?.message || e);
      }
    }
  });

  // Proactively ensure we have a valid access token
  try {
    const at = await oAuth2.getAccessToken();
    const newToken = typeof at?.token === "string" ? at.token : null;
    if (newToken && newToken !== gd.access_token) {
      await User.updateOne(
        { _id: user._id },
        { $set: { "googleDrive.access_token": newToken } }
      );
    }
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || "";
    if (/invalid_grant/i.test(msg)) {
      await User.updateOne(
        { _id: user._id },
        { $set: { "googleDrive.connected": false, driveConnected: false } }
      );
      const err = new Error(
        "Google Drive authorization expired. Please reconnect."
      );
      err.status = 401;
      throw err;
    }
    throw e;
  }

  return { drive: google.drive({ version: "v3", auth: oAuth2 }), user, oAuth2 };
}

// ------------------------------------------------------------------
// ONE-ENDPOINT OAuth flow: /api/drive/connect
//   - Phase A (no code): returns consent URL
//   - Phase B (?code&state): exchanges and SAVES DATA to DB
// ------------------------------------------------------------------
// ---------- helpers ----------
function simpleFail(res, status, msg) {
  return res.status(status).json({ ok: false, error: msg });
}

// Exchange code -> tokens and save to DB (BODY ONLY)
async function exchangeAndSaveFromBody(body) {
  const code = body?.code ?? null;
  const state = body?.state ?? null;

  if (!code || !state) {
    return { ok: false, status: 400, error: "Missing code/state" };
  }

  const appUserId = verifyStateToken(state);
  if (!appUserId) {
    return { ok: false, status: 400, error: "Invalid state" };
  }

  const oAuth2 = getOAuthClient();

  let tokens;
  try {
    const rsp = await oAuth2.getToken({
      code,

      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    });
    tokens = rsp?.tokens || {};
  } catch (e) {
    const gErr =
      e?.response?.data?.error_description ||
      e?.message ||
      "OAuth exchange failed";
    return { ok: false, status: 400, error: gErr };
  }

  if (!tokens.access_token) {
    return { ok: false, status: 400, error: "No access token from Google" };
  }
  oAuth2.setCredentials(tokens);

  // (optional) get email + googleId
  let meEmail = null,
    googleId = null;
  try {
    if (tokens.id_token) {
      const ticket = await oAuth2.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      googleId = payload?.sub || null;
      meEmail = payload?.email || null;
    }
    if (!meEmail) {
      const oauth2 = google.oauth2({ version: "v2", auth: oAuth2 });
      const me = await oauth2.userinfo.get();
      meEmail = me.data?.email || meEmail;
      googleId = me.data?.id || googleId;
    }
  } catch {
    // not fatal
  }

  const user = await User.findById(appUserId);
  if (!user) {
    return { ok: false, status: 404, error: "User not found" };
  }

  // Preserve old refresh_token if Google didn't return a new one
  const refresh =
    tokens.refresh_token ?? user.googleDrive?.refresh_token ?? null;
  if (!refresh) {
    return {
      ok: false,
      status: 400,
      error:
        "Missing refresh_token. Reconnect with access_type=offline & prompt=consent.",
    };
  }

  user.googleDrive = {
    connected: true,
    googleId: googleId || user.googleDrive?.googleId || null,
    email: meEmail || user.googleDrive?.email || null,
    scope: tokens.scope || process.env.GOOGLE_DRIVE_SCOPE,
    access_token: tokens.access_token,
    refresh_token: refresh,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  };
  user.driveConnected = true;

  try {
    await user.save();
  } catch {
    return {
      ok: false,
      status: 500,
      error: "Failed to save Google Drive credentials",
    };
  }

  return {
    ok: true,
    status: 200,
    result: {
      message: "Google Drive connected",
      email: user.googleDrive.email,
    },
  };
}

// ---------- endpoints (BODY ONLY) ----------
const toBool = (v, def = true) => {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
};
// POST /api/drive/connect  -> returns consent URL
export async function connect(req, res) {
  if (!req.user?._id) return simpleFail(res, 401, "Unauthorized");
  const uid = String(req.user._id || req.user.id || req.user.userId);
  const url = getConsentUrl(uid); // uses process.env.GOOGLE_REDIRECT_URI
  return res.json({ ok: true, url });
}

// POST /api/drive/callback  (BODY: { code, state })
export async function callback(req, res) {
  console.log(req.body);
  const r = await exchangeAndSaveFromBody(req.body);
  if (!r.ok) return simpleFail(res, r.status, r.error);
  return res.status(200).json({ ok: true, ...r.result });
}

/* ====== Drive actions (user-owned) ====== */
// --- helpers (same as before) ---
async function findFolderInParent(drive, name, parentId) {
  const q = [
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
  ].join(" and ");

  const { data } = await drive.files.list({
    q,
    pageSize: 1,
    fields: "files(id,name)",
    orderBy: "name_natural",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return data.files?.[0] || null;
}

async function createFolderInParent(drive, name, parentId) {
  const { data } = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id,name",
    supportsAllDrives: true,
  });
  return data;
}

async function ensureFolderInParent(drive, name, parentId) {
  const existing = await findFolderInParent(drive, name, parentId);
  if (existing) return existing.id;
  const created = await createFolderInParent(drive, name, parentId);
  return created.id;
}

async function verifyFolder(drive, folderId) {
  try {
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType, parents, trashed",
      supportsAllDrives: true,
    });
    if (data?.mimeType !== "application/vnd.google-apps.folder") {
      return { ok: false, reason: "not-a-folder" };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: "not-found" };
  }
}

async function ensurePathInParent(drive, path, parentId) {
  const parts = String(path)
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  let current = parentId;
  for (const seg of parts)
    current = await ensureFolderInParent(drive, seg, current);
  return current;
}

async function ensureAnyoneReader(drive, fileId) {
  try {
    const { data: f } = await drive.files.get({
      fileId,
      fields: "id, permissions",
      supportsAllDrives: true,
    });
    if (
      Array.isArray(f.permissions) &&
      f.permissions.some((p) => p.type === "anyone")
    ) {
      return { alreadyPublic: true };
    }
  } catch {}
  try {
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: {
        type: "anyone",
        role: "reader",
        allowFileDiscovery: false,
      },
    });
    return { alreadyPublic: false };
  } catch (e) {
    return { error: e?.message || "Failed to set public permission" };
  }
}

async function revokeAnyone(drive, fileId) {
  try {
    const { data: f } = await drive.files.get({
      fileId,
      fields: "permissions(id,type)",
      supportsAllDrives: true,
    });
    const anyone = (f.permissions || []).find((p) => p.type === "anyone");
    if (!anyone) return { alreadyPrivate: true };
    await drive.permissions.delete({
      fileId,
      permissionId: anyone.id,
      supportsAllDrives: true,
    });
    return { alreadyPrivate: false };
  } catch (e) {
    return { error: e?.message || "Failed to revoke public permission" };
  }
}

// --- Controller: parentId is OPTIONAL ---
export async function createFolder(req, res) {
  try {
    const uid = req.user?.id || req.user?.userId || req.user?._id;
    if (!uid)
      return res.status(401).json({ success: false, error: "Unauthorized" });

    const { drive, user } = await buildUserDrive(uid);
    const {
      name,
      path,
      parentId, // optional: if absent, we use defaultFolderId or "root"
      makePublic = true, // default public
      fallbackToRoot = true, // keep true so first-time works without parentId
    } = req.body;

    if (!name && !path) {
      return res
        .status(400)
        .json({ success: false, error: 'Provide "name" or "path".' });
    }

    // Choose parent: parentId -> user's defaultFolderId -> "root"
    let baseParent =
      parentId ||
      user?.googleDrive?.defaultFolderId ||
      (fallbackToRoot ? "root" : null);
    if (!baseParent) {
      return res.status(400).json({
        success: false,
        error:
          "No parentId and no default folder; set fallbackToRoot or provide parentId.",
      });
    }

    // If baseParent is not "root", lightly validate it; otherwise skip (root is always OK)
    if (baseParent !== "root") {
      try {
        const { data } = await drive.files.get({
          fileId: baseParent,
          fields: "id, mimeType",
          supportsAllDrives: true,
        });
        if (data?.mimeType !== "application/vnd.google-apps.folder") {
          return res
            .status(400)
            .json({ success: false, error: "parentId is not a folder." });
        }
      } catch {
        // If invalid and we allow root fallback, switch to root; else error.
        if (fallbackToRoot) baseParent = "root";
        else
          return res.status(400).json({
            success: false,
            error: "parentId not found or not accessible.",
          });
      }
    }

    // Create folder(s) under baseParent
    let id;
    if (path) id = await ensurePathInParent(drive, path, baseParent);
    else id = await ensureFolderInParent(drive, name, baseParent);

    // Make new folder public by default (uploads will inherit)
    let shared = null;
    if (makePublic) shared = await ensureAnyoneReader(drive, id);

    const shareUrl = `https://drive.google.com/drive/folders/${id}?usp=sharing`;
    res.json({ success: true, id, parentId: baseParent, shared, shareUrl });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
}

//update folder
export async function updateFolder(req, res) {
  try {
    const uid = req.user?.id || req.user?.userId || req.user?._id;
    if (!uid)
      return res.status(401).json({ success: false, error: "Unauthorized" });

    const { drive } = await buildUserDrive(uid);
    const {
      folderId, // required
      newName, // optional
      newParentId, // optional (move)
      keepOldParents = false,
      makePublic, // optional: true | false | undefined
    } = req.body;

    if (!folderId) {
      return res
        .status(400)
        .json({ success: false, error: "folderId is required" });
    }

    // Validate target folder
    const check = await verifyFolder(drive, folderId); // your helper from earlier
    if (!check.ok) {
      const msg =
        check.reason === "not-a-folder"
          ? "folderId is not a folder"
          : "folderId not found";
      return res.status(404).json({ success: false, error: msg });
    }
    const current = check.data; // { id, name, mimeType, parents, trashed }
    const currentParents = Array.isArray(current.parents)
      ? current.parents
      : [];

    // If moving, validate new parent is a folder
    let validatedNewParentId = null;
    if (newParentId) {
      const parentCheck = await verifyFolder(drive, newParentId);
      if (!parentCheck.ok) {
        const msg =
          parentCheck.reason === "not-a-folder"
            ? "newParentId is not a folder"
            : "newParentId not found";
        return res.status(400).json({ success: false, error: msg });
      }
      validatedNewParentId = newParentId;
    }

    // ---- Compute safe parent deltas (avoid 400 Bad Request) ----
    let addParents; // comma-separated or undefined
    let removeParents; // comma-separated or undefined
    if (validatedNewParentId) {
      const alreadyHas = new Set(currentParents);
      const addSet = new Set();
      const removeSet = new Set();

      // Only add if not already a parent
      if (!alreadyHas.has(validatedNewParentId)) {
        addSet.add(validatedNewParentId);
      }

      if (!keepOldParents) {
        // Remove all existing parents EXCEPT the new one (if it was already present)
        for (const p of currentParents) {
          if (p !== validatedNewParentId) removeSet.add(p);
        }
      }

      addParents = [...addSet].join(",") || undefined;
      removeParents = [...removeSet].join(",") || undefined;

      // If nothing to add/remove (no-op move), leave both undefined
      if (!addParents && !removeParents) {
        addParents = undefined;
        removeParents = undefined;
      }
    }

    // ---- Perform update (rename and/or parent move) ----
    let updated;
    if (newName || addParents || removeParents) {
      const { data } = await drive.files.update({
        fileId: folderId,
        requestBody: newName ? { name: newName } : {},
        addParents,
        removeParents,
        fields: "id, name, parents, webViewLink",
        supportsAllDrives: true,
      });
      updated = data;
    } else {
      // No structural change; fetch minimal info
      const { data } = await drive.files.get({
        fileId: folderId,
        fields: "id, name, parents, webViewLink",
        supportsAllDrives: true,
      });
      updated = data;
    }

    // ---- Toggle public if requested ----
    let shareChange = null;
    if (makePublic === true) {
      shareChange = await ensureAnyoneReader(drive, folderId); // your helper
    } else if (makePublic === false) {
      shareChange = await revokeAnyone(drive, folderId); // your helper
    }

    const shareUrl = `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;

    res.json({
      success: true,
      folder: {
        id: updated.id,
        name: updated.name,
        parents: updated.parents || [],
        shareUrl,
        webViewLink: updated.webViewLink || shareUrl,
      },
      shareChange,
      moved: Boolean(addParents || removeParents),
      renamed: Boolean(newName),
    });
  } catch (e) {
    console.log(e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
}

// --- tiny helpers ---
async function listChildrenOnce(drive, parentId, pageToken) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false`,
    fields: "nextPageToken, files(id,name,mimeType)",
    pageSize: 1000,
    pageToken,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    spaces: "drive",
    orderBy: "folder,name_natural",
  });
  return data;
}

async function deleteTree(drive, rootId, { hardDelete = false } = {}) {
  // BFS to collect all descendants
  const queue = [rootId];
  const seenFolders = new Set();
  const files = [];

  while (queue.length) {
    const folderId = queue.shift();
    if (seenFolders.has(folderId)) continue;
    seenFolders.add(folderId);

    let pageToken;
    do {
      const page = await listChildrenOnce(drive, folderId, pageToken);
      pageToken = page.nextPageToken;

      for (const f of page.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          queue.push(f.id);
        } else {
          files.push(f.id);
        }
      }
    } while (pageToken);
  }

  // 1) delete files
  for (const fid of files) {
    if (hardDelete) {
      await drive.files.delete({ fileId: fid, supportsAllDrives: true });
    } else {
      await drive.files.update({
        fileId: fid,
        requestBody: { trashed: true },
        fields: "id",
        supportsAllDrives: true,
      });
    }
  }

  // 2) delete folders (children first, root last)
  const foldersInReverse = Array.from(seenFolders).reverse();
  for (const did of foldersInReverse) {
    if (hardDelete) {
      await drive.files.delete({ fileId: did, supportsAllDrives: true });
    } else {
      await drive.files.update({
        fileId: did,
        requestBody: { trashed: true },
        fields: "id",
        supportsAllDrives: true,
      });
    }
  }
}

// --- controller: anyone who hits this endpoint can delete ---
export async function deleteFolder(req, res) {
  try {
    // If you use per-user Drive auth, keep this; otherwise swap to your app Drive builder.
    const uid = req.user?.id || req.user?.userId || req.user?._id;
    const { drive } = await buildUserDrive(uid); // must return an authenticated Drive client

    const { folderId, hardDelete = false } = req.body;
    if (!folderId) {
      return res
        .status(400)
        .json({ success: false, error: "folderId is required" });
    }

    // optional sanity check: ensure it's a folder (skip if you truly don't care)
    try {
      const { data } = await drive.files.get({
        fileId: folderId,
        fields: "id,mimeType",
        supportsAllDrives: true,
      });
      if (data?.mimeType !== "application/vnd.google-apps.folder") {
        return res.status(400).json({ success: false, error: "Not a folder" });
      }
    } catch (e) {
      console.log(e);
      return res
        .status(404)
        .json({ success: false, error: "Folder not found" });
    }

    await deleteTree(drive, folderId, { hardDelete });

    return res.json({
      success: true,
      deleted: hardDelete ? "hard" : "trash",
      folderId,
    });
  } catch (e) {
    const status = e?.response?.status || e?.status || e?.code || 500;
    const msg =
      e?.response?.data?.error?.message || e?.message || "Delete failed";
    return res.status(status).json({ success: false, error: msg });
  }
}

async function hardDelete(drive, id) {
  await drive.files.delete({
    fileId: id,
    supportsAllDrives: true,
  });
}

function buildShareLinks(file) {
  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
  const isGoogleDoc = file.mimeType?.startsWith("application/vnd.google-apps");

  const shareUrl = isFolder
    ? `https://drive.google.com/drive/folders/${file.id}?usp=sharing`
    : file.webViewLink ||
      `https://drive.google.com/file/d/${file.id}/view?usp=sharing`;

  const directDownloadUrl =
    !isFolder && !isGoogleDoc
      ? file.webContentLink ||
        `https://drive.google.com/uc?id=${file.id}&export=download`
      : null;

  return { shareUrl, directDownloadUrl, isFolder, isGoogleDoc };
}

// ---------- 2) Delete a single file ----------
export async function deleteFile(req, res) {
  try {
    const uid = req.user?.id || req.user?.userId || req.user?._id;
    const { drive } = await buildUserDrive(uid);

    const { fileId, hardDelete: isHard = false } = req.body;
    if (!fileId)
      return res
        .status(400)
        .json({ success: false, error: "fileId is required" });

    // sanity: ensure it exists
    try {
      await drive.files.get({ fileId, fields: "id", supportsAllDrives: true });
    } catch {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    if (isHard) await hardDelete(drive, fileId);
    else await softDelete(drive, fileId);

    return res.json({
      success: true,
      scope: "file",
      deleted: isHard ? "hard" : "trash",
      fileId,
    });
  } catch (e) {
    console.log(e);
    const status = e?.status || e?.response?.status || e?.code || 500;
    const msg =
      e?.message || e?.response?.data?.error?.message || "Delete failed";
    return res.status(status).json({ success: false, error: msg });
  }
}

export async function uploadFile(req, res) {
  const localPath = req.file?.path;
  if (!localPath)
    return res
      .status(400)
      .json({ error: "file is required (multipart/form-data)" });

  try {
    const { drive, user } = await buildUserDrive(req.user._id);
    const {
      folderId,
      path, // optional nested path like "Products/2025/Oct"
      makePublic = true, // <-- public by default
      filenameOverride, // optional
    } = req.body;

    // 👇 decide what name to use in Drive
    const driveFileName =
      (filenameOverride && filenameOverride.trim()) ||
      (req.file?.originalname && req.file.originalname.trim()) ||
      req.file?.filename || // multer’s tmp name (last fallback)
      "uploaded-file";

    // pick parent
    let parentId = folderId || user?.googleDrive?.defaultFolderId || "root";
    if (path) {
      // your existing helper that returns the final folder id
      parentId = await ensureDrivePath(drive, String(path), parentId);
    }

    // upload (your existing helper)
    const uploaded = await uploadFileToDrive(
      drive,
      localPath,
      parentId,
      driveFileName
    );

    // make public if requested
    let shared = null;
    if (makePublic) {
      shared = await ensureAnyoneReader(drive, uploaded.id);
    }

    // refetch to get link fields
    const { data: fresh } = await drive.files.get({
      fileId: uploaded.id,
      fields: "id,name,mimeType,webViewLink,webContentLink,parents",
      supportsAllDrives: true,
    });

    // build links (same style as your folder shareUrl)
    const shareUrl =
      fresh.webViewLink ||
      `https://drive.google.com/file/d/${fresh.id}/view?usp=sharing`;

    const isGoogleDoc = fresh.mimeType?.startsWith(
      "application/vnd.google-apps"
    );
    const directDownloadUrl = !isGoogleDoc
      ? fresh.webContentLink ||
        `https://drive.google.com/uc?id=${fresh.id}&export=download`
      : null;

    // optional: tag uploader for later checks
    try {
      await drive.files.update({
        fileId: fresh.id,
        requestBody: {
          appProperties: { uploaderId: String(req.user._id || "") },
        },
        fields: "id",
        supportsAllDrives: true,
      });
    } catch {}

    // respond in the same pattern you used for folders
    res.json({
      success: true,
      id: fresh.id,
      parentId,
      shared,
      shareUrl,
      directDownloadUrl,
      name: fresh.name,
      mimeType: fresh.mimeType,
    });
  } catch (e) {
    fs.unlink(localPath, () => {});
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
}

export async function listItems(req, res) {
  try {
    if (!req.user._id) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { drive, user } = await buildUserDrive(req.user._id);
    const {
      parentId = "",
      mimeType = "",
      q = "",
      pageSize = "100",
      pageToken = "",
      ensurePublic = "true",
    } = req.query;

    const clauses = ["trashed = false"];
    const parent = parentId || user.googleDrive?.defaultFolderId || "";
    if (parent) clauses.push(`'${parent}' in parents`);
    if (mimeType)
      clauses.push(`mimeType = '${String(mimeType).replace(/'/g, "\\'")}'`);
    if (q) clauses.push(`(${q})`);

    const { data } = await drive.files.list({
      q: clauses.join(" and "),
      pageSize: Math.min(Number(pageSize) || 100, 1000),
      pageToken: pageToken || undefined,
      fields:
        "nextPageToken, files(id,name,mimeType,parents,modifiedTime,size,iconLink,webViewLink,webContentLink,thumbnailLink,kind,owners,shared,permissions,exportLinks)",
      orderBy: "folder,name_natural",
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const shouldMakePublic =
      String(ensurePublic).trim().toLowerCase() !== "false";

    // Ensure public (if asked) and attach share links
    const files = await Promise.all(
      (data.files || []).map(async (f) => {
        let isPublic = !!(
          f.shared &&
          Array.isArray(f.permissions) &&
          f.permissions.some((p) => p.type === "anyone")
        );
        if (shouldMakePublic && !isPublic) {
          const r = await ensureAnyoneReader(drive, f.id);
          if (!r.error) isPublic = true; // best-effort
        }
        const links = buildShareLinks(f);
        return {
          ...f,
          isPublic,
          shareUrl: links.shareUrl,
          directDownloadUrl: links.directDownloadUrl,
        };
      })
    );

    res.json({
      success: true,
      nextPageToken: data.nextPageToken || null,
      files,
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
}

export async function shareItem(req, res) {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });
    const { drive } = await buildUserDrive(req.user._id);
    const {
      id,
      role = "reader",
      email,
      notify = true,
      message = "",
    } = req.body;
    if (!id) return res.status(400).json({ error: "id is required" });

    const shared = email
      ? await shareToUser(drive, id, email, role, notify, message)
      : await shareAnyoneWithLink(drive, id, role);

    res.json({ success: true, shared });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
}

export async function disconnect(req, res) {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.googleDrive = { connected: false };
    user.driveConnected = false;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

export async function sharePublic(req, res) {
  try {
    if (!req.user?._id) return res.status(401).json({ error: "Unauthorized" });

    const { id, role = "reader" } = req.body;
    if (!id) return res.status(400).json({ error: "id is required" });

    const { drive } = await buildUserDrive(req.user._id);

    // Force share as "anyone with link"
    const shared = await shareAnyoneWithLink(drive, id, role);

    res.json({ success: true, shared });
  } catch (e) {
    console.error("[sharePublic]", e);
    res
      .status(e.status || 500)
      .json({ success: false, error: e.message || "Server error" });
  }
}
