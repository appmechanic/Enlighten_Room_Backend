import TeacherDrive from "../models/TeacherDriveModel.js";
import Teacher from "../models/teacherModel.js";
import User from "../models/user.js";

export const saveTeachingMaterial = async (req, res) => {
  try {
    const { teacherId, folderUrl, fileMeta } = req.body;

    if (!teacherId || !folderUrl || !fileMeta) {
      return res.status(400).json({ error: "All fields are required." });
    }

    // ✅ Check if teacher exists
    const teacher = await User.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ error: "Teacher not found." });
    }

    // 📦 Save teaching material
    const material = new TeacherDrive({
      teacherId,
      folderUrl,
      fileMeta,
    });

    await material.save();

    res
      .status(201)
      .json({ message: "Teaching material saved", data: material });
  } catch (error) {
    console.error("Error saving teaching material:", error);
    res.status(500).json({ error: "Server error" });
  }
};
