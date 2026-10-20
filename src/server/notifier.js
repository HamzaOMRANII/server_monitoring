'use strict';

// Sends alert notifications by email (SMTP via nodemailer). Email is the only
// channel in v1. It's optional and off until configured; when no receiver is
// enabled we just log what would have been sent.
//
// Receiver config is read live from the settings store so changes in the
// settings screen take effect without a restart.

const nodemailer = require('nodemailer');

async function sendEmail(email, subject, text) {
  try {
    const transport = nodemailer.createTransport({
      host: email.smtp.host,
      port: email.smtp.port,
      secure: !!email.smtp.secure,
      auth: email.smtp.user ? { user: email.smtp.user, pass: email.smtp.pass } : undefined,
    });
    await transport.sendMail({
      from: email.from,
      to: (email.to || []).join(', '),
      subject,
      text,
    });
    return true;
  } catch (err) {
    console.error('[notifier] email error:', err.message);
    return false;
  }
}

// `receivers` is the live receivers object from settings.
async function notify(receivers, { subject, text }) {
  const email = receivers && receivers.email;
  if (email && email.enabled && (email.to || []).length) {
    return [['email', await sendEmail(email, subject, text)]];
  }
  console.log('[notifier] no email receiver enabled — would have sent:', subject);
  return [];
}

// Used by the settings screen "send test email" action.
async function sendTest(receivers) {
  const email = receivers && receivers.email;
  if (!email || !email.enabled || !(email.to || []).length) {
    return { ok: false, reason: 'email receiver not enabled/configured' };
  }
  const ok = await sendEmail(email, '✅ monitoring test email',
    'This is a test from omranisystems monitoring. If you got this, email alerts work.');
  return { ok };
}

module.exports = { notify, sendTest };
