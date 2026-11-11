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

/**
 * GET /api/gamestats/lineups?league=<key>&event=<id>
 * Returns { lineups: { sport, teams: [...] } } or { lineups: null }.
 */
router.get('/lineups', async (req, res) => {
    try {
        const lineups = await gameStats.lineups(String(req.query.league || ''), String(req.query.event || ''));
        res.set('Cache-Control', 'no-store');
        res.json({ lineups });
    } catch (err) {
        console.error('[GameStats] lineups failed:', err.message);
        res.json({ lineups: null });
    }
});

module.exports = router;
