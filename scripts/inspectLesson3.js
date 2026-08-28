import "dotenv/config";
import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";

async function main() {
  await mongoose.connect(process.env.DB_URL);
  const lessons = await Lesson.find({ name: "lesson 3" }).lean();
  console.log(JSON.stringify(lessons, null, 2));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
