import Plan from "../models/PlanModel.js";

// CREATE a new plan
export const createPlan = async (req, res) => {
  try {
    const {
      name,
      planType,
      planCategory,
      priceMonthly,
      discountPrice,
      priceYearly,
      features,
      subtitle,
    } = req.body;
    const existing = await Plan.findOne({ planType });

    if (existing) {
      return res.status(400).json({ message: "Plan type already exists." });
    }

    const plan = new Plan({
      name,
      discountPrice,
      planType,
      planCategory,
      priceMonthly,
      priceYearly,
      features,
      subtitle,
    });
    await plan.save();
    res.status(201).json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// READ all plans. Accepts ?category=individual|school to segment the results
// for the signed-in user (teachers see individual, school admins see school).
// Unrecognised or missing category returns every plan for admin/CMS use.
//
// For "individual", legacy docs that predate the planCategory field (i.e.
// where the field is missing or null) are treated as individual so they
// still appear on the teacher-facing subscription page. Without this,
// only newly-created plans render and the page looks empty.
export const getAllPlans = async (req, res) => {
  try {
    const { category } = req.query;
    let query = {};
    if (category === "individual") {
      query = {
        $or: [
          { planCategory: "individual" },
          { planCategory: { $exists: false } },
          { planCategory: null },
        ],
      };
    } else if (category === "school") {
      query = { planCategory: "school" };
    }
    const plans = await Plan.find(query);
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// READ single plan by ID
export const getPlanById = async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await Plan.findById(id);
    if (!plan) return res.status(404).json({ message: "Plan not found." });
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// UPDATE plan by ID
export const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await Plan.findByIdAndUpdate(id, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: "Plan not found." });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// DELETE plan by ID
export const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Plan.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Plan not found." });
    res.json({ message: "Plan deleted successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
