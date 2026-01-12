import ContactMessage from "../models/ContactFormModel.js";
import { sendEmail } from "../utils/sendEmail.js";
// import { sendEmail } from "../utils/sendEmail.js";
// import validator from "validator";

/** Resolve the requester IP (behind proxies/CDNs too) */
function getClientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.ip || req.connection?.remoteAddress || "unknown";
}

/** POST /api/contact  */
export async function createContactMessage(req, res) {
  try {
    const { firstName, lastName, email, message } = req.body || {};
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";

    // Basic validation
    if (
      !firstName?.trim() ||
      !lastName?.trim() ||
      !email?.trim() ||
      !message?.trim()
    ) {
      return res.status(400).json({ error: "All fields are required." });
    }
    // if (!validator.isEmail(email)) {
    //   return res.status(400).json({ error: "Invalid email." });
    // }
    if (message.length > 5000) {
      return res
        .status(400)
        .json({ error: "Message too long (max 5000 chars)." });
    }

    // Rate limit: max 5 per calendar day per IP
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setUTCHours(23, 59, 59, 999);

    const todayCount = await ContactMessage.countDocuments({
      ip,
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });

    if (todayCount >= 5) {
      return res.status(429).json({
        error: "Daily limit reached. Please try again tomorrow.",
        limit: 5,
      });
    }

    const doc = await ContactMessage.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      message: message.trim(),
      ip,
      ua,
    });

    // Fire-and-forget email (don’t block response if SMTP fails)
    const subject = `New Contact Message from ${doc.firstName} ${doc.lastName}`;
    const text = [
      `Name: ${doc.firstName} ${doc.lastName}`,
      `Email: ${doc.email}`,
      `IP: ${doc.ip}`,
      `UA: ${doc.ua || "-"}`,
      "",
      doc.message,
    ].join("\n");

    console.log("process . env ", process.env.CONTACT_TO);
    // Use YOUR mailer
    const CONTACT_TO = process.env.CONTACT_TO || process.env.NODEMAILER_EMAIL;
    const html = `
      <h2>New Contact Message</h2>
      <p><b>Name:</b> ${escapeHtml(doc.firstName)} ${escapeHtml(
      doc.lastName
    )}</p>
      <p><b>Email:</b> ${escapeHtml(doc.email)}</p>
      <p><b>IP:</b> ${escapeHtml(doc.ip)}</p>
      <p><b>UA:</b> ${escapeHtml(doc.ua || "-")}</p>
      <hr/>
      <pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(
        doc.message
      )}</pre>
    `;

    // fire-and-forget (don't block response)
    sendEmail({ to: CONTACT_TO, subject, html }).catch((e) =>
      console.error("[contact] email error:", e.message)
    );

    return res
      .status(201)
      .json({ success: true, message: "Message received.", data: doc });
  } catch (err) {
    console.error("[contact] create error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

// minimal HTML escaper
function escapeHtml(s = "") {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[
        c
      ])
  );
}

/** GET /api/contact?search=&page=1&limit=20  (admin) */
export async function listContactMessages(req, res) {
  try {
    // Very simple token guard; swap with your real auth if you have it
    const adminToken = process.env.CONTACT_ADMIN_TOKEN;
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (adminToken && auth !== adminToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit || "20", 10))
    );
    const search = (req.query.search || "").trim();

    const q = search
      ? {
          $or: [
            { firstName: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { message: { $regex: search, $options: "i" } },
            { ip: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      ContactMessage.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ContactMessage.countDocuments(q),
    ]);

    res.json({
      success: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    });
  } catch (err) {
    console.error("[contact] list error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
