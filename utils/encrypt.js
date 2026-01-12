const CryptoJS = require("crypto-js");
const SECRET_KEY = process.env.ROLE_SECRET_KEY || "super-secret-key";

const encryptData = (data) => {
  const stringified = typeof data === "string" ? data : JSON.stringify(data);
  return CryptoJS.AES.encrypt(stringified, SECRET_KEY).toString();
};

module.exports = { encryptData };
