import StudentDrive from "../models/StudentDriveModel.js";
import Student from "../models/studentModel.js";
import User from "../models/user.js";

export const saveStudentMaterial = async (req, res) => {
  try {
    const { studentId, folderUrl, fileMeta } = req.body;

    if (!studentId || !folderUrl || !fileMeta) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found." });
    }

    const material = new StudentDrive({
      studentId,
      folderUrl,
      fileMeta,
    });

    await material.save();

    res.status(201).json({ message: "Student material saved", data: material });
  } catch (error) {
    console.error("Error saving student material:", error);
    res.status(500).json({ error: "Server error" });
  }
};
