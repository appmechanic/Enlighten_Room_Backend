 
import mongoose from "mongoose";   
 

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.DB_URL);
    const safeTarget = (process.env.DB_URL || "").replace(/\/\/[^@]*@/, "//***:***@");
    console.log(`MongoDB target: ${safeTarget}`);
    console.log("MongoDB Connected.")
  } catch (error) {
    console.log(error.message);
    process.exit(1);
  }
} 
  

export default connectToDatabase;