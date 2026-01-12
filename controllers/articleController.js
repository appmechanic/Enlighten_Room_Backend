// controllers/articleController.js
import fs from "fs";
import { JSDOM } from "jsdom";
import mongoose from "mongoose";
import createDOMPurify from "dompurify";
import sharp from "sharp";
import crypto from "crypto";
import Article from "../models/articleModel.js";
import path from "path";
import multer from "multer";

const isHttpUrl = (s = "") => /^https?:\/\//i.test(s);
const isLocalPath = (s = "") => !!s && !isHttpUrl(s);

async function safeUnlink(p) {
  if (!p || !isLocalPath(p)) return;
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

const toObjectId = (val) => {
  if (!val) return undefined;
  return mongoose.Types.ObjectId.isValid(val)
    ? new mongoose.Types.ObjectId(val)
    : undefined;
};

const coerceTags = (tags) => {
  if (Array.isArray(tags))
    return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
};

// ---------- Directories ----------
const COVER_DIR = path.join(process.cwd(), "uploads", "articles", "covers");
const INLINE_DIR = path.join(process.cwd(), "uploads", "articles", "inline");
fs.mkdirSync(COVER_DIR, { recursive: true });
fs.mkdirSync(INLINE_DIR, { recursive: true });

// ---------- Multer for cover image ----------
export const uploadCover = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, COVER_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(8).toString("hex");
      const ext = path.extname(file.originalname) || ".png";
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---------- Helpers for inline images ----------
async function saveBase64Image(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  const id = crypto.randomBytes(10).toString("hex");
  const filename = `${id}.webp`;
  const absPath = path.join(INLINE_DIR, filename);

  await sharp(buffer)
    .rotate()
    .resize({ width: 2000, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(absPath);

  return `/uploads/articles/${filename}`;
}

async function saveHttpImage(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const id = crypto.randomBytes(10).toString("hex");
  const filename = `${id}.webp`;
  const absPath = path.join(INLINE_DIR, filename);

  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
  });
  const buf = Buffer.from(resp.data);

  await sharp(buf)
    .rotate()
    .resize({ width: 2000, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(absPath);

  return `/uploads/articles/${filename}`;
}

// Sanitize + normalize editor HTML, convert base64/http/bare imgs to local files
async function normalizeEditorHtml(html) {
  const dom = new JSDOM(`<body>${html || ""}</body>`);
  const doc = dom.window.document;

  // 1) data: images -> file
  const dataImgs = Array.from(doc.querySelectorAll("img[src^='data:']"));
  for (const img of dataImgs) {
    const src = img.getAttribute("src");
    try {
      const newUrl = await saveBase64Image(src);
      if (newUrl) img.setAttribute("src", newUrl);
    } catch {}
    img.removeAttribute("style");
  }

  // 2) http(s) images -> file
  const httpImgs = Array.from(doc.querySelectorAll("img[src]")).filter((i) =>
    /^https?:\/\//i.test(i.getAttribute("src") || "")
  );
  for (const img of httpImgs) {
    try {
      const newUrl = await saveHttpImage(img.getAttribute("src"));
      if (newUrl) img.setAttribute("src", newUrl);
    } catch {}
    img.removeAttribute("style");
  }

  // 3) bare filenames → use EDITOR_IMAGE_BASE_URL if provided; else drop
  const bareImgs = Array.from(doc.querySelectorAll("img[src]")).filter((i) => {
    const s = i.getAttribute("src") || "";
    return !/^data:|^https?:|^\/uploads\//i.test(s);
  });
  const base = (process.env.EDITOR_IMAGE_BASE_URL || "").replace(/\/+$/, "");
  for (const img of bareImgs) {
    const rel = (img.getAttribute("src") || "").replace(/^\/+/, "");
    if (!base) {
      img.remove();
      continue;
    }
    try {
      const newUrl = await saveHttpImage(`${base}/${rel}`);
      if (newUrl) img.setAttribute("src", newUrl);
    } catch {
      img.remove();
    }
  }

  // Normalize links (SEO/safety)
  doc.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("rel", "noopener noreferrer");
    const href = a.getAttribute("href") || "";
    const isExternal =
      /^https?:\/\//i.test(href) &&
      !href.includes(process.env.APP_HOSTNAME || "");
    if (isExternal) a.setAttribute("target", "_blank");
  });

  // Sanitize
  const window = new JSDOM("").window;
  const DOMPurify = createDOMPurify(window);
  const clean = DOMPurify.sanitize(doc.body.innerHTML, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "ul",
      "ol",
      "li",
      "code",
      "pre",
      "hr",
      "img",
      "a",
      "figure",
      "figcaption",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "span",
      "div",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      "class",
      "rel",
      "target",
      "data-type",
      "data-mention-id",
    ],
    FORBID_ATTR: ["onerror", "onclick", "onload"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });

  return clean;
}

