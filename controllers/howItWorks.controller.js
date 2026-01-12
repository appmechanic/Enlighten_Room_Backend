// controllers/howItWorks.controller.js
import HowItWorksVideo from "../models/HowItWorksVideoModel.js";
import { extractYouTubeId, toEmbedUrl } from "../utils/youtube.js";

/**
 * GET /api/settings/how-it-works
 * Public endpoint to fetch current video (if enabled)
 */
export const getHowItWorks = async (req, res) => {
  try {
    const doc = await HowItWorksVideo.findOne({
      key: "howItWorksVideo",
    }).lean();

    if (!doc || !doc.isEnabled) {
      return res.json({ url: "" });
    }

    return res.json({
      url: doc.url,
      // videoId: doc.videoId,
      // embedUrl: toEmbedUrl(doc.videoId),
      // isEnabled: !!doc.isEnabled,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to load How It Works video." });
  }
};

/**
 * PUT /api/settings/how-it-works
 * Admin-only: upsert YouTube URL
 * body: { url: string, isEnabled?: boolean }
 */

export const upsertHowItWorks = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Valid 'url' is required." });
    }

    const videoId = extractYouTubeId(url);
    if (!videoId) {
      return res.status(400).json({ error: "Invalid YouTube URL or ID." });
    }

    const payload = {
      url: url.trim(),
      videoId,
    };
    // if (typeof isEnabled === "boolean") payload.isEnabled = isEnabled;
    if (req.user?._id) payload.updatedBy = req.user._id;

    const doc = await HowItWorksVideo.findOneAndUpdate(
      { key: "howItWorksVideo" },
      { $set: payload, $setOnInsert: { key: "howItWorksVideo" } },
      { new: true, upsert: true }
    ).lean();

    return res.json({
      success: true,
      url: doc.url,
      // videoId: doc.videoId,
      // embedUrl: toEmbedUrl(doc.videoId),
      // isEnabled: !!doc.isEnabled,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    console.log(err);
    return res
      .status(500)
      .json({ error: "Failed to save How It Works video." });
  }
};

/**
 * PATCH /api/settings/how-it-works/toggle
 * Admin-only: enable/disable without changing URL
 * body: { isEnabled: boolean }
 */
export const toggleHowItWorks = async (req, res) => {
  try {
    const { isEnabled } = req.body || {};
    if (typeof isEnabled !== "boolean") {
      return res.status(400).json({ error: "'isEnabled' must be boolean." });
    }

    const doc = await HowItWorksVideo.findOneAndUpdate(
      {
        $set: {
          isEnabled,
          ...(req.user?._id ? { updatedBy: req.user._id } : {}),
        },
      },
      { new: true }
    ).lean();

    if (!doc)
      return res.status(404).json({ error: "No video configured yet." });

    return res.json({
      success: true,

      url: doc.url,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update status." });
  }
};
