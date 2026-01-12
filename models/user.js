import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const GoogleDriveSchema = new mongoose.Schema(
  {
    connected: { type: Boolean, default: false },
    googleId: String, // Google "sub"
    email: String, // Google account email
    scope: String,
    access_token: String,
    refresh_token: String, // critical for long-lived access
    token_type: String,
    expiry_date: Number, // ms since epoch
    defaultFolderId: String, // optional: your app's default folder in user's Drive
  },
  { _id: false }
);

// Define the User schema
const userSchema = new mongoose.Schema(
  {
    image: {
      type: String,
      default: "",
    },
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
      // unique: true,
      // required: true,
      lowercase: true,
      trim: true,
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
    phone: {
      type: String,
      // required: true,
    },
    password: {
      type: String,
      // required: true,
    },
    province: {
      type: String,
      // required: true,
    },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
    },
    age: {
      type: Number,
    },
    date_of_birth: {
      type: String,
    },
    referedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    ai_enabled: { type: Boolean, default: false },

    // Student specific
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    settings: {
      screenLocked: { type: Boolean, default: false },
      sendReport: { type: Boolean, default: false },
      remainders: { type: Boolean, default: false },
      saveToDrive: { type: Boolean, default: false },
      emailNotFocus: { type: Boolean, default: false },
    },
    remarks: { type: String },

    // Parent specific
    relation: {
      type: String,
      enum: ["father", "mother", "guardian"],
    },

    is_verified: {
      type: Boolean,
      default: false,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    userRole: {
      type: String,
      enum: ["teacher", "admin", "student", "parent"],
      default: "teacher",
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    OTP_code: {
      type: String,
      default: "",
    },

    isSuspended: {
      type: Boolean,
      default: false,
    },
    otpResendAttempts: { type: Number, default: 0 },
    otpResendLastAttempt: { type: Date },

    // address: {
    fullAddress: { type: String },
    streetAddress: { type: String },
    city: { type: String },
    country: { type: String },
    state: { type: String },
    language: { type: String },
    zip: { type: String },
    organization: { type: String },
    googleId: { type: String },
    // },
    stripeCustomerId: {
      type: String,
      required: false,
    },
    driveConnected: {
      type: Boolean,
      default: false,
    },
    googleDrive: { type: GoogleDriveSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// secure the password with the bcrypt
userSchema.pre("save", async function (next) {
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

// generate JSON Web Token
userSchema.methods.generateToken = async function (expiresIn = "1d") {
  try {
    return jwt.sign(
      {
        id: this._id.toString(),
        email: this.email,
      },
      process.env.JWT_SECRET_KEY,
      {
        expiresIn,
      }
    );
  } catch (error) {
    console.error("Token Error: ", error);
  }
};

// comparePassword
userSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

// define the collection name
const User = new mongoose.model("User", userSchema);
export default User;
