import mongoose from "mongoose";

const appSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    value: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

const AppSetting = mongoose.model("AppSetting", appSettingSchema);
export default AppSetting;
