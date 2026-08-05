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

// The transport pool is shared with the rest of the platform, so a class fan-out
// runs a few connections wide rather than all at once — a burst is exactly what
// trips a provider's flood protection. The pool's own rateLimit does the rest.
const MAX_PARALLEL_SENDS = 4;

/**
 * One message per person, addressed to them.
 *
 * This used to send one message per batch of fifty with every student in `bcc`
 * and the `to:` pointing back at the sending account. Two things were wrong
 * with that, and between them they are why class mail stopped arriving:
 *
 *  - A message whose only visible recipient is the sender, carrying fifty
 *    hidden ones, is the shape consumer spam filters score hardest. It was
 *    accepted by the relay — so nothing here failed, and nothing was logged —
 *    and then filed as junk or dropped at the far end.
 *  - One unroutable address failed the whole batch, taking forty-nine
 *    deliverable ones down with it.
 *
 * Per-recipient sends cost more messages, and are worth it: each student gets a
 * mail addressed to them, still sees nobody else's address, and one bad address
 * costs exactly one delivery. Failures are logged per address so a delivery
 * problem is visible in the log rather than inferred from silence.
 *
 * @returns {Promise<{sent: number, failed: number}>} recipients, not messages
 */
const sendBulkMail = async (recipients, subject, message) => {
  const user = process.env.MAIL_USER || '';
  const queue = [
    ...new Set(
      (recipients || [])
        .map((address) => String(address || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const total = queue.length;
  if (!total) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  const worker = async () => {
    while (queue.length) {
      const to = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendMailWithRetry({
          from: `"xceed@nitj.ac.in" <${user}>`,
          to,
          subject,
          html: message,
        });
        sent += 1;
      } catch (e) {
        // One unreachable address must not cost anybody else their mail.
        failed += 1;
        console.error(`[mailer] could not reach ${to}:`, e.message);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_SENDS, total) }, () => worker()),
  );

  return { sent, failed };
};

module.exports = { sendMail, sendBulkMail };
