import mongoose from "mongoose";

const parentSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      // required: true,
    },
    lastName: {
      type: String,
      // required: true,
    },
    userName: {
      type: String,
      unique: true,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: function (v) {
          // This regex ensures a valid email format and disallows spaces
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: (props) => `${props.value} is not a valid email address!`,
      },
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    password: { type: String, required: true },
    is_verified: {
      type: Boolean,
      default: false,
    },
    relation: {
      type: String,
      enum: ["father", "mother", "guardian"],
      required: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    country: { type: String },
    city: { type: String },
    language: { type: String },
    // studentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  },
  { timestamps: true }
);

const Parent = mongoose.model("Parent", parentSchema);
export default Parent;
