import Keys from "../models/keys.js";
import mongoose from "mongoose";  

// Helper to get the model dynamically
const getModel = (modelName) => {
    try {
      return mongoose.model(modelName);
    } catch (error) {
      return mongoose.model(modelName, new mongoose.Schema({}, { strict: false }));
    }
};

export default async (req, res, next) => { 
  const { key } = req.params;
 
  if (!key) {
    return res.status(401).json({ error: "secret key required" });
  } 
  
  try {
    const keyFind = await Keys.findOne({secret_key: key});
    if (!keyFind) {
      return res.status(401).json({ error: "key not exist" });
    }  
    let isExpird = keyFind.expiry_date > new Date();
    if(isExpird){
      next();  
    } else {
      return res.status(401).json({ error: "wrong or expire key" });
    };
  } catch (error) {
    console.error("something wrong with auth middleware");
    res.status(500).json({ error: "Server Error" });
  }
};
