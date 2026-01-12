 
import mongoose from "mongoose";   
 

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log(process.env.DB_URL);
    console.log("MongoDB Connected.") 
  } catch (error) {
    console.log(error.message);
    process.exit(1);
  }
} 
  

export default connectToDatabase;