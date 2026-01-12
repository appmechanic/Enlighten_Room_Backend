import Language from "../models/LanguageModel.js";

// Create a new language
export const createLanguage = async (req, res) => {
  try {
    const { code, name, nativeName, isActive } = req.body;

    if (!code || !name) {
      return res
        .status(400)
        .json({ success: false, message: "Code and name are required" });
    }

    const exists = await Language.findOne({ code });
    if (exists) {
      return res
        .status(409)
        .json({ success: false, message: "Language already exists" });
    }

    const language = new Language({ code, name, nativeName, isActive });
    await language.save();

    res.status(201).json({ success: true, data: language });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

// Get all active languages
export const getLanguages = async (req, res) => {
  try {
    const languages = await Language.find().sort({ name: 1 });
    res.status(200).json({ success: true, data: languages });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

// Get single language by ID
export const getLanguageById = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res
        .status(404)
        .json({ success: false, message: "Language not found" });
    }
    res.status(200).json({ success: true, data: language });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

// Update language by ID
export const updateLanguage = async (req, res) => {
  try {
    const language = await Language.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!language) {
      return res
        .status(404)
        .json({ success: false, message: "Language not found" });
    }

    res.status(200).json({ success: true, data: language });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};

// Delete language by ID
export const deleteLanguage = async (req, res) => {
  try {
    const language = await Language.findByIdAndDelete(req.params.id);

    if (!language) {
      return res
        .status(404)
        .json({ success: false, message: "Language not found" });
    }

    res
      .status(200)
      .json({ success: true, message: "Language deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Server Error", error: error.message });
  }
};
