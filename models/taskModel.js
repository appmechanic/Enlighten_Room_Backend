import mongoose from "mongoose";

const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  dueDate: Date,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  type: { type: String, enum: ["group", "individual", "link"], required: true },
  groupIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Group" }],
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  isLinkBased: { type: Boolean, default: false },
  shareableLink: { type: String, unique: true, sparse: true },
  accessCode: String,
  maxAttempts: Number,
  allowAnonymous: { type: Boolean, default: false },
  attachments: [String],
});

export default mongoose.model("Task", TaskSchema);
