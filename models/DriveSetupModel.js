import mongoose from "mongoose";

const driveSetupSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  driveFolderUrl: {
    type: String,
    required: true,
  },
  permissionGranted: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const DriveSetup = mongoose.model("DriveSetup", driveSetupSchema);
export default DriveSetup;
