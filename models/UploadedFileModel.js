import mongoose from "mongoose";

// One row per successful upload to DigitalOcean Spaces. The multer S3 storage
// engine doesn't persist file metadata to Mongo by default, so this collection
// exists specifically to let us sum storage usage per teacher for quota
// enforcement.
//
// `kind` values so far: "classwork", "assignment", "avatar", "screenshot".
// Add more as new upload paths get wired.
const UploadedFileSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
    },
    url: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    kind: { type: String, default: "" },
  },
  { timestamps: true }
);

const UploadedFile = mongoose.model("UploadedFile", UploadedFileSchema);

export default UploadedFile;
