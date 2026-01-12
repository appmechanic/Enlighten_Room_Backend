import asyncHandler from "express-async-handler";
import Partner from "../models/partnerModel.js";

function isAdmin(role) {
  return role === "admin" || role === "superAdmin";
}

/**
 * ADMIN: Create partner
 * POST /api/admin/partners
 * body: { title, logo, designation?, memberSince?, isVisible?, sortOrder? }
 */
export const createPartner = asyncHandler(async (req, res) => {
  const user = req.user._id;
  // if (!user?._id || !isAdmin(user.userRole)) {
  //   return res.status(403).json({ success: false, error: "Forbidden" });
  // }

  const { title, designation, memberSince, isVisible, sortOrder } =
    req.body || {};

  // 👇 logo comes from multer
  const file = req.file;
  const logoPath = file ? `/uploads/${file.filename}` : null;

  if (!title || !logoPath) {
    return res.status(400).json({
      success: false,
      error: "title and logo (image file) are required",
    });
  }

  const partner = await Partner.create({
    title: title.trim(),
    logo: logoPath, // stored path/url
    designation: designation?.trim() || "",
    memberSince: memberSince || null,
    isVisible: typeof isVisible === "boolean" ? isVisible : false,
    sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
    added_by: user,
  });

  res.status(201).json({ success: true, data: partner });
});

/**
 * ADMIN: List all partners (including hidden)
 * GET /api/admin/partners
 */
export const getPartnersAdmin = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?._id || !isAdmin(user.userRole)) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  const partners = await Partner.find({})
    .sort({ sortOrder: 1, createdAt: -1 })
    .lean();

  res.json({ success: true, data: partners });
});

/**
 * ADMIN: Get single partner
 * GET /api/admin/partners/:id
 */
export const getPartnerById = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?._id || !isAdmin(user.userRole)) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  const partner = await Partner.findById(req.params.id);
  if (!partner) {
    return res.status(404).json({ success: false, error: "Partner not found" });
  }

  res.json({ success: true, data: partner });
});

/**
 * ADMIN: Update partner
 * PUT /api/admin/partners/:id
 */
// PUT /api/partners/admin/:id
export const updatePartner = asyncHandler(async (req, res) => {
  const user = req.user;
  // if (!user?._id || !isAdmin(user.userRole)) {
  //   return res.status(403).json({ success: false, error: "Forbidden" });
  // }

  const { title, designation, memberSince, isVisible, sortOrder } =
    req.body || {};

  const partner = await Partner.findById(req.params.id);
  if (!partner) {
    return res.status(404).json({ success: false, error: "Partner not found" });
  }

  // if new logo file provided, replace
  const file = req.file;
  const newLogoPath = file ? `/uploads/${file.filename}` : null;

  if (title !== undefined) partner.title = title.trim();
  if (designation !== undefined) partner.designation = designation.trim();
  if (memberSince !== undefined) partner.memberSince = memberSince || null;
  if (isVisible !== undefined) partner.isVisible = !!isVisible;
  if (sortOrder !== undefined) partner.sortOrder = Number(sortOrder) || 0;
  if (newLogoPath) partner.logo = newLogoPath; // change logo only if new file

  await partner.save();

  res.json({ success: true, data: partner });
});

/**
 * ADMIN: Delete partner
 * DELETE /api/admin/partners/:id
 */
export const deletePartner = asyncHandler(async (req, res) => {
  const user = req.user;
  // if (!user?._id || !isAdmin(user.userRole)) {
  //   return res.status(403).json({ success: false, error: "Forbidden" });
  // }

  const partner = await Partner.findById(req.params.id);
  if (!partner) {
    return res.status(404).json({ success: false, error: "Partner not found" });
  }

  await partner.deleteOne();

  res.json({ success: true, message: "Partner removed" });
});

/**
 * PUBLIC: List visible partners (for "Partnered by / Used by" section)
 * GET /api/partners
 */
export const getPublicPartners = asyncHandler(async (req, res) => {
  const partners = await Partner.find()
    .sort({ sortOrder: 1, memberSince: 1, createdAt: 1 })
    .select("title logo designation memberSince createdAt")
    .lean();

  res.json({ success: true, data: partners });
});
