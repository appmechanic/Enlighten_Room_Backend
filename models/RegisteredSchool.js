import mongoose from "mongoose";

const registeredSchoolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }],
    allowedEmailDomains: [{ type: String, trim: true, lowercase: true }],
    country: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  { timestamps: true }
);

registeredSchoolSchema.index({ name: 1 });
registeredSchoolSchema.index({ allowedEmailDomains: 1 });

const RegisteredSchool = mongoose.model(
  "RegisteredSchool",
  registeredSchoolSchema
);
export default RegisteredSchool;
