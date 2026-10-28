// FRONTEND_URL must be ONE address. If someone pastes several (comma separated,
// like CLIENT_ORIGIN), use the first valid one instead of building a broken link.
function frontendUrl() {
  const parts = String(process.env.FRONTEND_URL || '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => /^https?:\/\//i.test(p));
  const first = parts[0] || 'https://elmubarak.com.ng';
  return first.replace(/\/+$/, '');
}

module.exports = { frontendUrl };
