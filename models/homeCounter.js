import mongoose from "mongoose";

const CounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    value: { type: Number, required: true },
    order: { type: Number, default: 0 }, // optional, for UI sorting
  },
  { timestamps: true }
);

export default mongoose.model("Counter", CounterSchema);
