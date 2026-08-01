const { sendMailWithRetry } = require('./transport');

/**
 * Sends one HTML mail, throwing when it never left.
 *
 * The transport itself lives in `./transport` — see the note there for why this
 * no longer builds a transporter (and runs a `verify()`) per message.
 */
const sendMail = async (to, subject, message, attachments) => {
  const user = process.env.MAIL_USER || '';

  const mailOptions = {
    from: `"xceed@nitj.ac.in" <${user}>`,
    to,
    subject,
    html: message,
    attachments: attachments !== undefined ? attachments : [],
  };

  try {
    const info = await sendMailWithRetry(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return info;
  } catch (e) {
    console.error('Email sending error:', e.message);
    throw new Error(`Failed to send email: ${e.message}`);
  }
};

// Providers cap how many recipients one message may carry (Gmail is the
// tightest of the ones this box talks to). Over the cap the *whole* message is
// rejected, so a class digest either reaches everyone or nobody — which is how
// a big class silently stopped receiving anything.
const BULK_BATCH_SIZE = 50;

/**
 * One message to many people, without disclosing the list.
 *
 * Recipients go in `bcc`, not `to`. The old digest joined every member's
 * address into a single `to:` header, so a class of two hundred handed each
 * student two hundred addresses — and the header alone could exceed what the
 * relay would accept.
 *
 * Batches are sent one after another rather than in parallel: the transport
 * pool is shared with the rest of the platform, and a burst is exactly what
 * trips a provider's flood protection.
 *
 * @returns {Promise<{sent: number, failed: number}>} recipients, not messages
 */
const sendBulkMail = async (recipients, subject, message) => {
  const user = process.env.MAIL_USER || '';
  const list = [
    ...new Set(
      (recipients || [])
        .map((address) => String(address || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!list.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (let start = 0; start < list.length; start += BULK_BATCH_SIZE) {
    const batch = list.slice(start, start + BULK_BATCH_SIZE);
    try {
      // Some relays refuse a message with no `to` at all; addressing it to the
      // sender is the usual "undisclosed recipients" shape.
      // eslint-disable-next-line no-await-in-loop
      await sendMailWithRetry({
        from: `"xceed@nitj.ac.in" <${user}>`,
        to: user,
        bcc: batch,
        subject,
        html: message,
      });
      sent += batch.length;
    } catch (e) {
      // One bad batch must not cost the rest of the class their mail.
      failed += batch.length;
      console.error(`[mailer] bulk batch of ${batch.length} failed:`, e.message);
    }
  }

  return { sent, failed };
};

module.exports = { sendMail, sendBulkMail };
