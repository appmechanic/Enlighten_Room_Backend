import AppSetting from "../models/AppSettingModel.js";

const DEFAULTS = {
  showProfileUnsubscribe: false,
};

export const getAppSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const doc = await AppSetting.findOne({ key }).lean();
    const value = doc ? doc.value : DEFAULTS[key];
    return res.json({ key, value: value ?? null });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load setting." });
  }
};

export const upsertAppSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body || {};
    if (typeof value === "undefined") {
      return res.status(400).json({ error: "'value' is required." });
    }
    const doc = await AppSetting.findOneAndUpdate(
      { key },
      { $set: { value }, $setOnInsert: { key } },
      { new: true, upsert: true }
    ).lean();
    return res.json({ key: doc.key, value: doc.value });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save setting." });
  }
};
