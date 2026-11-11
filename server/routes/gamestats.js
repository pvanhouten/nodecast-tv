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

/** GET /api/gamestats/players?league=&event= -> { players: { sport, teams: [{ name, players: [...] }] } } */
router.get('/players', async (req, res) => {
    try {
        const players = await gameStats.players(String(req.query.league || ''), String(req.query.event || ''));
        res.set('Cache-Control', 'no-store');
        res.json({ players });
    } catch (err) {
        console.error('[GameStats] players failed:', err.message);
        res.json({ players: null });
    }
});

/** GET /api/gamestats/season?league=&athlete= -> { season: { title, split, labels, values } | null } */
router.get('/season', async (req, res) => {
    try {
        const season = await gameStats.playerSeason(String(req.query.league || ''), String(req.query.athlete || ''));
        res.set('Cache-Control', 'no-store');
        res.json({ season });
    } catch (err) {
        res.json({ season: null });
    }
});

/** GET /api/gamestats/search?q=ncaa mens basketball wisconsin -> { games: [...] } (live first) */
router.get('/search', async (req, res) => {
    try {
        const games = await gameStats.search(String(req.query.q || '').slice(0, 120));
        res.set('Cache-Control', 'no-store');
        res.json({ games });
    } catch (err) {
        console.error('[GameStats] search failed:', err.message);
        res.json({ games: [] });
    }
});

/** GET /api/gamestats/game?league=&event= -> { game } for a manually pinned game */
router.get('/game', async (req, res) => {
    try {
        const game = await gameStats.gameById(String(req.query.league || ''), String(req.query.event || ''));
        res.set('Cache-Control', 'no-store');
        res.json({ game });
    } catch (err) {
        res.json({ game: null });
    }
});

module.exports = router;
