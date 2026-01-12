import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail", // or your SMTP provider

  auth: {
    user: process.env.NODEMAILER_EMAIL,
    pass: process.env.NODEMAILER_PASSCODE,
  },
});

const isTransient = (err) => [421, 450, 451, 452].includes(err?.responseCode);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const addSendEmail = async (to, subject, html) => {
  const mailOptions = {
    from: `"Enlighten Room" <${process.env.NODEMAILER_EMAIL}>`,
    to,
    subject,
    html,
  };

  let attempt = 0;
  const cap = 60 * 60 * 1000; // 1h max between tries
  const deadline = Date.now() + 72 * 60 * 60 * 1000; // try up to 72h

  while (true) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      if (!isTransient(err)) throw err; // non-retryable
      if (Date.now() > deadline) throw err;

      attempt += 1;
      const base = Math.min(2000 * 2 ** (attempt - 1), cap);
      const jitter = Math.floor(Math.random() * (base / 2));
      const delay = base + jitter;
      console.warn(
        `Transient SMTP ${err.responseCode}. Retry #${attempt} in ${delay}ms`
      );
      await wait(delay);
    }
  }
};
