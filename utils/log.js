const { v4: uuidv4 } = require('uuid');
const Log = require('../models/Log');

const SECRET_KEYS = /token|password|secret|authorization|pin|key/i;

function clean(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => clean(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).slice(0, 40).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[hidden]' : clean(v, depth + 1)])
  );
}

// Best-effort: logging must never break a request.
// entry: { category, level, action, message, user:{id,email}, actor:{id,email}, req, meta }
async function logEvent(entry) {
  try {
    await Log.create({
      id: uuidv4(),
      category: entry.category || 'system',
      level: entry.level || 'info',
      action: entry.action || '',
      message: entry.message || '',
      userId: entry.user?.id,
      userEmail: entry.user?.email,
      actorId: entry.actor?.id,
      actorEmail: entry.actor?.email,
      ip: entry.req?.ip,
      meta: clean(entry.meta || {})
    });
  } catch (err) {
    console.error('Log write failed:', err.message);
  }
}

module.exports = { logEvent };
