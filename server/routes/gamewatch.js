const express = require('express');
const transcodeSession = require('../services/transcodeSession');
const activityTracker = require('../services/activityTracker');
const gw = require('../services/gamewatchActive');

// Read by the gamewatch server, not by browsers: mounted before requireAuth and guarded by a shared secret instead.
// Off (404) unless GAMEWATCH_SECRET is set.
const publicRouter = express.Router();
publicRouter.get('/active', (req, res) => {
    const secret = process.env.GAMEWATCH_SECRET || '';
    if (!secret) return res.status(404).json({ error: 'Not found' });
    if (!gw.secretMatches(req.get('x-gamewatch-secret'), secret)) return res.status(403).json({ error: 'Forbidden' });
    const entries = [...transcodeSession.getAllSessions(), ...activityTracker.getActive()];
    res.set('Cache-Control', 'no-store');
    res.json({ active: gw.buildActive({ entries }) });
});

// Heartbeat from the signed-in player page: which channel it is on and what programme the guide says is airing.
const authRouter = express.Router();
authRouter.post('/report', (req, res) => {
    const { channel, title } = req.body || {};
    gw.record({ userId: req.user && req.user.id, username: req.user && req.user.username, channel, title });
    res.status(204).end();
});

module.exports = { publicRouter, authRouter };
