const { sendMailWithRetry } = require("./mailerModule/transport");

/**
 * Sends one HTML mail and resolves to nodemailer's info, or to `undefined` when
 * it could not be sent. Callers across the platform rely on a failure here
 * being non-fatal, so it logs rather than throws — check the return value if
 * you need to know whether it went.
 *
 * Shares the process-wide connection pool (see `mailerModule/transport`). It
 * used to build its own transporter per message with no port, no TLS setting
 * and no timeouts, so it could sit on a dead socket indefinitely and could
 * drift onto a different port from the platform's other mailer.
 */
const mailSender = async (
  email,
  title,
  body,
  fromData = { name: "XCEED NITJ", address: process.env.MAIL_USER },
) => {
  try {
    return await sendMailWithRetry({
      from: `${fromData.name} <${fromData.address}>`,
      to: `${email}`,
      subject: `${title}`,
      html: `${body}`,
    });
  } catch (e) {
    console.error("[mailSender] could not send to", email, "-", e.message);
    return undefined;
  }
};

module.exports = mailSender;
