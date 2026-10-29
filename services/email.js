// All email goes through here: Resend (https://resend.com) over HTTPS, so it works
// on Render's free tier (which blocks SMTP). One branded layout is used for every email.
//
// If RESEND_API_KEY is not set (local development), nothing is sent; the email's
// subject, recipient and any link are printed in the server log instead.

const axios = require('axios');
const { frontendUrl } = require('../utils/urls');

const BRAND = 'Elmubarak Digital Hub';
const GREEN = '#146C43';
const GREEN_DEEP = '#0A4A31';
const GOLD = '#C9A24B';
const WHATSAPP = 'https://wa.me/2349045852890';

const fromAddress = () => process.env.EMAIL_FROM || `${BRAND} <no-reply@elmubarak.com.ng>`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TONES = {
  success: { color: GREEN, glyph: '&#10003;' }, // check mark
  failed: { color: '#C0392B', glyph: '&#10005;' }, // cross
  pending: { color: '#B7791F', glyph: '&#8230;' }, // ellipsis
  security: { color: '#B7791F', glyph: '!' },
  alert: { color: '#C0392B', glyph: '!' },
  info: { color: GREEN, glyph: 'i' }
};

// -------------------------------------------------------------------------
// Layout
// opts: { tone, title, intro, rows:[[label,value]], token:{label,value}, button:{text,url},
//         notes:[string], preheader }
function layout(opts) {
  const tone = TONES[opts.tone] || TONES.info;
  const base = frontendUrl();
  const rows = (opts.rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '');

  const rowsHtml = rows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0 4px;border-top:1px solid #e6ece8;">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:11px 0;border-bottom:1px solid #e6ece8;font-size:13px;color:#6b7a72;width:42%;vertical-align:top;">${esc(k)}</td>
          <td style="padding:11px 0;border-bottom:1px solid #e6ece8;font-size:14px;color:#14231b;font-weight:600;text-align:right;word-break:break-word;">${esc(v)}</td>
        </tr>`).join('')}
      </table>`
    : '';

  const tokenHtml = opts.token
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0 4px;"><tr><td style="background:#E4F3EC;border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#4d6358;margin-bottom:6px;">${esc(opts.token.label)}</div>
        <div style="font-family:Consolas,Menlo,monospace;font-size:18px;font-weight:700;color:${GREEN_DEEP};word-break:break-all;">${esc(opts.token.value)}</div>
      </td></tr></table>`
    : '';

  const buttonHtml = opts.button
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 6px;"><tr><td style="background:${GREEN};border-radius:10px;">
        <a href="${esc(opts.button.url)}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${esc(opts.button.text)}</a>
      </td></tr></table>
      ${opts.showLink ? `<p style="margin:10px 0 0;font-size:12px;color:#6b7a72;">If the button doesn't work, copy this link into your browser:<br><a href="${esc(opts.button.url)}" style="color:${GREEN};word-break:break-all;">${esc(opts.button.url)}</a></p>` : ''}`
    : '';

  const notesHtml = (opts.notes || []).map((n) => `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#6b7a72;">${esc(n)}</p>`).join('');
  const introHtml = esc(opts.intro || '').replace(/\r?\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f3;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader || opts.intro || opts.title)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f3;padding:26px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(10,74,49,.08);">
        <tr><td style="padding:22px 28px 16px;text-align:left;">
          <a href="${esc(base)}" style="text-decoration:none;"><img src="${esc(base)}/assets/logo-wide.png" alt="${BRAND}" width="190" style="display:block;border:0;height:auto;max-width:190px;color:${GREEN_DEEP};font-weight:700;font-size:16px;" /></a>
        </td></tr>
        <tr><td style="height:4px;background:${GREEN};background-image:linear-gradient(90deg,${GREEN} 0%,${GREEN} 70%,${GOLD} 70%,${GOLD} 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:30px 28px 8px;">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            <td style="width:52px;height:52px;border-radius:26px;background:${tone.color};color:#ffffff;text-align:center;font-size:26px;font-weight:700;line-height:52px;">${tone.glyph}</td>
          </tr></table>
          <h1 style="margin:18px 0 8px;font-size:22px;line-height:1.3;color:#14231b;">${esc(opts.title)}</h1>
          <p style="margin:0;font-size:15px;line-height:1.65;color:#3b4a42;">${introHtml}</p>
          ${tokenHtml}
          ${rowsHtml}
          ${buttonHtml}
          ${notesHtml}
        </td></tr>
        <tr><td style="padding:24px 28px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e6ece8;"><tr><td style="padding-top:18px;font-size:12px;line-height:1.7;color:#8a978f;">
            Need help? <a href="${WHATSAPP}" style="color:${GREEN};font-weight:600;">Chat with us on WhatsApp</a><br>
            ${BRAND} &middot; <a href="${esc(base)}" style="color:#8a978f;">${esc(base.replace(/^https?:\/\//, ''))}</a><br>
            This is an automated message. Please do not reply to it.
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function plainText(opts) {
  const lines = [opts.title, '', String(opts.intro || '').replace(/<[^>]+>/g, '')];
  if (opts.token) lines.push('', `${opts.token.label}: ${opts.token.value}`);
  (opts.rows || []).filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').forEach(([k, v]) => lines.push(`${k}: ${v}`));
  if (opts.button) lines.push('', `${opts.button.text}: ${opts.button.url}`);
  (opts.notes || []).forEach((n) => lines.push('', String(n).replace(/<[^>]+>/g, '')));
  lines.push('', `${BRAND}`);
  return lines.join('\n');
}

// -------------------------------------------------------------------------
// Sending: one email at a time with a short gap (Resend allows ~2 per second),
// one retry if Resend says "slow down". A failed email never breaks a purchase.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

function enqueue(job) {
  const run = chain.then(job, job);
  chain = run.then(() => sleep(600), () => sleep(600));
  return run;
}

async function post(payload, attempt = 0) {
  try {
    await axios.post('https://api.resend.com/emails', payload, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 429 && attempt < 2) {
      await sleep(1500);
      return post(payload, attempt + 1);
    }
    console.error('Resend error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return { ok: false, status: err.response?.status };
  }
}

// opts: the layout options plus { to, subject }
function sendBranded(opts) {
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean);
  if (!recipients.length) return Promise.resolve({ ok: false, skipped: true });

  if (!process.env.RESEND_API_KEY) {
    console.log(`[email:dev] RESEND_API_KEY not set. Would send "${opts.subject}" to ${recipients.join(', ')}${opts.button ? `\n  Link: ${opts.button.url}` : ''}`);
    return Promise.resolve({ ok: true, dev: true });
  }

  const payload = {
    from: fromAddress(),
    to: recipients,
    subject: opts.subject,
    html: layout(opts),
    text: plainText(opts)
  };
  if (process.env.EMAIL_REPLY_TO) payload.reply_to = process.env.EMAIL_REPLY_TO;
  return enqueue(() => post(payload));
}

// Many emails at once (admin notices). Resend takes up to 100 per request.
// If a batch is refused, its emails are sent one by one so nobody is skipped.
async function postBatch(payloads, attempt = 0) {
  try {
    await axios.post('https://api.resend.com/emails/batch', payloads, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 429 && attempt < 2) {
      await sleep(1500);
      return postBatch(payloads, attempt + 1);
    }
    console.error('Resend batch error:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return { ok: false };
  }
}

// list: array of the same options sendBranded takes (each with one `to`). Returns { sent, failed }.
async function sendBrandedMany(list) {
  const items = list.filter((o) => o && o.to);
  if (!items.length) return { sent: 0, failed: 0 };

  if (!process.env.RESEND_API_KEY) {
    console.log(`[email:dev] RESEND_API_KEY not set. Would send "${items[0].subject}" to ${items.length} recipient(s).`);
    return { sent: items.length, failed: 0, dev: true };
  }

  const toPayload = (o) => {
    const p = { from: fromAddress(), to: [].concat(o.to), subject: o.subject, html: layout(o), text: plainText(o) };
    if (process.env.EMAIL_REPLY_TO) p.reply_to = process.env.EMAIL_REPLY_TO;
    return p;
  };

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100).map(toPayload);
    const r = await enqueue(() => postBatch(chunk));
    if (r.ok) { sent += chunk.length; continue; }
    for (const p of chunk) {
      const one = await enqueue(() => post(p));
      if (one.ok) sent += 1; else failed += 1;
    }
  }
  return { sent, failed };
}

// -------------------------------------------------------------------------
// Account emails (verification + password reset)
function sendVerificationEmail(user, rawToken) {
  const link = `${frontendUrl()}/verify-email.html?token=${rawToken}`;
  const first = (user.fullName || '').split(' ')[0] || 'there';
  return sendBranded({
    to: user.email,
    subject: `Verify your email: ${BRAND}`,
    tone: 'info',
    title: `Welcome, ${first}!`,
    intro: 'Thanks for signing up. Please confirm your email address to activate your account and start using your wallet.',
    button: { text: 'Verify my email', url: link },
    showLink: true,
    notes: ['This link expires in 24 hours. If you did not create this account, you can safely ignore this email.']
  });
}

function sendPasswordResetEmail(user, rawToken) {
  const link = `${frontendUrl()}/reset-password.html?token=${rawToken}`;
  return sendBranded({
    to: user.email,
    subject: `Reset your password: ${BRAND}`,
    tone: 'security',
    title: 'Reset your password',
    intro: 'We received a request to reset the password for your account. Click the button below to choose a new one.',
    button: { text: 'Reset password', url: link },
    showLink: true,
    notes: ['This link expires in 1 hour and can only be used once. If you did not ask for this, ignore this email. Your password will not change.']
  });
}

module.exports = { sendBranded, sendBrandedMany, sendVerificationEmail, sendPasswordResetEmail, BRAND };
