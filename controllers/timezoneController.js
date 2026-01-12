import Timezone from "../models/TimezoneModel.js";

// Get all timezones
export const getAllTimezones = async (req, res) => {
  try {
    const timezones = await Timezone.find();
    res.status(200).json(timezones);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Get single timezone
export const getTimezoneById = async (req, res) => {
  try {
    const timezone = await Timezone.findById(req.params.id);
    if (!timezone)
      return res.status(404).json({ message: "Timezone not found" });
    res.status(200).json(timezone);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Create timezone
export const createTimezone = async (req, res) => {
  try {
    const { name, label, offset } = req.body;
    const newTimezone = new Timezone({ name, label, offset });
    await newTimezone.save();
    res.status(201).json(newTimezone);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Update timezone
export const updateTimezone = async (req, res) => {
  try {
    const updated = await Timezone.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!updated)
      return res.status(404).json({ message: "Timezone not found" });
    res.status(200).json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// Delete timezone
export const deleteTimezone = async (req, res) => {
  try {
    const deleted = await Timezone.findByIdAndDelete(req.params.id);
    if (!deleted)
      return res.status(404).json({ message: "Timezone not found" });
    res.status(200).json({ message: "Timezone deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
