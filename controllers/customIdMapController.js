import mongoose from "mongoose";
import CustomIdMap from "../models/CustomIdMap.js";

/**
 * Map a custom sessionId or userId to a MongoDB ObjectId
 * @param {string} customId - The custom ID to map
 * @param {string} objectId - The MongoDB ObjectId to map to
 * @param {"session"|"user"} type - The type of mapping
 */
export const addCustomIdMapping = async (req, res) => {
  try {
    const { customId, objectId, type } = req.body;
    if (!customId || !objectId || !type) {
      return res.status(400).json({ error: "customId, objectId, and type are required" });
    }
    if (!mongoose.Types.ObjectId.isValid(objectId)) {
      return res.status(400).json({ error: "objectId must be a valid MongoDB ObjectId" });
    }
    if (!["session", "user"].includes(type)) {
      return res.status(400).json({ error: "type must be 'session' or 'user'" });
    }
    const mapping = await CustomIdMap.findOneAndUpdate(
      { customId, type },
      { objectId },
      { upsert: true, new: true }
    );
    return res.status(200).json({ message: "Mapping added/updated", mapping });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
