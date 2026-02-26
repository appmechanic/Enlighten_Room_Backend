import UserScreenshot from "../models/UserScreenshot.js";

// Handles screenshot upload and DB save
export const uploadUserScreenshot = async (req, res) => {
  try {
    // multerS3 puts file info in req.file
    if (!req.file || !req.body.userId) {
      return res.status(400).json({ message: "Screenshot file and userId required." });
    }
    const { userId } = req.body;
    const screenshotUrl = req.file.location;

    // Save to DB
    const record = await UserScreenshot.create({ userId, screenshotUrl });
    return res.status(201).json({ message: "Screenshot uploaded.", data: record });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to upload screenshot.", error: err.message });
  }
};
