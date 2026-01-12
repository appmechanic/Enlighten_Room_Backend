import Task from "../models/taskModel.js";
import crypto from "crypto";

export const createTask = async (req, res) => {
  try {
    const data = req.body;
    const slug = generateSlug(data.title);
    const fullShareableLink = `${process.env.BASE_URL}/api/tasks/share/${slug}`;
    const task = new Task({
      ...data,
      createdBy: req.user._id,
      isLinkBased: data.type === "link", // still useful for logic
      linkSlug: slug,
      shareableLink: fullShareableLink,
    });
    await task.save();
    res.status(201).json({ message: "Task created", task });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error creating task", error: err.message });
  }
};

const generateSlug = (title) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const random = crypto.randomBytes(3).toString("hex");
  return `${base}-${random}`;
};

export const getTaskBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const task = await Task.findOne({ linkSlug: slug });
    if (!task) return res.status(404).json({ message: "Task not found" });
    res.json(task);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching task", error: err.message });
  }
};

export const getUserTasks = async (req, res) => {
  try {
    const userId = req.user._id;
    const tasks = await Task.find({
      $or: [
        { type: "individual", assignedTo: userId },
        { type: "group", groupIds: { $in: req.user.groupIds } },
      ],
    });
    res.json(tasks);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching tasks", error: err.message });
  }
};
