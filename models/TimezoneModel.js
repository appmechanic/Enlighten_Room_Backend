import mongoose from "mongoose";

const timezoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
    offset: { type: String, required: true },
  },
  { timestamps: true }
);

const Timezone = mongoose.model("Timezone", timezoneSchema);
export default Timezone;
