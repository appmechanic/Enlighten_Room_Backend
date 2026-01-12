// import FocusAlert from "../models/FocusAlert.js";
import { focusAlertTemplate } from "../utils/focusAlertTemplate.js";
import { sendEmail } from "../utils/sendEmail.js";

export const sendParentFocusAlert = async (req, res) => {
  const {
    studentId,
    studentName,
    parentEmails, // array of emails
    className,
    sessionId, // optional
    occurredAt, // optional; default now
    reason = "tab_blur",
    details = "",
    screenshotUrl = "",
    device = "",
    meta = {},
  } = req.body || {};

  // Basic validation
  if (
    !studentName ||
    !Array.isArray(parentEmails) ||
    parentEmails.length === 0 ||
    !className
  ) {
    return res.status(400).json({
      ok: false,
      message:
        "Missing required fields: studentName, parentEmails[], className.",
    });
  }

  try {
    // Create DB record (optional, but good for audit)
    // const record = await FocusAlert.create({
    //   studentId,
    //   studentName,
    //   parentEmails,
    //   className,
    //   sessionId,
    //   reason,
    //   details,
    //   screenshotUrl,
    //   device,
    //   occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
    //   meta,
    //   sent: false,
    // });

    // Build email
    const html = focusAlertTemplate({
      studentName,
      className,
      occurredAt: Date.now(),
      reason,
      details,
      screenshotUrl,
    });

    // Send email to each parent
    // If you prefer a single email with multiple recipients, pass a joined string to "to"
    for (const to of parentEmails) {
      await sendEmail({
        to,
        subject: `Focus Alert: ${studentName} left ${className}`,
        html,
      });
    }

    // Mark record as sent
    // record.sent = true;
    // await record.save();

    return res.status(200).json({
      ok: true,
      message: "Parent focus alert sent.",
      //   data: { id: record._id },
    });
  } catch (error) {
    console.error("sendParentFocusAlert error:", error);
    return res.status(500).json({
      ok: false,
      message: "Failed to send focus alert.",
      error: error?.message || "Unknown error",
    });
  }
};
