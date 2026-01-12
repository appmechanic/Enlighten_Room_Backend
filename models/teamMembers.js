// models/Team.js
import mongoose from "mongoose";

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    designation: { type: String, required: true, trim: true },
    image: { type: String, trim: true }, // URL or path
    bio: { type: String, trim: true },
  },
  { timestamps: true }
);

const Team = mongoose.model("Team", teamSchema);
export default Team;
