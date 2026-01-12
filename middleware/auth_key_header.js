import Keys from "../models/keys.js";

export default async (req, res, next) => {
  const key = req.header("secret-key");

  if (!key) {
    return res.status(401).json({ error: "secret key required" });
  }

  try {
    const keyFind = await Keys.findOne({ secret_key: key });
    if (!keyFind) {
      return res.status(401).json({ error: "wrong secret key" });
    }
    let isExpird = keyFind.expiry_date > new Date();
    if (isExpird) {
      return next();
    } else {
      return res.status(401).json({ error: "wrong or expire secret key" });
    }
  } catch (error) {
    console.error("something wrong with auth middleware");
    return res.status(500).json({ error: "Server Error" });
  }
};
