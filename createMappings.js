/**
 * Example script to create custom ID mappings
 * Run this once to create mappings for your custom IDs
 */

import mongoose from "mongoose";
import CustomIdMap from "./models/CustomIdMap.js";

// Connect to your MongoDB
const mongoURI = "your_mongo_connection_string"; // Replace with your actual connection string
await mongoose.connect(mongoURI);

// Example mappings - replace with your actual ObjectIds
const mappings = [
  {
    customId: "GO0f3tzW",
    objectId: "675e19ce1824c816d0bcbc2c", // Replace with actual session ObjectId
    type: "session"
  },
  {
    customId: "690e19ce1824c816d0bcbc2c",
    objectId: "675e19ce1824c816d0bcbc2d", // Replace with actual user ObjectId
    type: "user"
  }
];

try {
  for (const mapping of mappings) {
    await CustomIdMap.findOneAndUpdate(
      { customId: mapping.customId, type: mapping.type },
      { objectId: mapping.objectId },
      { upsert: true, new: true }
    );
    console.log(`✅ Mapping created: ${mapping.customId} -> ${mapping.objectId} (${mapping.type})`);
  }
  console.log("All mappings created successfully!");
} catch (error) {
  console.error("Error creating mappings:", error);
} finally {
  await mongoose.disconnect();
}