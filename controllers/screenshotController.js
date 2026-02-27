// Get all screenshots for a session with optional filters
export const getScreenshotsBySession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId, fromDate, toDate } = req.query;

    // Build filter object
    const filter = { SessionId: sessionId };
    if (userId) filter.userId = userId;
    if (fromDate || toDate) {
      filter.uploadedAt = {};
      if (fromDate) filter.uploadedAt.$gte = new Date(fromDate);
      if (toDate) filter.uploadedAt.$lte = new Date(toDate);
    }

    const screenshots = await UserScreenshot.find(filter).sort({ uploadedAt: -1 });
    return res.status(200).json({ count: screenshots.length, data: screenshots });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to fetch screenshots.", error: err.message });
  }
};
import UserScreenshot from "../models/UserScreenshot.js";

// Handles screenshot upload and DB save
export const uploadUserScreenshot = async (req, res) => {
  try {
    // multerS3 puts file info in req.file
    if (!req.file || !req.body.userId) {
      return res.status(400).json({ message: "Screenshot file and userId required." });
    }
    const { userId, SessionId } = req.body;
    const screenshotUrl = req.file.location;

    // Save to DB
    const record = await UserScreenshot.create({ userId, screenshotUrl, SessionId });
    return res.status(201).json({ message: "Screenshot uploaded.", data: record });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to upload screenshot.", error: err.message });
  }
};
