import Subject from "../models/SubjectModel.js";

export const createSubject = async (req, res) => {
  try {
    const { name, code, classLevel, subject_description } = req.body;
    if (!name || !code || !classLevel) {
      return res
        .status(400)
        .json({ error: "Name, classLevel  and code are required." });
    }

    const subject = await Subject.create({
      name,
      code,
      classLevel,
      subject_description,
    });
    res.status(201).json(subject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// export const getSubjects = async (req, res) => {
//   try {
//     const subjects = await Subject.find().sort({ name: 1 });
//     res.status(200).json(subjects);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

export const getSubjects = async (req, res) => {
  try {
    const { name, code, classLevel } = req.query;

    const query = {};

    if (name) {
      query.name = { $regex: new RegExp(name, "i") }; // case-insensitive partial match
    }

    if (code) {
      query.code = { $regex: new RegExp(code, "i") };
    }

    if (classLevel) {
      query.classLevel = classLevel;
    }
    // query.status = true; // only active subjects

    const subjects = await Subject.find(query).sort({ name: 1 });
    res.status(200).json(subjects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteSubject = async (req, res) => {
  try {
    const { id } = req.params;

    const subject = await Subject.findByIdAndUpdate(
      id,
      { status: false },
      { new: true }
    );
    if (!subject) {
      return res.status(404).json({ error: "Subject not found." });
    }
    res.status(200).json({ message: "Subject deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateSubject = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, classLevel, subject_description, status } = req.body;
    const subject = await Subject.findById(id);
    if (!subject) {
      return res.status(404).json({ error: "Subject not found." });
    }

    subject.name = name || subject.name;
    subject.code = code || subject.code;
    subject.classLevel = classLevel || subject.classLevel;
    subject.subject_description =
      subject_description || subject.subject_description;
    subject.status = status !== undefined ? status : subject.status;

    await subject.save();
    res.status(200).json(subject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
