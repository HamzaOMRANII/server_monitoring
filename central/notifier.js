'use strict';

// Sends alert notifications to the configured receivers. Two channels in v1:
// email (SMTP via nodemailer) and Telegram (bot API over HTTPS). Both are
// optional and off by default; a channel that isn't enabled is skipped.
//
// Receiver config is read live from the settings store so changes in the
// settings screen take effect without a restart.

const https = require('https');
const nodemailer = require('nodemailer');

function sendTelegram(tg, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ chat_id: tg.chatId, text, parse_mode: 'HTML' });
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${tg.botToken}/sendMessage`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on('error', (err) => {
      console.error('[notifier] telegram error:', err.message);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

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
  const results = [];
  if (receivers.email && receivers.email.enabled && (receivers.email.to || []).length) {
    results.push(['email', await sendEmail(receivers.email, subject, text)]);
  }
  if (receivers.telegram && receivers.telegram.enabled && receivers.telegram.botToken) {
    const tgText = `<b>${escapeHtml(subject)}</b>\n${escapeHtml(text)}`;
    results.push(['telegram', await sendTelegram(receivers.telegram, tgText)]);
  }
  if (!results.length) {
    console.log('[notifier] no receivers enabled — would have sent:', subject);
  }
  return results;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

module.exports = { notify };
