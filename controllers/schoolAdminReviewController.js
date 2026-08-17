import User from "../models/user.js";
import RegisteredSchool from "../models/RegisteredSchool.js";
import {
  sendSchoolAdminApprovedEmail,
  sendSchoolAdminPendingEmail,
} from "../utils/helper.js";

// Users the site admin can review: anyone currently a schoolAdmin (approved)
// or a teacher whose schoolAdmin request was auto-rejected at signup. The
// signup flow is the only path that sets schoolVerification.status="rejected",
// so that flag reliably identifies the pending queue.
export const listReviewableUsers = async (req, res) => {
  try {
    const { status = "all", search = "" } = req.query;

    const orClauses = [];
    if (status === "pending" || status === "all") {
      orClauses.push({ "schoolVerification.status": "rejected" });
    }
    if (status === "approved" || status === "all") {
      orClauses.push({ userRole: "schoolAdmin" });
    }

    const filter = orClauses.length ? { $or: orClauses } : {};

    if (search) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      // Combine with search — wrap the status filter under $and.
      const searchFilter = {
        $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { organization: rx }],
      };
      const combined = orClauses.length ? { $and: [filter, searchFilter] } : searchFilter;
      const users = await User.find(combined)
        .select(
          "firstName lastName email organization userRole schoolVerification createdAt"
        )
        .populate({ path: "schoolVerification.matchedSchoolId", select: "name" })
        .sort({ createdAt: -1 })
        .lean();
      return res.status(200).json({ success: true, data: users });
    }

    const users = await User.find(filter)
      .select(
        "firstName lastName email organization userRole schoolVerification createdAt"
      )
      .populate({ path: "schoolVerification.matchedSchoolId", select: "name" })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: users });
  } catch (err) {
    console.error("listReviewableUsers error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const approveSchoolAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { matchedSchoolId, reason = "manual approval" } = req.body || {};
    if (!matchedSchoolId) {
      return res
        .status(400)
        .json({ success: false, message: "matchedSchoolId is required" });
    }
    const school = await RegisteredSchool.findById(matchedSchoolId).select("name").lean();
    if (!school) {
      return res.status(404).json({ success: false, message: "School not found" });
    }

    const user = await User.findByIdAndUpdate(
      id,
      {
        userRole: "schoolAdmin",
        schoolVerification: {
          status: "verified",
          matchedSchoolId,
          reason,
          verifiedAt: new Date(),
        },
      },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    sendSchoolAdminApprovedEmail(user, school.name).catch((e) =>
      console.error("approval email failed:", e?.message)
    );

    return res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error("approveSchoolAdmin error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rejectSchoolAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = "manual rejection" } = req.body || {};

    const user = await User.findByIdAndUpdate(
      id,
      {
        userRole: "teacher",
        schoolVerification: {
          status: "rejected",
          matchedSchoolId: null,
          reason,
          verifiedAt: null,
        },
      },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    sendSchoolAdminPendingEmail(user, reason).catch((e) =>
      console.error("pending email failed:", e?.message)
    );

    return res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error("rejectSchoolAdmin error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
