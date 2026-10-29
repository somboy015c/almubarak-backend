const express = require('express');
const { getSettings } = require('../models/Settings');

const router = express.Router();

// Things the public homepage needs (no login). Only harmless switches.
router.get('/site', async (req, res) => {
  const s = await getSettings();
  res.set('Cache-Control', 'public, max-age=20');
  res.json({
    appDownload: { enabled: !!s.appDownloadEnabled, url: s.appDownloadUrl || null }
  });
});

module.exports = router;
