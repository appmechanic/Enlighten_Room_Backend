import Keys from "../models/keys.js";
import mongoose from "mongoose";

const create = async (req, res) => {
  try {
    if (!req.body.title) {
      return res.status(401).json({ error: "title is required" });
    }

    const exist = await Keys.findOne({ title: req.body.title });
    if (exist) {
      return res.status(401).json({ error: "title already exist" });
    }

    req.body.secret_key = new mongoose.Types.ObjectId();

    const currentDate = new Date();
    currentDate.setFullYear(currentDate.getFullYear() + 1);
    req.body.expiry_date = currentDate;

    const newKey = await Keys.create(req.body);
    res
      .status(201)
      .json({ message: "New Key Created successfully", key: newKey });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAll = async (req, res) => {
  try {
    const keys = await Keys.find();
    res.status(200).json({ keys: keys });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteKey = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedKey = await Keys.findByIdAndDelete(id);
    if (!deletedKey) {
      return res.status(404).json({ message: "key not found" });
    }
    res.status(200).json({ message: "Key Deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createInitialKeyIfNotExists = async () => {
  const predefinedKey = "683991a1d36437b6396cf2aa"; // or generate dynamically
  const existingKey = await Keys.findOne({ secret_key: predefinedKey });

  if (!existingKey) {
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1); // 1 year from now

    const newKey = new Keys({
      secret_key: predefinedKey,
      title: "web",
      createdBy: "system", // optional fields
      type: "initial",
      purpose: "environment startup key",
      createdAt: new Date(),
      expiry_date: expiryDate,
    });

    await newKey.save();
    console.log("✅ Initial key inserted into DB");
  } else {
    console.log("✅ Initial key already exists in DB");
  }
};

export const updateSecretKey = async (req, res) => {
  try {
    const oldKey = req.headers["secret-key"]; // Header name can be adjusted
    const { newKey, expiryDate } = req.body;

    if (!oldKey || !newKey) {
      return res.status(400).json({
        message: "Old key (in header) and new key (in body) are required.",
      });
    }

    const keyDoc = await Keys.findOne({ secret_key: oldKey });

    console.log();
    if (!keyDoc) {
      return res.status(404).json({ message: "Old key not found or invalid." });
    }

    keyDoc.secret_key = newKey;
    if (expiryDate) keyDoc.expiry_date = new Date(expiryDate);

    await keyDoc.save();

    return res
      .status(200)
      .json({ message: "Secret key updated successfully." });
  } catch (error) {
    console.error("Error updating secret key:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

export { create, getAll, deleteKey, createInitialKeyIfNotExists };
