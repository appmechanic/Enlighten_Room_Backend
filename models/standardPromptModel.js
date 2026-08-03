import mongoose from "mongoose";

const StandardPromptSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
      index: true,
    },
    // Joined view of aiHintPromptSections, rewritten by the standard-prompt
    // controller on every save. Read by getClassworkAiFeedback as the single
    // source of truth for both the JSON response shape and content rules.
    aiHintPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // Admin's AI hint prompt split into 10 sub-fields, edited individually
    // in the AdminAiPrompts UI. Position-based; see
    // Enlighten_Room_React/src/components/Admin/aiHintPromptSections.js for
    // the section meta (id/title/placeholder).
    aiHintPromptSections: {
      type: [String],
      default: undefined,
    },
    // Joined view of reportPromptSections, rewritten on every save so older
    // callers (e.g. generateClassReportSummary's fallback path) that read
    // reportPrompt directly keep working unchanged.
    reportPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // Admin's Class Report standard prompt split into 5 sub-fields, edited
    // individually in AdminAiPrompts. Position-based; see
    // Enlighten_Room_React/src/components/Admin/aiHintPromptSections.js
    // (CLASS_REPORT_PROMPT_SECTIONS) for the section meta.
    reportPromptSections: {
      type: [String],
      default: undefined,
    },
    emailPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // System-level prompt prepended to every Create Assignment AI call.
    // The teacher's per-account assignmentPrompt is appended after this so
    // the structure of the request stays consistent across teachers, while
    // letting each teacher inject their own tone/preferences at the end.
    creatingAssignmentPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // Gemini model IDs used by every AI call site. `default` covers all text
    // generation (classwork feedback, precompute, class report, assignment
    // generation, whiteboard). `fallback` is used by classwork feedback when
    // the default model returns an overload error. `image` is a different
    // modality (text-to-image) and needs its own slot.
    models: {
      default: { type: String, trim: true, default: "gemini-2.5-flash" },
      fallback: { type: String, trim: true, default: "gemini-2.5-flash-lite" },
      image: { type: String, trim: true, default: "gemini-3-pro-image-preview" },
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const StandardPrompt = mongoose.model("StandardPrompt", StandardPromptSchema);

export default StandardPrompt;
