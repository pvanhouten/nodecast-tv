const express = require('express');
const router = express.Router();
const gameStats = require('../services/gameStats');

/**
 * GET /api/gamestats?title=NCAAB 6 Fairfield @ Wisconsin 8PM
 * Returns { game: {...} } or { game: null }. Viewer-level (mounted behind requireAuth).
 */
router.get('/', async (req, res) => {
    try {
        const game = await gameStats.lookup(req.query.title);
        res.set('Cache-Control', 'no-store');
        res.json({ game });
    } catch (err) {
        console.error('[GameStats] lookup failed:', err.message);
        res.json({ game: null });
    }
});

module.exports = router;
