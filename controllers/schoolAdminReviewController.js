import User from "../models/user.js";
import RegisteredSchool from "../models/RegisteredSchool.js";
import Subscription from "../models/SubscriptionModel.js";
import {
  sendSchoolAdminApprovedEmail,
  sendSchoolAdminPendingEmail,
} from "../utils/helper.js";

// Second-pass hydration: fetches active Subscription+Plan for a batch of
// users and returns a Map keyed by userId string. Kept in-controller to
// avoid a new util file for one call-site.
async function loadSubscriptionsByUserId(userIds) {
  if (!userIds.length) return new Map();
  const subs = await Subscription.find({
    userId: { $in: userIds },
    status: "active",
  })
    .populate({ path: "planType", select: "name planType planCategory" })
    .select("userId planType status frequency createdAt")
    .lean();
  const map = new Map();
  for (const s of subs) map.set(String(s.userId), s);
  return map;
}

// Attaches `subscription` (with populated plan) onto each user in-place.
// Users without an active subscription get `subscription: null` so the UI
// can show "—" instead of "loading".
function attachSubscriptions(users, subMap) {
  for (const u of users) {
    const sub = subMap.get(String(u._id));
    u.subscription = sub
      ? {
          status: sub.status,
          frequency: sub.frequency,
          createdAt: sub.createdAt,
          plan: sub.planType
            ? {
                _id: String(sub.planType._id),
                name: sub.planType.name,
                planType: sub.planType.planType,
                planCategory: sub.planType.planCategory,
              }
            : null,
        }
      : null;
  }
}

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

    let query;
    if (search) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      // Combine with search — wrap the status filter under $and.
      const searchFilter = {
        $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { organization: rx }],
      };
      query = orClauses.length ? { $and: [filter, searchFilter] } : searchFilter;
    } else {
      query = filter;
    }

    const users = await User.find(query)
      .select(
        "firstName lastName email organization userRole schoolVerification createdAt"
      )
      .populate({ path: "schoolVerification.matchedSchoolId", select: "name" })
      .sort({ createdAt: -1 })
      .lean();

    const subMap = await loadSubscriptionsByUserId(users.map((u) => u._id));
    attachSubscriptions(users, subMap);

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
