// controllers/testimonialController.js
import fs from "fs/promises";
import path from "path";
import Testimonial from "../models/testimonialModel.js";

const isHttpUrl = (p = "") => /^https?:\/\//i.test(p);
const isLocalPath = (p = "") => !!p && !isHttpUrl(p);

async function safeUnlink(filePath) {
  if (!filePath || !isLocalPath(filePath)) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore if file already removed
  }
}

// Create
export const createTestimonial = async (req, res) => {
  try {
    const {
      description,
      name,
      designation = "",
      image: imageFromBody = "",
    } = req.body;

    if (!description || !name) {
      return res
        .status(400)
        .json({ error: "description and name are required" });
    }

    const imagePath = req.file?.path || imageFromBody; // support file upload or URL/body path

    const doc = await Testimonial.create({
      description,
      name,
      designation,
      image: imagePath,
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Read (all) with basic pagination & search
export const listTestimonials = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
    const q = (req.query.q || "").trim();

    const filter = q
      ? {
          $or: [
            { name: { $regex: q, $options: "i" } },
            { designation: { $regex: q, $options: "i" } },
            { description: { $regex: q, $options: "i" } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      Testimonial.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Testimonial.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Read (one)
export const getTestimonial = async (req, res) => {
  try {
    const doc = await Testimonial.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Testimonial not found" });
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Update
export const updateTestimonial = async (req, res) => {
  try {
    const { description, name, designation, image: imageFromBody } = req.body;
    const doc = await Testimonial.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Testimonial not found" });

    // Handle image replacement
    let newImagePath = doc.image;
    const uploadedImage = req.file?.path;
    const bodyImage = imageFromBody?.trim();

    if (uploadedImage) {
      // delete old local file if existed
      if (doc.image && isLocalPath(doc.image)) await safeUnlink(doc.image);
      newImagePath = uploadedImage;
    } else if (typeof bodyImage === "string" && bodyImage !== doc.image) {
      // if client provides a new URL or clears it
      if (doc.image && isLocalPath(doc.image)) await safeUnlink(doc.image);
      newImagePath = bodyImage;
    }

    // Update fields if provided
    if (typeof description !== "undefined") doc.description = description;
    if (typeof name !== "undefined") doc.name = name;
    if (typeof designation !== "undefined") doc.designation = designation;
    doc.image = newImagePath;

    await doc.save();
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Delete
export const deleteTestimonial = async (req, res) => {
  try {
    const doc = await Testimonial.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Testimonial not found" });

    // remove local image file if stored locally
    if (doc.image && isLocalPath(doc.image)) {
      await safeUnlink(doc.image);
    }

    await doc.deleteOne();
    return res.json({ success: true, message: "Deleted" });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
