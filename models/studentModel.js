import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
const studentSchema = new mongoose.Schema(
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
    password: { type: String },
    ai_enabled: { type: Boolean, default: false },
    age: { type: Number },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Parent" },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher" },
    country: { type: String },
    city: { type: String },
    language: { type: String },
    referedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    is_verified: {
      type: Boolean,
      default: false,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    settings: {
      screenLocked: { type: Boolean, default: false },
      sendReport: { type: Boolean, default: false },
      saveToDrive: { type: Boolean, default: false },
      emailNotFocus: { type: Boolean, default: false },
    },

    // // Assignment
    // assignmentId: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "Assignment",
    //   required: true,
    // },
    // isStarted: { type: Boolean, default: false },
    // isCompleted: { type: Boolean, default: false },
    // isAutoSubmitted: { type: Boolean, default: false },
    // startTime: { type: Date },
    // endTime: { type: Date },
    // dueTime: { type: Date, required: true },
    // score: { type: Number, default: null },
    remarks: { type: String },
  },
  { timestamps: true }
);

studentSchema.pre("save", async function (next) {
  const user = this;

  if (!user.isModified("password")) {
    return next();
  }

  try {
    const saltRound = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(user.password, saltRound);
    user.password = hashedPassword;
  } catch (error) {
    return next(error);
  }
});

const Student = mongoose.model("Student", studentSchema);
export default Student;
