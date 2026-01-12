// src/lib/driveHelpers.js
import fs from "fs";
import path from "path";
import mime from "mime";

export async function ensureFolder(drive, name, parentId = null) {
  const q = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    parentId ? `'${parentId}' in parents` : "",
    "trashed = false",
  ]
    .filter(Boolean)
    .join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
  });

  if (data.files?.length) return data.files[0].id;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id,name",
  });
  return res.data.id;
}

export async function ensureDrivePath(drive, pathString, rootParentId = null) {
  const parts = String(pathString)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let parent = rootParentId || null;
  for (const part of parts) parent = await ensureFolder(drive, part, parent);
  return parent;
}

export async function uploadFileToDrive(
  drive,
  filePath,
  parentId,
  fileNameOverride // 👈 NEW
) {
  // Use provided name if given, otherwise fall back to tmp filename
  const fileName =
    (fileNameOverride && fileNameOverride.trim()) || path.basename(filePath);

  // Try to detect mime from the real filename if possible
  const mimeType =
    mime.getType(fileName) ||
    mime.getType(filePath) ||
    "application/octet-stream";

  const res = await drive.files.create({
    requestBody: {
      name: fileName, // 👈 use friendly name here
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: "id,name,webViewLink,webContentLink,parents",
    supportsAllDrives: true,
  });

  return res.data; // { id, name, ... }
}

export async function shareAnyoneWithLink(drive, id, role = "reader") {
  await drive.permissions.create({
    fileId: id,
    requestBody: { type: "anyone", role },
  });
  const { data } = await drive.files.get({
    fileId: id,
    fields: "id,name,mimeType,webViewLink,webContentLink,iconLink",
  });
  return data;
}

export async function shareToUser(
  drive,
  id,
  email,
  role = "reader",
  notify = true,
  message = ""
) {
  await drive.permissions.create({
    fileId: id,
    requestBody: { type: "user", role, emailAddress: email },
    sendNotificationEmail: !!notify,
    emailMessage: message || undefined,
  });
  const { data } = await drive.files.get({
    fileId: id,
    fields: "id,name,mimeType,webViewLink,webContentLink,iconLink",
  });
  return data;
}
