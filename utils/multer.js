import multer from "multer";

// Set up storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

// Create the multer instance
const upload = multer({ storage: storage });

export default upload;


import "dotenv/config";
import multerS3 from "multer-s3";
import { s3 } from "./s3.js";

const bucketName = process.env.DO_SPACE_BUCKET;

export const screenshotupload = multer({
  storage: multerS3({
    s3: s3,
    bucket: bucketName,
    acl: "public-read",
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      let folder = "others/";
      if (file.mimetype.startsWith("image/")) folder = "photos/";
      else if (file.mimetype.startsWith("video/")) folder = "videos/";
      else if (
        file.mimetype === "application/pdf" ||
        file.mimetype.startsWith("application/")
      )
        folder = "documents/";
      cb(null, `${folder}${Date.now()}-${file.originalname}`);
    },
  }),
});

// For screenshot uploads
export const uploadScreenshot = screenshotupload.single("screenshot");
export const uploadClasswork = screenshotupload.single("image");
