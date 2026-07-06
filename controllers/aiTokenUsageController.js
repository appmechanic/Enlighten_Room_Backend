import mongoose from "mongoose";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import Session from "../models/SessionModel.js";

// Per-classroom breakdown of AI token usage grouped by (session, month).
// Returned rows are sorted newest-month-first, then by topic. Sessions with
// zero usage in every month are omitted so the UI shows only sessions that
// actually consumed tokens.
export const getClassroomAiUsage = async (req, res) => {
  try {
    const { classroomId } = req.params;
    if (!classroomId || !mongoose.Types.ObjectId.isValid(classroomId)) {
      return res.status(400).json({ error: "Valid classroomId is required." });
    }

    const sessions = await Session.find({ classroomId })
      .select("_id topic subject sessionDate")
      .lean();

    if (sessions.length === 0) {
      return res.status(200).json({ rows: [] });
    }

    const sessionIds = sessions.map((s) => s._id);
    const usageDocs = await AiTokenUsage.find({
      sessionId: { $in: sessionIds },
    })
      .select(
        "monthKey sessionId promptTokenCount candidatesTokenCount cachedContentTokenCount totalThoughtTokens",
      )
      .lean();

    const sessionById = new Map(
      sessions.map((s) => [String(s._id), s]),
    );

    const rows = usageDocs
      .map((u) => {
        const session = sessionById.get(String(u.sessionId));
        return {
          monthKey: u.monthKey,
          sessionId: String(u.sessionId),
          sessionTopic: session?.topic || "(deleted session)",
          sessionSubject: session?.subject || "",
          sessionDate: session?.sessionDate || null,
          promptTokenCount: u.promptTokenCount || 0,
          candidatesTokenCount: u.candidatesTokenCount || 0,
          cachedContentTokenCount: u.cachedContentTokenCount || 0,
          totalThoughtTokens: u.totalThoughtTokens || 0,
        };
      })
      .sort((a, b) => {
        if (a.monthKey !== b.monthKey) {
          return b.monthKey.localeCompare(a.monthKey);
        }
        return a.sessionTopic.localeCompare(b.sessionTopic);
      });

    return res.status(200).json({ rows });
  } catch (err) {
    console.error("[AiTokenUsage] getClassroomAiUsage failed:", err);
    return res.status(500).json({ error: "Failed to fetch AI token usage." });
  }
};
