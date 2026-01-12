import mongoose from "mongoose";

const CustomIdMapSchema = new mongoose.Schema({
  customId: { type: String, required: true, unique: true },
  objectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ["session", "user"], required: true },
});

const CustomIdMap = mongoose.models.CustomIdMap || mongoose.model("CustomIdMap", CustomIdMapSchema);

export default CustomIdMap;
