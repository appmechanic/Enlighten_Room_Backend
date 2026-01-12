import GradeSetting from "../models/GradeSetting.js";

// Create or update grade settings
export const defineGradeSetting = async (req, res) => {
  try {
    const teacherId = req.user?._id;
    if (!teacherId) {
      return res.status(401).json({ success: false, error: "Unauthorized " });
    }
    const { grades } = req.body;

    if (!grades || !Array.isArray(grades)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existing = await GradeSetting.findOne({
      teacherId,
    });

    if (existing) {
      existing.grades = grades;
      await existing.save();
      return res
        .status(200)
        .json({ message: "Grade setting updated", data: existing });
    }

    const newSetting = await GradeSetting.create({
      teacherId,
      grades,
    });

    res
      .status(201)
      .json({ message: "Grade setting created", data: newSetting });
  } catch (error) {
    console.error("Error defining grade setting:", error);
    res.status(500).json({ error: "Server Error" });
  }
};

// Get grade settings (by classroom or assignment)
export const getGradeSetting = async (req, res) => {
  try {
    const teacherId = req.user?._id;
    if (!teacherId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }

    const setting = await GradeSetting.findOne({
      teacherId,
    });

    if (!setting) {
      return res.status(404).json({ error: "Grade setting not found" });
    }

    res.status(200).json({ data: setting });
  } catch (error) {
    console.error("Error fetching grade setting:", error);
    res.status(500).json({ error: "Server Error" });
  }
};

// Delete grade setting
export const deleteGradeSetting = async (req, res) => {
  try {
    const { id } = req.params;
    await GradeSetting.findByIdAndDelete(id);
    res.status(200).json({ message: "Grade setting deleted" });
  } catch (error) {
    console.error("Error deleting grade setting:", error);
    res.status(500).json({ error: "Server Error" });
  }
};
