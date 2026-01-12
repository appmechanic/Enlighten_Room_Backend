// controllers/team.controller.js
import fs from "fs";
import path from "path";
import Team from "../models/teamMembers.js";

// Util: remove local file if inside /uploads/teams
const safeUnlink = (storedPath) => {
  try {
    if (!storedPath) return;
    // storedPath is like "/uploads/filename.jpg"
    if (!storedPath.startsWith("/uploads/")) return;
    const abs = path.join(process.cwd(), storedPath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}
};

/** Create (image via multer) */
export const createTeam = async (req, res) => {
  try {
    const { name, designation, bio } = req.body || {};
    if (!name || !designation) {
      return res
        .status(400)
        .json({ success: false, error: "name and designation are required" });
    }

    // If an image file was uploaded, store a web-accessible relative URL
    const image = req.file ? `/uploads/teams/${req.file.filename}` : undefined;

    const doc = await Team.create({ name, designation, bio, image });
    res
      .status(201)
      .json({ success: true, data: doc, message: "Team member created" });
  } catch (err) {
    console.error("createTeam:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/** List */
export const listTeams = async (_req, res) => {
  try {
    const items = await Team.find().sort({ createdAt: -1 });
    res.json({ success: true, data: items });
  } catch (err) {
    console.error("listTeams:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/** Get one */
export const getTeamById = async (req, res) => {
  try {
    const item = await Team.findById(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: item });
  } catch (err) {
    console.error("getTeamById:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/** Update (optional new image; can remove image via removeImage=true) */
export const updateTeam = async (req, res) => {
  try {
    const { name, designation, bio, removeImage } = req.body || {};

    const item = await Team.findById(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });

    // Handle optional new upload
    let nextImage = item.image;
    if (req.file) {
      // delete old if existed
      safeUnlink(item.image);
      nextImage = `/uploads/teams/${req.file.filename}`;
    } else if (String(removeImage).toLowerCase() === "true") {
      safeUnlink(item.image);
      nextImage = undefined;
    }

    item.name = name ?? item.name;
    item.designation = designation ?? item.designation;
    item.bio = bio ?? item.bio;
    item.image = nextImage;

    await item.save();
    res.json({ success: true, data: item, message: "Updated" });
  } catch (err) {
    console.error("updateTeam:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/** Delete (also remove stored image) */
export const deleteTeam = async (req, res) => {
  try {
    const item = await Team.findByIdAndDelete(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });
    safeUnlink(item.image);
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    console.error("deleteTeam:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
