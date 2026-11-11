/**
 * GameStats: a small live-score overlay on the Live TV player.
 * Self-contained (injects its own CSS and DOM). It listens for the existing `channelChanged` event,
 * asks /api/gamestats about the channel name, and shows a scorebug if the title names a real game
 * (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM"). Click the bug to collapse it to just the score;
 * the "Lineups" button opens player names/numbers (soccer and basketball).
 */
const GameStats = {
    POLL_MS: 15000,
    RETRY_MS: 60000,
    timer: null,
    title: '',
    el: null,
    game: null,
    lineupsOpen: false,
    lineupTimer: null,

    init() {
        this.injectStyles();
        window.addEventListener('channelChanged', (e) => this.setChannel(e.detail));
    },

    setChannel(channel) {
        clearTimeout(this.timer);
        this.closeLineups();
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
            this.el.addEventListener('click', (e) => {
                if (e.target.closest('.gs-lineups-btn')) { this.toggleLineups(); return; }
                if (e.target.closest('.gs-lineups')) return;
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
        this.game = game;
        const canLineup = game.id && /^(soccer|ncaa-soccer|ncaam|ncaaw|nba|nfl)/.test(game.leagueKey || '');
        this.el.innerHTML = `
            <div class="gs-head"><span class="gs-league">${this.esc(game.league)}</span>
              <span class="gs-status${live ? ' live' : ''}">${this.esc(game.detail)}</span></div>
            ${row(game.away)}${row(game.home)}
            ${game.lastPlay ? `<div class="gs-play">${this.esc(game.lastPlay)}</div>` : ''}
            ${canLineup ? `<button type="button" class="gs-lineups-btn">${this.lineupsOpen ? 'Hide lineups' : 'Lineups'}</button>` : ''}
            <div class="gs-lineups" ${this.lineupsOpen ? '' : 'hidden'}></div>`;
        if (this.lineupsOpen) this.loadLineups();
    },

    toggleLineups() {
        this.lineupsOpen = !this.lineupsOpen;
        const btn = this.el.querySelector('.gs-lineups-btn');
        const box = this.el.querySelector('.gs-lineups');
        if (btn) btn.textContent = this.lineupsOpen ? 'Hide lineups' : 'Lineups';
        if (box) box.hidden = !this.lineupsOpen;
        clearTimeout(this.lineupTimer);
        if (this.lineupsOpen) this.loadLineups();
    },

    closeLineups() {
        this.lineupsOpen = false;
        clearTimeout(this.lineupTimer);
    },

    async loadLineups() {
        const game = this.game;
        const box = this.el && this.el.querySelector('.gs-lineups');
        if (!game || !box) return;
        let data = null;
        try {
            const q = 'league=' + encodeURIComponent(game.leagueKey) + '&event=' + encodeURIComponent(game.id);
            const res = await fetch('/api/gamestats/lineups?' + q, { credentials: 'same-origin' });
            if (res.ok) data = (await res.json()).lineups;
        } catch (_) { /* optional */ }
        if (game !== this.game || !this.lineupsOpen) return;
        const teams = (data && data.teams) || [];
        if (!teams.length || !teams.some((t) => t.starters.length)) {
            box.innerHTML = '<div class="gs-empty">Lineups not posted yet</div>';
        } else {
            const p = (x, sub) => `<div class="gs-p${x.out ? ' out' : ''}${x.in ? ' in' : ''}"><b>${this.esc(x.num)}</b><span>${this.esc(x.name)}</span><em>${this.esc(sub ? x.stat || '' : x.pos)}</em></div>`;
            const col = (t) => `<div class="gs-col"><h4>${this.esc(t.name)}${t.formation ? ` <small>${this.esc(t.formation)}</small>` : ''}</h4>
                ${t.starters.map((x, i) => (x.unit && x.unit !== (t.starters[i - 1] || {}).unit ? `<h5>${this.esc(x.unit)}</h5>` : '') + p(x, data.sport === 'basketball')).join('')}
                ${t.bench.length ? `<h5>Bench</h5>${t.bench.map((x) => p(x, data.sport === 'basketball')).join('')}` : ''}</div>`;
            box.innerHTML = teams.map(col).join('') + (data.note ? `<div class="gs-note">${this.esc(data.note)}</div>` : '');
        }
        clearTimeout(this.lineupTimer);
        this.lineupTimer = setTimeout(() => this.loadLineups(), 30000);
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
.gs-lineups-btn{margin-top:6px;width:100%;padding:3px 0;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:11px;cursor:pointer}
.gs-lineups-btn:hover{background:rgba(255,255,255,.16)}
.gamestats.collapsed .gs-lineups-btn{display:none}
.gs-lineups{display:flex;gap:14px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);cursor:default;max-height:42vh;overflow-y:auto;min-width:420px}
.gs-lineups[hidden]{display:none}
.gamestats:has(.gs-lineups:not([hidden])){max-width:min(520px,92vw)}
.gs-col{flex:1;min-width:0}
.gs-col h4{margin:0 0 4px;font-size:12px}.gs-col h4 small{opacity:.6;font-weight:400}
.gs-col h5{margin:8px 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.55}
.gs-p{display:flex;align-items:baseline;gap:6px;font-size:12px;padding:1px 0}
.gs-p b{min-width:20px;text-align:right;font-variant-numeric:tabular-nums;opacity:.75}
.gs-p span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-p em{font-style:normal;font-size:10px;opacity:.55}
.gs-p.out span{opacity:.5;text-decoration:line-through}.gs-p.in span::after{content:' \u2191';color:#5bd98c}
.gs-note{position:sticky;bottom:0;flex-basis:100%;font-size:10px;opacity:.55}
.gs-lineups:has(.gs-note){flex-wrap:wrap}
.gs-empty{opacity:.7;font-size:12px}
@media (max-width:640px){.gamestats{bottom:110px;left:8px;min-width:170px}.gs-lineups{min-width:0;flex-direction:column}}
`;
        document.head.appendChild(s);
    }
};
if (typeof window !== 'undefined') {
    window.GameStats = GameStats;
    GameStats.init();
}
if (typeof module !== 'undefined') module.exports = GameStats;
