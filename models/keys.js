import mongoose from "mongoose";

const keysSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      unique: true,
    },
    secret_key: {
      type: String,
      required: true,
      unique: true,
    },
    expiry_date: {
      type: Date,
      // required: true,
    },
  },
  { timestamps: true }
);

const Keys = mongoose.model("Keys", keysSchema);
export default Keys;
