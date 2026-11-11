/**
 * GameStats: a small live-score overlay on the Live TV player.
 * Self-contained (injects its own CSS and DOM). It listens for the existing `channelChanged` event,
 * asks /api/gamestats about the channel name, and shows a scorebug if the title names a real game
 * (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM"). Click the bug to collapse it to just the score.
 */
const GameStats = {
    POLL_MS: 15000,
    RETRY_MS: 60000,
    timer: null,
    title: '',
    el: null,

    init() {
        this.injectStyles();
        window.addEventListener('channelChanged', (e) => this.setChannel(e.detail));
    },

    setChannel(channel) {
        clearTimeout(this.timer);
        this.title = (channel && (channel.name || channel.tvgName)) || '';
        this.render(null);
        if (this.title) this.poll(this.title);
    },

    async poll(title) {
        let game = null;
        try {
            const res = await fetch('/api/gamestats?title=' + encodeURIComponent(title), { credentials: 'same-origin' });
            if (res.ok) game = (await res.json()).game;
        } catch (_) { /* overlay is optional; ignore */ }
        if (title !== this.title) return; // channel changed while waiting
        this.render(game);
        // Keep refreshing while a game exists and isn't over; otherwise retry slowly (a game may start).
        const done = game && game.state === 'post';
        if (!done && /\s(@|at|vs\.?|v)\s/i.test(title)) {
            this.timer = setTimeout(() => this.poll(title), game ? this.POLL_MS : this.RETRY_MS);
        }
    },

    container() {
        return document.getElementById('video-container');
    },

    render(game) {
        const host = this.container();
        if (!host) return;
        if (!game) { if (this.el) this.el.hidden = true; return; }
        if (!this.el || !host.contains(this.el)) {
            this.el = document.createElement('div');
            this.el.className = 'gamestats';
            this.el.addEventListener('click', () => {
                this.el.classList.toggle('collapsed');
                try { localStorage.setItem('gamestats-collapsed', this.el.classList.contains('collapsed') ? '1' : '0'); } catch (_) {}
            });
            try { if (localStorage.getItem('gamestats-collapsed') === '1') this.el.classList.add('collapsed'); } catch (_) {}
            host.appendChild(this.el);
        }
        this.el.hidden = false;
        const row = (t) => `
            <div class="gs-row${t.winner ? ' win' : ''}">
              ${t.logo ? `<img class="gs-logo" src="${this.esc(t.logo)}" alt="" referrerpolicy="no-referrer">` : ''}
              <span class="gs-name">${t.rank ? `<i>${t.rank}</i> ` : ''}${this.esc(t.name)}</span>
              <span class="gs-rec">${this.esc(t.record)}</span>
              <span class="gs-score">${this.esc(t.score)}</span>
            </div>`;
        const live = game.state === 'in';
        this.el.innerHTML = `
            <div class="gs-head"><span class="gs-league">${this.esc(game.league)}</span>
              <span class="gs-status${live ? ' live' : ''}">${this.esc(game.detail)}</span></div>
            ${row(game.away)}${row(game.home)}
            ${game.lastPlay ? `<div class="gs-play">${this.esc(game.lastPlay)}</div>` : ''}`;
    },

    esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    injectStyles() {
        if (document.getElementById('gamestats-css')) return;
        const s = document.createElement('style');
        s.id = 'gamestats-css';
        s.textContent = `
.gamestats{position:absolute;left:12px;bottom:84px;z-index:5;min-width:210px;max-width:320px;padding:8px 10px;
  background:rgba(12,14,20,.78);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);border-radius:10px;
  color:#fff;font:13px/1.35 Inter,system-ui,sans-serif;cursor:pointer;user-select:none;pointer-events:auto}
.gamestats[hidden]{display:none}
.gs-head{display:flex;justify-content:space-between;gap:10px;font-size:11px;opacity:.85;margin-bottom:4px}
.gs-league{font-weight:700;letter-spacing:.04em}
.gs-status.live{color:#ff6b6b;font-weight:700}
.gs-row{display:flex;align-items:center;gap:6px;padding:2px 0}
.gs-row.win .gs-name,.gs-row.win .gs-score{font-weight:700}
.gs-logo{width:18px;height:18px;object-fit:contain}
.gs-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-name i{font-style:normal;opacity:.6;font-size:11px}
.gs-rec{font-size:11px;opacity:.55}
.gs-score{min-width:28px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.gs-play{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.12);font-size:11px;opacity:.8}
.gamestats.collapsed{min-width:0}
.gamestats.collapsed .gs-logo,.gamestats.collapsed .gs-rec,.gamestats.collapsed .gs-play,.gamestats.collapsed .gs-league{display:none}
.gamestats.collapsed .gs-name{max-width:90px}
@media (max-width:640px){.gamestats{bottom:110px;left:8px;min-width:170px}}
`;
        document.head.appendChild(s);
    }
};
if (typeof window !== 'undefined') {
    window.GameStats = GameStats;
    GameStats.init();
}
if (typeof module !== 'undefined') module.exports = GameStats;
