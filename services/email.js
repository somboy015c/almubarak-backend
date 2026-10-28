// Transactional email via Resend (https://resend.com).
//
// Uses Resend's HTTPS API (not SMTP), so it works on Render's free tier,
// which blocks outgoing SMTP ports.
//
// If RESEND_API_KEY is not set (e.g. local development), emails are not sent;
// the link is printed to the server console instead so you can still test.

const axios = require('axios');

const BRAND = 'Elmubarak Digital Hub';
const BRAND_COLOR = '#146C43';

const { frontendUrl } = require('../utils/urls');
const fromAddress = () => process.env.EMAIL_FROM || `${BRAND} <no-reply@elmubarak.com.ng>`;

function layout({ heading, intro, buttonText, link, footnote }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:${BRAND_COLOR};padding:20px 28px;color:#ffffff;font-size:18px;font-weight:bold;">${BRAND}</td></tr>
        <tr><td style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">
          <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">${heading}</h2>
          <p style="margin:0 0 22px;">${intro}</p>
          <p style="margin:0 0 22px;">
            <a href="${link}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:bold;">${buttonText}</a>
          </p>
          <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="margin:0 0 22px;font-size:13px;word-break:break-all;"><a href="${link}" style="color:${BRAND_COLOR};">${link}</a></p>
          <p style="margin:0;font-size:13px;color:#6b7280;">${footnote}</p>
        </td></tr>
      </table>
      <p style="font-size:12px;color:#9ca3af;margin:16px 0 0;">&copy; ${new Date().getFullYear()} ${BRAND}</p>
    </td></tr>
  </table>
</body>
</html>`;
}

async function send({ to, subject, html, text, devLink }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email:dev] RESEND_API_KEY not set. Would send "${subject}" to ${to}\n  Link: ${devLink}`);
    return { ok: true, dev: true };
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: fromAddress(), to: [to], subject, html, text },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    return { ok: true };
  } catch (err) {
    console.error('Resend error:', err.response?.status, err.response?.data || err.message);
    return { ok: false };
  }
}

function sendVerificationEmail(user, rawToken) {
  const link = `${frontendUrl()}/verify-email.html?token=${rawToken}`;
  const first = (user.fullName || '').split(' ')[0] || 'there';
  return send({
    to: user.email,
    subject: `Verify your email — ${BRAND}`,
    html: layout({
      heading: `Welcome, ${first}!`,
      intro: 'Thanks for signing up. Please confirm your email address to activate your account and start using your wallet.',
      buttonText: 'Verify my email',
      link,
      footnote: 'This link expires in 24 hours. If you did not create this account, you can safely ignore this email.'
    }),
    text: `Welcome to ${BRAND}! Verify your email by opening this link (valid for 24 hours): ${link}`,
    devLink: link
  });
}

function sendPasswordResetEmail(user, rawToken) {
  const link = `${frontendUrl()}/reset-password.html?token=${rawToken}`;
  return send({
    to: user.email,
    subject: `Reset your password — ${BRAND}`,
    html: layout({
      heading: 'Reset your password',
      intro: 'We received a request to reset the password for your account. Click the button below to choose a new one.',
      buttonText: 'Reset password',
      link,
      footnote: 'This link expires in 1 hour and can only be used once. If you did not ask for this, ignore this email — your password will not change.'
    }),
    text: `Reset your ${BRAND} password using this link (valid for 1 hour): ${link}`,
    devLink: link
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
