const { getSettings, isServiceOn } = require('../models/Settings');

// Blocks a route when the admin has switched that service off (or maintenance is on).
function requireService(key) {
  return async (req, res, next) => {
    try {
      const s = await getSettings();
      if (!isServiceOn(s, key)) {
        return res.status(503).json({
          error: s.maintenance ? s.maintenanceMessage : 'This service is currently unavailable.',
          code: 'SERVICE_DISABLED'
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireService };
