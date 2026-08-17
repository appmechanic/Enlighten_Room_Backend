import RegisteredSchool from "../models/RegisteredSchool.js";

const parseList = (raw) => {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
};

// Body shape shared by create + update — normalises aliases and domain arrays
// (domains lowercased so the Gemini verifier's domain check stays consistent).
const normaliseBody = (body = {}) => {
  const out = {};
  if (typeof body.name === "string") out.name = body.name.trim();
  if (body.aliases !== undefined) out.aliases = parseList(body.aliases);
  if (body.allowedEmailDomains !== undefined) {
    out.allowedEmailDomains = parseList(body.allowedEmailDomains).map((d) =>
      d.toLowerCase()
    );
  }
  if (typeof body.country === "string") out.country = body.country.trim();
  if (body.status && ["active", "inactive"].includes(body.status)) {
    out.status = body.status;
  }
  return out;
};

export const listSchools = async (req, res) => {
  try {
    const { search = "", status } = req.query;
    const filter = {};
    if (status && ["active", "inactive"].includes(status)) filter.status = status;
    if (search) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { name: rx },
        { aliases: rx },
        { allowedEmailDomains: rx },
        { country: rx },
      ];
    }
    const schools = await RegisteredSchool.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, data: schools });
  } catch (err) {
    console.error("listSchools error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getSchool = async (req, res) => {
  try {
    const school = await RegisteredSchool.findById(req.params.id).lean();
    if (!school) return res.status(404).json({ success: false, message: "School not found" });
    return res.status(200).json({ success: true, data: school });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createSchool = async (req, res) => {
  try {
    const payload = normaliseBody(req.body);
    if (!payload.name) {
      return res.status(400).json({ success: false, message: "Name is required" });
    }
    const school = await RegisteredSchool.create(payload);
    return res.status(201).json({ success: true, data: school });
  } catch (err) {
    console.error("createSchool error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateSchool = async (req, res) => {
  try {
    const payload = normaliseBody(req.body);
    const school = await RegisteredSchool.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    );
    if (!school) return res.status(404).json({ success: false, message: "School not found" });
    return res.status(200).json({ success: true, data: school });
  } catch (err) {
    console.error("updateSchool error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteSchool = async (req, res) => {
  try {
    const school = await RegisteredSchool.findByIdAndDelete(req.params.id);
    if (!school) return res.status(404).json({ success: false, message: "School not found" });
    return res.status(200).json({ success: true, data: { _id: school._id } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