function parseMetaTags(metaTags) {
  if (Array.isArray(metaTags)) return metaTags;
  if (typeof metaTags === "string") {
    try {
      return JSON.parse(metaTags);
    } catch {
      return metaTags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

// --------- Create Article ---------
export const createArticle = async (req, res) => {
  try {
    let uploadedAbsPath;
    const {
      title,
      subDescription = "",
      longDescription, // HTML from editor
      image: imageFromBody = "", // optional cover URL
      category,
      metaTags,
      slug,
    } = req.body;

    // console.log("body ", req.body);
    if (!title || !longDescription) {
      return res
        .status(400)
        .json({ error: "title and longDescription are required" });
    }

    // 1) sanitize + store images
    const cleanHtml = await normalizeEditorHtml(longDescription);

    // console.log("cleanHtml", cleanHtml);
    // 2) cover image path (multer or body)
    let imagePath = "";
    if (req.file) {
      uploadedAbsPath =
        req.file.path || path.join(req.file.destination, req.file.filename);
      imagePath = `/uploads/${req.file.filename}`; // served by app.use("/uploads", ...)
    } else if (isHttpUrl(imageFromBody)) {
      imagePath = imageFromBody.trim();
    }

    // 3) build payload
    const payload = {
      title,
      subDescription,
      longDescription: cleanHtml,
      image: imagePath,
      addedBy: req?.user?._id,
      category,
      metaTags: parseMetaTags(metaTags),
      slug: slug?.trim() || undefined,
    };

    // 4) save (slug collision fallback)
    let doc;
    try {
      doc = await Article.create(payload);
    } catch (e) {
      if (e?.code === 11000 && e?.keyPattern?.slug) {
        payload.slug = `${payload.slug || ""}-${Date.now()}`;
        doc = await Article.create(payload);
      } else {
        throw e;
      }
    }

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Read (list) with pagination, search, filters
export const listArticles = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
    const q = (req.query.q || "").trim();
    const tag = (req.query.tag || "").trim();
    const category = (req.query.category || "").trim();
    const addedBy = (req.query.addedBy || "").trim();
    const sortBy = (req.query.sortBy || "createdAt").trim(); // createdAt | updatedAt | title
    const order = (req.query.order || "desc").trim(); // asc | desc

    const filter = {};
    if (q) {
      // text search first, fallback to regex if needed
      filter.$text = { $search: q };
    }
    if (tag) {
      const tags = tag
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length) filter.metaTags = { $in: tags };
    }
    if (category) {
      const catId = toObjectId(category);
      filter.category = catId || category; // supports id or string if you swap to String schema
    }
    if (addedBy) {
      const userId = toObjectId(addedBy);
      filter.addedBy = userId || addedBy;
    }

    const sort = { [sortBy]: order === "asc" ? 1 : -1 };

    const [items, total] = await Promise.all([
      Article.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("addedBy", "name email"),
      Article.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Read (one by id)
export const getArticle = async (req, res) => {
  try {
    const doc = await Article.findById(req.params.id).populate(
      "addedBy",
      "firstName lastName email"
    );

    if (!doc) return res.status(404).json({ error: "Article not found" });
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Read (one by slug)
export const getArticleBySlug = async (req, res) => {
  try {
    const doc = await Article.findOne({ slug: req.params.slug })
      .populate("addedBy", "name email")
      .populate("category", "name slug");
    if (!doc) return res.status(404).json({ error: "Article not found" });
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Update
export const updateArticle = async (req, res) => {
  try {
    const {
      title,
      subDescription,
      longDescription,
      image: imageFromBody,
      addedBy,
      category,
      metaTags,
      slug,
    } = req.body;

    const doc = await Article.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Article not found" });

    // Handle image replacement
    let newImagePath = doc.image;
    const uploaded = req.file?.path;
    const bodyImage =
      typeof imageFromBody === "string" ? imageFromBody.trim() : undefined;

    if (uploaded) {
      if (doc.image && isLocalPath(doc.image)) await safeUnlink(doc.image);
      newImagePath = uploaded;
    } else if (typeof bodyImage !== "undefined" && bodyImage !== doc.image) {
      if (doc.image && isLocalPath(doc.image)) await safeUnlink(doc.image);
      newImagePath = bodyImage; // may be "" to clear or URL to set
    }

    // Apply updates if provided
    if (typeof title !== "undefined") doc.title = title;
    if (typeof subDescription !== "undefined")
      doc.subDescription = subDescription;
    if (typeof longDescription !== "undefined")
      doc.longDescription = longDescription;
    if (typeof addedBy !== "undefined")
      doc.addedBy = toObjectId(addedBy) || addedBy || undefined;
    if (typeof category !== "undefined")
      doc.category = toObjectId(category) || category || undefined;
    if (typeof metaTags !== "undefined") doc.metaTags = coerceTags(metaTags);
    if (typeof slug !== "undefined") doc.slug = slug?.trim() || undefined;
    doc.image = newImagePath;

    try {
      await doc.save();
    } catch (e) {
      if (e?.code === 11000 && e?.keyPattern?.slug) {
        doc.slug = `${doc.slug || ""}-${Date.now()}`;
        await doc.save();
      } else {
        throw e;
      }
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Delete
export const deleteArticle = async (req, res) => {
  try {
    const doc = await Article.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Article not found" });

    if (doc.image && isLocalPath(doc.image)) await safeUnlink(doc.image);

    await doc.deleteOne();
    return res.json({ success: true, message: "Deleted" });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
