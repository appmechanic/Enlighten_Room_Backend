import CmsPage from "../models/privacyPolicyModel.js";

// GET page by id
export const getPage = async (req, res) => {
  try {
    const { type } = req.params;
    const page = await CmsPage.findOne({ type }).lean();
    if (!page)
      return res.status(404).json({ success: false, error: "Page not found" });

    res.json({ success: true, data: page });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CREATE
export const createPage = async (req, res) => {
  try {
    const { title, content, type } = req.body;
    const page = await CmsPage.create({
      title,
      content,
      type,
      createdBy: req.user?._id || null,
    });
    res.status(201).json({ success: true, data: page });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// UPDATE
export const updatePage = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, type } = req.body;

    const page = await CmsPage.findByIdAndUpdate(
      id,
      {
        ...(title && { title }),
        ...(content && { content }),
        ...(type && { type }),
        updatedBy: req.user?._id || null,
      },
      { new: true }
    );

    if (!page)
      return res.status(404).json({ success: false, error: "Page not found" });

    res.json({ success: true, data: page });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// CREATE or UPDATE Privacy Policy
export const upsertPrivacyPolicy = async (req, res) => {
  try {
    const { type } = req.params;
    const { title, content } = req.body;

    let page = await CmsPage.findOne({ type });

    if (page) {
      // update existing
      page.title = title || page.title;
      page.content = content || page.content;
      page.updatedBy = req.user?._id || null;
      await page.save();

      return res.json({
        success: true,
        message: `${type} updated successfully`,
        data: page,
      });
    }

    // create new if not exists
    page = await CmsPage.create({
      title,
      content,
      type,
      createdBy: req.user?._id || null,
    });

    return res.status(201).json({
      success: true,
      message: `${type} created successfully`,
      data: page,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
