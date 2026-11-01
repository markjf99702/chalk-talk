// The board: draws the field, both teams, the drawn-up assignments, and the play as it runs.
// It reads its colours from CSS custom properties, so the chalkboard (dark) and whiteboard (light) look
// both come from css/app.css.
import { SIDELINE, HASH } from './playbook.js';

const W_YDS = SIDELINE * 2 + 1.6; // a little room outside each sideline
// The bottom of the view, behind the offense: the deepest a back or a dropping quarterback goes (about nine yards), and
// room past that for his label, so it isn't cut off at the edge.
const Y_LOW = -12;
// How far the words over the deep end of the board reach into it, in CSS pixels: the matchup line, and the caption or
// the button down to the explanation under it (.matchup, .caption and .why in css/app.css).
const WORDS = 72;
// Zoomed to the line (on a phone, when it's asked for), the board is this many times as big, centred on the ball, with
// the ball this far down from the deep end, so the linebackers stay clear of the words there and the backs show.
const ZOOM = 2, BALL_AT = 0.57;

export class Board {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.play = null;
    this.t = 0;
    this.flip = false; // the defense's view: the board turned around
    this.labels = true;
    this.showMine = true;
    this.showTheirs = false;
    this.waitSnap = false; // the other side's call came out with this snap: its drawn-up play waits for the ball to be snapped
    this.mineTeam = 'O';
    this.selected = -1;
    this.spot = -1; // the man the caption names, ringed while nobody is picked out
    this.spotAll = null; // or the men, where it names more than one (the blitzers)
    this.drawn = null; // where each player's label went in the last frame, by player: [x, y] (see labelSpots())
    this.mark = null; // what's written at the spot when the whistle blows: { text, big, win } (set by js/app.js)
    this.zoomU = 0; // how far zoomed to the line, 0 to 1 (js/app.js eases it in and out: see frame())
    this.still = matchMedia('(prefers-reduced-motion: reduce)');
    this.colors = {};
    this.grain = null;
    this.resize();
  }

  readColors() {
    const cs = getComputedStyle(this.cv);
    const v = n => cs.getPropertyValue(n).trim();
    this.colors = { board: v('--board'), line: v('--field-line'), num: v('--field-num'), side: v('--field-side'), ten: v('--field-ten'), off: v('--off'), def: v('--def'), los: v('--los'), ball: v('--ball'), hot: v('--hot'), chalk: v('--chalk-grain') === '1' };
    this.makeGrain();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.k0 = this.w / W_YDS; // pixels per yard, with the field from sideline to sideline
    this.k = this.k0; // and as the camera has it now (see frame())
    this.ox = 0;
    this.rangeY = this.h / this.k0;
    this.top = Y_LOW + this.rangeY;
    this.grain = null;
    if (this.play) this.setPlay(this.play, this.t);
    this.readColors();
  }

  // Chalk dust: specks punched out of everything drawn, so lines look like chalk rather than paint.
  makeGrain() {
    if (!this.colors.chalk) { this.grain = null; return; }
    const g = document.createElement('canvas');
    g.width = g.height = 160;
    const c = g.getContext('2d');
    let a = 7;
    const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.5})`;
      const s = rnd() < 0.85 ? 1 : 2;
      c.fillRect(Math.floor(rnd() * 160), Math.floor(rnd() * 160), s, s);
    }
    this.grain = this.ctx.createPattern(g, 'repeat');
  }

  setPlay(play, t = 0) {
    this.play = play; this.t = t;
    this.camTrack = play ? camera(play, this.rangeY) : null;
    this.zoomTrack = play ? zoomCamera(play, this.w / (this.k0 * ZOOM), this.h / (this.k0 * ZOOM)) : null;
    this.pull = play ? this.pullTop() : null;
  }

  duration() { return this.play ? this.play.frames[this.play.frames.length - 1].t : 0; }
  // When the frames start: at the snap, or before it, with a man in motion (the time before the snap counts below 0).
  start() { return this.play ? this.play.frames[0].t : 0; }

  // Frame lookup, blending between the two nearest recorded frames.
  at(t) {
    const F = this.play.frames, dt = F.length > 1 ? F[1].t - F[0].t : 0.05;
    const f = Math.max(0, Math.min(F.length - 1, (t - F[0].t) / dt));
    const i = Math.floor(f), j = Math.min(F.length - 1, i + 1), u = f - i;
    return { a: F[i], b: F[j], u, i };
  }

  pos(t, n) {
    const { a, b, u } = this.at(t);
    return { x: a.xy[2 * n] + (b.xy[2 * n] - a.xy[2 * n]) * u, y: a.xy[2 * n + 1] + (b.xy[2 * n + 1] - a.xy[2 * n + 1]) * u };
  }

  cam(t) {
    if (!this.camTrack) return 0;
    const { i, u } = this.at(t);
    const c = this.camTrack;
    return c[i] + ((c[i + 1] ?? c[i]) - c[i]) * u;
  }

  // The camera at time t: the yards in view, from this.top down, and so how many pixels a yard is (this.k), with the
  // field in the middle of the board (this.ox) when it's narrower than the board. It follows the ball; at the whistle
  // of a play that ended past the line, it eases back over half a second to take in the whole play (see pullTop()),
  // or with reduced motion asked for, goes there at once. Scrubbed back before the whistle, it's following again.
  // Zoomed to the line, it's twice as big, on the ball (see zoomCamera()), and stays on it at the whistle; part way
  // in or out, the view is part way from one to the other.
  frame(t) {
    let bottom = Y_LOW + this.cam(t), top = bottom + this.rangeY;
    if (this.pull !== null && t >= this.play.result.t - 1e-6) {
      const u = this.still.matches ? 1 : ease(Math.min(1, (t - this.play.result.t) / 0.5));
      bottom += (Y_LOW - bottom) * u;
      top += (this.pull - top) * u;
    }
    let k = this.h / (top - bottom), ox = (this.w - W_YDS * k) / 2;
    if (this.zoomU > 0 && this.zoomTrack) {
      const { i, u } = this.at(t), Z = this.zoomTrack, at = a => a[i] + ((a[i + 1] ?? a[i]) - a[i]) * u;
      const kz = this.k0 * ZOOM, topz = at(Z.y) + this.h * BALL_AT / kz;
      const oxz = Math.min(0, Math.max(this.w - W_YDS * kz, this.w / 2 - (at(Z.x) + W_YDS / 2) * kz)); // the field across the board
      // the view as a box in yards, part way from one camera's to the other's
      const z = this.zoomU, mix = (a, b) => a + (b - a) * z;
      const left = mix(-ox / k, -oxz / kz), tp = mix(top, topz), bt = mix(bottom, topz - this.h / kz);
      top = tp; k = this.h / (tp - bt); ox = -left * k;
    }
    this.top = top;
    this.k = k;
    this.ox = ox;
  }

  // Where the camera pulls back to at the whistle, the yard at the top of the view, or null where it stays. Once a
  // play has ended past the line (the spot, or the ball where a man still running ran on past it, where an incomplete
  // pass came down, or the man who picked it off), the view goes from just behind the backfield, as before the snap, to
  // at least 3 yards past that, with it clear of the words over the deep end of the board. Where the view at the end
  // already shows all that, it stays.
  pullTop() {
    const P = this.play, res = P.result, F = P.frames;
    let end;
    if (res.kind === 'int' && res.by >= 0) end = F[F.length - 1].xy[2 * res.by + 1];
    else if (res.kind === 'incomplete' || res.kind === 'throwaway') { let b = F.length - 1; while (b > 0 && !F[b - 1].air) b--; end = F[b].ball[1]; }
    else end = res.long ? Math.max(res.yards, F[F.length - 1].ball[1]) : res.yards; // a man still running runs on past it
    if (!(end > 0)) return null;
    const a = end - Y_LOW, room = Math.min(0.6, (WORDS + 8) / this.h);
    const top = Y_LOW + Math.max(this.rangeY, a + 3, a / (1 - room));
    return this.camTrack[F.length - 1] < 0.05 && top <= Y_LOW + this.rangeY + 1e-6 ? null : top;
  }

  // Yards to pixels (CSS pixels).
  sx(x) { const v = this.ox + (x + W_YDS / 2) * this.k; return this.flip ? this.w - v : v; }
  sy(y) { const v = (this.top - y) * this.k; return this.flip ? this.h - v : v; }

  render() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.play) return;
    this.frame(this.t);
    this.field();
    // Lined up, before anyone moves (a man in motion goes before the snap, and leaves a trail like anyone else).
    const pre = this.t <= this.start() + 0.001, over = !pre && this.t >= this.play.result.t - 1e-6;
    // After the snap the drawn-up play stays faintly under the trails, fading to it over the first half second.
    this.assignments(pre ? 1 : 1 - 0.65 * Math.min(1, Math.max(0, this.t) / 0.5));
    if (!pre) { this.trails(); this.throwLine(); }
    if (over) this.spotLine();
    this.players(pre);
    if (pre) this.readNumbers();
    this.ballDraw();
    if (over) this.endMark();
    if (this.grain) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = this.grain;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      ctx.restore();
    }
  }

  field() {
    const { ctx, k } = this;
    const C = this.colors;
    const y1 = this.top + 1, y0 = this.top - this.h / this.k - 1;
    ctx.lineCap = 'round';
    // sidelines (each theme sets how strong they and the 10-yard lines are: see --field-side and --field-ten)
    ctx.strokeStyle = C.side; ctx.globalAlpha = 1; ctx.lineWidth = 2;
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(this.sx(sd * SIDELINE), this.sy(y0)); ctx.lineTo(this.sx(sd * SIDELINE), this.sy(y1)); ctx.stroke(); }
    // yard lines every five, hash marks every yard
    for (let y = Math.ceil(y0); y <= y1; y++) {
      if (y % 5 === 0) {
        const ten = y % 10 === 0;
        ctx.strokeStyle = ten ? C.ten : C.line; ctx.globalAlpha = ten ? 1 : 0.22; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(this.sx(-SIDELINE), this.sy(y)); ctx.lineTo(this.sx(SIDELINE), this.sy(y)); ctx.stroke();
      } else {
        ctx.strokeStyle = C.line; ctx.globalAlpha = 0.26; ctx.lineWidth = 1;
        const tick = 0.7;
        for (const hx of [-HASH, HASH]) { ctx.beginPath(); ctx.moveTo(this.sx(hx - tick / 2), this.sy(y)); ctx.lineTo(this.sx(hx + tick / 2), this.sy(y)); ctx.stroke(); }
        for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(this.sx(sd * SIDELINE), this.sy(y)); ctx.lineTo(this.sx(sd * (SIDELINE - tick)), this.sy(y)); ctx.stroke(); }
      }
    }
    // yard markers, counted from the line of scrimmage: every five yards, or every ten with the camera pulled back
    ctx.globalAlpha = 1; ctx.fillStyle = C.num;
    const fs = Math.max(9, Math.min(13, k * 0.95)), step = 5 * k < fs * 2.2 ? 10 : 5;
    ctx.font = `600 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      if (y <= 0) continue;
      for (const sd of [-1, 1]) {
        const x = sd * (SIDELINE - 6.5);
        ctx.save();
        ctx.translate(this.sx(x), this.sy(y));
        ctx.rotate((this.flip ? -1 : 1) * sd * Math.PI / 2);
        ctx.fillText(String(y), 0, 0);
        ctx.restore();
      }
    }
    // the line of scrimmage
    ctx.globalAlpha = 0.85; ctx.strokeStyle = C.los; ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(this.sx(-SIDELINE), this.sy(0)); ctx.lineTo(this.sx(SIDELINE), this.sy(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  teamColor(team) { return team === 'O' ? this.colors.off : this.colors.def; }

  // Whether a team's drawn-up play is shown: the other side's once it's out, but not before the snap if it was hidden
  // until the snap (see waitSnap).
  shows(team) { return team === this.mineTeam ? this.showMine : this.showTheirs && !(this.waitSnap && this.t < -1e-6); }

  // The drawn-up play: routes, blocks, rush lanes, zone drops, man assignments.
  assignments(alpha) {
    const { ctx, play } = this;
    const show = team => this.shows(team);
    // Where each man's lines start: his spot at the snap, or before it (while a man goes in motion and the defense
    // moves with him), wherever he is.
    const P = this.t < -1e-6 ? play.players.map(p => this.pos(this.t, p.i)) : play.players;
    const lw = Math.max(1.6, Math.min(2.6, this.k * 0.18));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const o of play.overlay) {
      if (!show(o.team)) continue;
      const col = this.teamColor(o.team);
      const sel = this.selected >= 0 ? (o.i === this.selected || o.to === this.selected) : true;
      ctx.globalAlpha = alpha * (sel ? 0.95 : 0.25);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw;
      const from = P[o.i];
      if (o.kind === 'motion') { // a zigzag behind the line, the way a playbook draws motion, to where his route starts
        this.zigzag(o.pts);
      } else if (o.kind === 'route' || o.kind === 'carry' || o.kind === 'qb' || o.kind === 'pull') {
        const pts = o.pts;
        ctx.setLineDash(o.kind === 'qb' ? [3, 4] : o.delay ? [6, 4] : []);
        this.poly(pts);
        ctx.setLineDash([]);
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        if (o.kind === 'pull') this.blockMark(a, b);
        else if (o.kind !== 'qb') this.arrow(a, b);
      } else if (o.kind === 'block') {
        const to = o.to >= 0 ? P[o.to] : null;
        const end = to ? { x: from.x + (to.x - from.x) * 0.55, y: from.y + (to.y - from.y) * 0.55 } : { x: from.x, y: from.y + 1.2 };
        this.poly([from, end]); this.blockMark(from, end);
      } else if (o.kind === 'pro') {
        // toward the rusher he has, or a short set straight back if he's helping
        const to = o.to >= 0 ? P[o.to] : null;
        if (o.screen) { ctx.setLineDash([2, 4]); this.poly([from, { x: from.x, y: from.y - 1 }, o.screen]); ctx.setLineDash([]); this.blockMark({ x: from.x, y: from.y - 1 }, o.screen); }
        else if (to) { const end = { x: from.x + (to.x - from.x) * 0.45, y: from.y + (to.y - from.y) * 0.45 }; this.poly([from, end]); this.blockMark(from, end); }
        else { const end = { x: from.x, y: from.y + 0.75 }; this.poly([from, end]); this.blockMark(from, end); }
      } else if (o.kind === 'rush') {
        // A blitzer's arrow: the bright colour, and a shape of its own as well, so it isn't told apart by colour alone
        // (WCAG 2.2, 1.4.1 Use of Color): a thicker line and a second head set back along it.
        const [a0, to] = o.pts, big = o.blitz ? 1.2 : 1, a = this.t < -1e-6 ? from : a0;
        // A blitzer's arrow stops at the front of the offensive line, where its heads can be seen, rather than going on
        // under the blockers' marks into his gap.
        const front = -0.6 + this.radius() / this.k + 0.25;
        const b = o.blitz && a.y > front + 1.2 && to.y < front ? { x: a.x + (to.x - a.x) * (a.y - front) / (a.y - to.y), y: front } : to;
        if (o.blitz) { ctx.strokeStyle = ctx.fillStyle = this.colors.hot; ctx.lineWidth = lw * 1.6; }
        this.poly([a, b]);
        this.arrow(a, b, big);
        if (o.blitz) { // the second head a head's length back (about 0.8 yards on a bigger board), so the two read as two
          const back = Math.max(0.8, this.head(big) / this.k), len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          this.arrow(a, { x: b.x - (b.x - a.x) / len * back, y: b.y - (b.y - a.y) / len * back }, big);
        }
      } else if (o.kind === 'man') {
        const to = P[o.to];
        ctx.setLineDash([1, 5]); ctx.lineWidth = lw * 1.1;
        this.poly([from, to]); ctx.setLineDash([]);
      } else if (o.kind === 'zone') {
        ctx.setLineDash([4, 5]);
        this.poly([from, o.at]); ctx.setLineDash([]);
        const rx = (o.deep ? 6.5 : 4) * this.k, ry = (o.deep ? 3.4 : 2.3) * this.k;
        ctx.globalAlpha = alpha * (sel ? 0.16 : 0.05);
        ctx.beginPath(); ctx.ellipse(this.sx(o.at.x), this.sy(o.at.y), rx, ry, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = alpha * (sel ? 0.5 : 0.15);
        ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Before the snap, the quarterback's reads numbered in chalk in the order he reads them, the way play art in a
  // playbook has them: past the arrowhead of each route he reads, with the board's colour knocked out round the figure
  // like a label's. Only where the routes are shown, so a hidden call stays hidden.
  readNumbers() {
    const routes = this.play.overlay.filter(o => o.kind === 'route' && o.read).sort((a, b) => a.read - b.read);
    if (!routes.length || !this.shows('O')) return;
    const { ctx } = this, fs = this.readSize();
    ctx.save();
    ctx.font = `400 ${fs}px "Patrick Hand", "Marker Felt", "Comic Sans MS", cursive`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const spots = this.readSpots(routes, fs);
    routes.forEach((o, n) => {
      const [x, y] = spots[n], text = String(o.read);
      ctx.globalAlpha = this.selected >= 0 && this.selected !== o.i ? 0.3 : 1;
      ctx.lineWidth = 3.5; ctx.strokeStyle = this.colors.board; ctx.strokeText(text, x, y);
      ctx.fillStyle = this.teamColor('O'); ctx.fillText(text, x, y);
    });
    ctx.restore();
  }
  readSize() { return Math.max(13, Math.min(17, this.k * 1.05)); }

  // Where each read's number goes, in the order given: [x, y], the middle of the figure. Just past the arrowhead, along
  // the route's last leg; or else beside the arrowhead; or else beside the route farther back along it: the first of
  // those that's on the board, clear of the words over its deep end (the matchup line, and the caption under it), and
  // clear of the players' marks, their labels and the numbers already placed. A go route runs up under the words, so
  // its number comes back down beside it to just under them. A route stays on the board, so there's always a place
  // clear of the edges and the words.
  readSpots(routes, fs) {
    const { ctx } = this, r = this.radius(), ls = this.labelSize(), P = this.play.players;
    const band = this.flip ? [this.h - WORDS, this.h] : [0, WORDS];
    const box = (x, y, w, pad) => ({ l: x - w / 2 - pad, r: x + w / 2 + pad, t: y - fs * 0.42 - pad, b: y + fs * 0.42 + pad });
    const meets = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const taken = P.map(p => { const q = this.pos(this.t, p.i), x = this.sx(q.x), y = this.sy(q.y); return { l: x - r - 1, r: x + r + 1, t: y - r - 1, b: y + r + 1 }; });
    if (this.drawn) for (const p of P) { const [x, y] = this.drawn[p.i], half = ls * 0.32 * p.label.length + 1; taken.push({ l: x - half, r: x + half, t: y - ls / 2, b: y + ls / 2 }); }
    return routes.map(o => {
      const w = ctx.measureText(String(o.read)).width;
      const clear = (x, y, all = true) => {
        const b = box(x, y, w, 1);
        return b.l >= 3 && b.r <= this.w - 3 && b.t >= 2 && b.b <= this.h - 2 && (b.b < band[0] || b.t > band[1]) && !(all && taken.some(t => meets(b, t)));
      };
      const S = o.pts.map(p => [this.sx(p.x), this.sy(p.y)]);
      const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; };
      const end = S[S.length - 1], [ux, uy] = unit(S[S.length - 2], end), side = fs * 0.75, past = Math.max(w, fs * 0.8) / 2 + 4;
      const tries = [[end[0] + ux * past, end[1] + uy * past]];
      for (const sd of [1, -1]) tries.push([end[0] - ux * this.head() * 0.5 - uy * side * sd, end[1] - uy * this.head() * 0.5 + ux * side * sd]);
      // back along the route, a few pixels at a time, on either side of it
      for (let n = S.length - 1; n > 0; n--) {
        const a = S[n - 1], b = S[n], [vx, vy] = unit(a, b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = len; s >= 0; s -= 4) for (const sd of [1, -1]) tries.push([a[0] + vx * s - vy * side * sd, a[1] + vy * s + vx * side * sd]);
      }
      // nowhere clear of everything: clear of the edges and the words at least, over a mark if it must be
      const spot = tries.find(([x, y]) => clear(x, y)) || tries.find(([x, y]) => clear(x, y, false)) || tries[0];
      taken.push(box(spot[0], spot[1], w, 1));
      return spot;
    });
  }

  // A line drawn as a zigzag, a little either side of it, about a yard to each zig (and as many as fit).
  zigzag(pts) {
    const { ctx } = this, S = pts.map(p => [this.sx(p.x), this.sy(p.y)]), amp = Math.max(2.5, this.k * 0.3), step = Math.max(6, this.k * 0.9);
    const len = S.slice(1).reduce((n, b, i) => n + Math.hypot(b[0] - S[i][0], b[1] - S[i][1]), 0), zigs = Math.max(2, Math.round(len / step));
    const at = d => { // the point d pixels along the line, and the way it runs there
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1], b = S[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d <= l || i === S.length - 1) { const u = l ? Math.min(1, d / l) : 0; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, (b[0] - a[0]) / (l || 1), (b[1] - a[1]) / (l || 1)]; }
        d -= l;
      }
      return [...S[0], 1, 0];
    };
    ctx.beginPath();
    ctx.moveTo(...S[0]);
    for (let k = 1; k < zigs; k++) { const [x, y, ux, uy] = at(len * k / zigs), sd = k % 2 ? 1 : -1; ctx.lineTo(x - uy * amp * sd, y + ux * amp * sd); }
    ctx.lineTo(...S.at(-1));
    ctx.stroke();
  }

  poly(pts) {
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach((p, n) => (n ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
    ctx.stroke();
  }

  // An arrowhead's length in pixels, times big.
  head(big = 1) { return Math.max(6, Math.min(10, this.k * 0.6)) * big; }

  arrow(a, b, big = 1) {
    const { ctx } = this;
    const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
    const ang = Math.atan2(by - ay, bx - ax), s = this.head(big);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - s * Math.cos(ang - 0.45), by - s * Math.sin(ang - 0.45));
    ctx.lineTo(bx - s * Math.cos(ang + 0.45), by - s * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  // The coach's block mark: a short bar across the end of the line.
  blockMark(a, b) {
    const { ctx } = this;
    const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
    const ang = Math.atan2(by - ay, bx - ax) + Math.PI / 2, s = Math.max(4, Math.min(7, this.k * 0.42));
    ctx.beginPath();
    ctx.moveTo(bx + s * Math.cos(ang), by + s * Math.sin(ang));
    ctx.lineTo(bx - s * Math.cos(ang), by - s * Math.sin(ang));
    ctx.stroke();
  }

  trails() {
    const { ctx, play } = this;
    const { i } = this.at(this.t);
    const lw = Math.max(1.2, Math.min(2, this.k * 0.13));
    ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const p of play.players) {
      const dim = this.selected >= 0 && this.selected !== p.i;
      ctx.globalAlpha = dim ? 0.12 : 0.42;
      ctx.strokeStyle = this.teamColor(p.team);
      ctx.beginPath();
      for (let f = 0; f <= i; f += 2) {
        const F = play.frames[f];
        const x = this.sx(F.xy[2 * p.i]), y = this.sy(F.xy[2 * p.i + 1]);
        f ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      const now = this.pos(this.t, p.i);
      ctx.lineTo(this.sx(now.x), this.sy(now.y));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // The throw: a dotted chalk line from where the ball left his hand to where it's got to, and once it's down, to where
  // it came down. It stays with the trails.
  throwLine() {
    const { ctx } = this, F = this.play.frames, a = F.findIndex(f => f.air);
    if (a < 1) return;
    const { i } = this.at(this.t);
    if (i < a) return;
    let b = a;
    while (b + 1 < F.length && F[b + 1].air) b++;
    const from = F[a - 1].ball, to = i > b ? (F[b + 1] || F[b]).ball : this.ballAt(this.t);
    ctx.save();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = this.colors.ball; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.6, Math.min(2.4, this.k * 0.16));
    ctx.setLineDash([0.1, Math.max(4, this.k * 0.45)]);
    this.poly([{ x: from[0], y: from[1] }, { x: to[0], y: to[1] }]);
    ctx.restore();
  }

  // The marks at the whistle, how far the play went, in the colour of the side that won it (see endMark()).
  // How far along they are: drawn on over a quarter of a second, or at once with reduced motion asked for.
  markIn() { return this.still.matches ? 1 : Math.min(1, (this.t - this.play.result.t) / 0.25); }
  // Where a run, a catch or a sack ended: a chalk line across the field at the spot, drawn out from the ball.
  spotLine() {
    const res = this.play.result;
    if (!this.mark || !['run', 'catch', 'sack'].includes(res.kind)) return;
    const { ctx } = this, u = this.markIn(), bx = this.ballAt(this.t)[0];
    ctx.save();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = this.teamColor(this.mark.win); ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, Math.min(3, this.k * 0.2));
    this.poly([{ x: bx + (-SIDELINE - bx) * u, y: res.yards }, { x: bx + (SIDELINE - bx) * u, y: res.yards }]);
    ctx.restore();
  }
  // The result written in marker beside the ball ("+17", "Sack −7"), beside the defender who picked it off, or beside
  // a small × where an incomplete pass came down. A big play gets bigger writing. With a spot, it sits on the spot's
  // line; without one, by the × or the man (see markSpot()).
  endMark() {
    const res = this.play.result, m = this.mark;
    if (!m) return;
    const { ctx } = this, F = this.play.frames, r = this.radius(), col = this.teamColor(m.win);
    let at;
    if (res.kind === 'int' && res.by >= 0) { const p = this.pos(this.t, res.by); at = [p.x, p.y]; }
    else if (res.kind === 'incomplete' || res.kind === 'throwaway') {
      let b = F.length - 1;
      while (b > 0 && !F[b - 1].air) b--; // the first picture after the ball came down
      at = F[b].ball;
    } else at = this.ballAt(this.t);
    const down = res.kind === 'incomplete' || res.kind === 'throwaway', s = Math.max(3, r * 0.45);
    let X = this.sx(at[0]);
    const Y = this.sy(at[1]), alpha = this.markIn();
    if (down) X = Math.max(s + 2, Math.min(this.w - s - 2, X)); // on the board, if it went out
    ctx.save();
    ctx.globalAlpha = alpha; ctx.strokeStyle = ctx.fillStyle = col; ctx.lineCap = 'round';
    if (down) { // a small ×, where it came down
      ctx.strokeStyle = this.colors.ball; ctx.lineWidth = Math.max(1.6, r * 0.25);
      ctx.beginPath(); ctx.moveTo(X - s, Y - s); ctx.lineTo(X + s, Y + s); ctx.moveTo(X + s, Y - s); ctx.lineTo(X - s, Y + s); ctx.stroke();
    }
    const fs = Math.max(18, Math.min(24, this.k * 1.4)) * (m.big ? 1.4 : 1); // a 1 in marker needs 18 px to read
    ctx.font = `400 ${fs}px "Permanent Marker", "Marker Felt", "Comic Sans MS", cursive`;
    ctx.textBaseline = 'middle';
    const [x, y] = this.markSpot(X, Y, ctx.measureText(m.text).width, fs, ['run', 'catch', 'sack'].includes(res.kind));
    ctx.textAlign = 'left'; ctx.lineJoin = 'round';
    ctx.lineWidth = 4; ctx.strokeStyle = this.colors.board;
    ctx.strokeText(m.text, x, y);
    ctx.fillText(m.text, x, y);
    ctx.restore();
  }

  // Where the writing at the whistle goes, its left end and its middle, for a word w wide and fs tall about the point
  // X, Y, clear of every player's mark and label if it can be (a run ends in a pile). It keeps off the words over the
  // deep end of the board (the matchup, and the button down to the explanation) and inside the board. Along a spot's
  // line (along), it sits just beside the point, on the line or just under it, or else farther along the line. With no
  // line (an incomplete pass, an interception), it stays by the × or the man who has the ball: beside him, above him or
  // under him, as near as it can be, and clear of the marks alone if it can't be clear of the labels too, so it isn't
  // written by somebody else across the board.
  markSpot(X, Y, w, fs, along = true) {
    const r = this.radius(), ls = this.labelSize(), P = this.play.players;
    const marks = P.map(p => { const q = this.pos(this.t, p.i), x = this.sx(q.x), y = this.sy(q.y); return { l: x - r - 2, r: x + r + 2, t: y - r - 2, b: y + r + 2 }; });
    const labels = this.drawn ? P.map(p => { const [x, y] = this.drawn[p.i], half = (ls * 0.32 * p.label.length) + 2; return { l: x - half, r: x + half, t: y - ls / 2, b: y + ls / 2 }; }) : [];
    const band = this.flip ? [this.h - WORDS, this.h] : [0, WORDS];
    const hits = (boxes, x, y) => boxes.some(b => x < b.r && x + w > b.l && y - fs * 0.4 < b.b && y + fs * 0.4 > b.t);
    const clear = (x, y, all = true) => x >= 6 && x + w <= this.w - 6 && y - fs / 2 >= 2 && y + fs / 2 <= this.h - 2 && (y + fs / 2 < band[0] || y - fs / 2 > band[1])
      && !hits(marks, x, y) && !(all && hits(labels, x, y));
    const gap = r * 1.2 + 4, first = X < this.w * 0.55 ? 1 : -1, tries = [];
    if (along) {
      for (let d = gap; d < this.w; d += 6) for (const sd of [first, -first]) for (const dy of [-0.6, 0.6]) tries.push([sd > 0 ? X + d : X - d - w, Y + dy * fs, d]);
      const best = tries.find(([x, y]) => clear(x, y));
      if (best) return best;
    } else {
      const reach = 4 * fs;
      for (let dy = -reach; dy <= reach; dy += fs / 4) for (let x = X - w - reach; x <= X + reach; x += 4) {
        const y = Y + dy, ex = Math.max(x - X, 0, X - (x + w)), ey = Math.max(y - fs / 2 - Y, 0, Y - (y + fs / 2));
        const d = Math.hypot(ex, ey);
        if ((ex < gap && ey < r + 2) || d > reach) continue; // not over the × or the man, and not far from him
        tries.push([x, y, d]);
      }
      tries.sort((a, b) => a[2] - b[2]);
      const best = tries.find(([x, y]) => clear(x, y)) || tries.find(([x, y]) => clear(x, y, false));
      if (best) return best;
    }
    // Nowhere clear: just beside it anyway, over the line or under it, whichever keeps it out from under the words.
    const up = Y - 0.6 * fs, inBand = y => y + fs / 2 >= band[0] && y - fs / 2 <= band[1];
    return [Math.max(6, Math.min(this.w - 6 - w, first > 0 ? X + gap : X - gap - w)), inBand(up) ? Y + 0.6 * fs : up];
  }

  // Where the ball is on the ground at time t: [x, y].
  ballAt(t) {
    const { a, b, u } = this.at(t);
    return [a.ball[0] + (b.ball[0] - a.ball[0]) * u, a.ball[1] + (b.ball[1] - a.ball[1]) * u];
  }

  radius() { return Math.max(5, Math.min(10.5, this.k * 0.62)); }
  // The players' labels: their size, and how far below a player's mark his goes (above it, when it's negative). Offense
  // labels sit on their own side of the ball, defense labels on theirs.
  labelSize() { return Math.max(8.5, Math.min(12, this.radius() * 1.15)); }
  labelDy(p) { return ((p.team === 'O') !== this.flip ? 1 : -1) * (this.radius() + this.labelSize() * 0.62); }

  // Every mark first, then every label over them, so no line or mark is drawn across a label. Before the snap a label
  // that would be on another player's mark goes beside him (see labelSpots()); once the play runs they stay in their
  // usual spots, rather than hopping about as blockers and rushers meet.
  players(pre = true) {
    const { ctx, play } = this;
    const r = this.radius();
    const { a } = this.at(this.t);
    const carrier = a.c;
    const lw = Math.max(1.8, Math.min(2.8, r * 0.3));
    ctx.lineWidth = lw; ctx.lineCap = 'round';
    const at = play.players.map(p => { const { x, y } = this.pos(this.t, p.i); return [this.sx(x), this.sy(y)]; });
    for (const p of play.players) {
      const [X, Y] = at[p.i];
      const col = this.teamColor(p.team);
      const dim = this.selected >= 0 && this.selected !== p.i;
      ctx.globalAlpha = dim ? 0.55 : 1;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      if (p.team === 'O') {
        ctx.beginPath();
        if (p.label === 'C') ctx.rect(X - r * 0.9, Y - r * 0.9, r * 1.8, r * 1.8);
        else ctx.arc(X, Y, r, 0, Math.PI * 2);
        if (carrier === p.i) ctx.fill();
        ctx.stroke();
      } else {
        const s = r * 0.8;
        ctx.beginPath();
        ctx.moveTo(X - s, Y - s); ctx.lineTo(X + s, Y + s);
        ctx.moveTo(X + s, Y - s); ctx.lineTo(X - s, Y + s);
        ctx.stroke();
      }
      if (this.selected === p.i) {
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X, Y, r * 1.9, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = lw;
      }
    }
    // The man the caption names (or the men: the blitzers): a dashed ring in the bright colour, so he can be found in a
    // crowd.
    if (this.spot >= 0 && this.selected < 0) {
      ctx.globalAlpha = 1; ctx.strokeStyle = this.colors.hot; ctx.lineWidth = Math.max(2.2, lw);
      ctx.setLineDash([r * 0.7, r * 0.45]);
      for (const i of this.spotAll || [this.spot]) { const [X, Y] = at[i]; ctx.beginPath(); ctx.arc(X, Y, r * 2.1, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    // Each label is knocked out of what's under it, the way a map's are: a stroke in the board's colour round the
    // letters, so a route, a block line or a ring passing under one stops just short of it. All the knock-outs go
    // first, so none of them cuts into a label next to it.
    this.drawn = !this.labels ? null : pre ? this.labelSpots(at, lw) : play.players.map(p => [at[p.i][0], at[p.i][1] + this.labelDy(p)]);
    if (this.drawn) {
      ctx.font = `700 ${this.labelSize()}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = this.colors.board;
      const alpha = p => (this.selected >= 0 && this.selected !== p.i ? 0.45 : 0.92);
      for (const p of play.players) { ctx.globalAlpha = alpha(p); ctx.strokeText(p.label, ...this.drawn[p.i]); }
      for (const p of play.players) { ctx.globalAlpha = alpha(p); ctx.fillStyle = this.teamColor(p.team); ctx.fillText(p.label, ...this.drawn[p.i]); }
    }
    ctx.globalAlpha = 1;
  }

  // Where each player's label goes, by player: [x, y], the middle of the word. Its own spot is just past his mark, on
  // his team's side of the ball (labelDy()). Where that's on another player's mark (under center the center's label is
  // on the quarterback, and in the I the fullback's on the tailback), it goes beside him, to the right or the left, or
  // on the other side of his mark, whichever is clear of the others' marks and labels; where none is (on the narrowest
  // phones the line is too tight for that), it stays in its own spot.
  labelSpots(at, lw) {
    const { ctx, play } = this, r = this.radius(), fs = this.labelSize(), half = fs * 0.38;
    ctx.font = `700 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    const P = play.players, w = P.map(p => ctx.measureText(p.label).width);
    // How far each mark's ink reaches from its middle: round a circle, straight across an X or the center's square.
    const reach = P.map(p => (p.team === 'D' ? r * 0.8 : p.label === 'C' ? r * 0.9 : r) + lw / 2);
    const box = (i, [x, y], pad = 0) => ({ l: x - w[i] / 2 - pad, r: x + w[i] / 2 + pad, t: y - half - pad, b: y + half + pad });
    const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    // How much of a word at this spot is on the others' marks. A word that only grazes one, by less than a pixel (about
    // what its knock-out takes off the mark), doesn't count, and a circle counts only where the word reaches its ink.
    const onMarks = (i, spot) => {
      const b = box(i, spot);
      return at.reduce((n, [X, Y], j) => {
        const k = reach[j] - 1, m = { l: X - k, r: X + k, t: Y - k, b: Y + k };
        const round = P[j].team === 'O' && P[j].label !== 'C';
        const near = Math.hypot(Math.max(b.l - X, 0, X - b.r), Math.max(b.t - Y, 0, Y - b.b));
        return j === i || (round && near >= k) ? n : n + area(b, m);
      }, 0);
    };
    const spots = P.map(p => [at[p.i][0], at[p.i][1] + this.labelDy(p)]);
    const onLabels = (i, spot) => { const b = box(i, spot, 0.5); return spots.reduce((n, s, j) => (j === i ? n : n + area(b, box(j, s, 0.5))), 0); };
    // Beside him, then the other side of his mark, then either side slid along a little (a nose tackle head up on the
    // center leaves room just past his shoulder): the first that's clear of the others' marks and labels.
    const tries = i => {
      const [X, Y] = at[i], dy = this.labelDy(P[i]), aside = r + 2 + w[i] / 2, out = [[X + aside, Y], [X - aside, Y], [X, Y - dy]];
      for (let s = 1; s <= Math.ceil(r * 1.6); s++) out.push([X + s, Y - dy], [X - s, Y - dy], [X + s, Y + dy], [X - s, Y + dy]);
      return out.filter(c => !onMarks(i, c) && !onLabels(i, c));
    };
    // The ones with the fewest places to go pick first.
    const moving = P.filter(p => onMarks(p.i, spots[p.i])).map(p => [p.i, tries(p.i).length]).sort((a, b) => a[1] - b[1]);
    for (const [i] of moving) spots[i] = tries(i)[0] || spots[i];
    return spots;
  }

  ballDraw() {
    const { ctx } = this;
    const { a, b, u } = this.at(this.t);
    const bx = a.ball[0] + (b.ball[0] - a.ball[0]) * u, by = a.ball[1] + (b.ball[1] - a.ball[1]) * u, bz = a.ball[2] + (b.ball[2] - a.ball[2]) * u;
    const X = this.sx(bx), Y = this.sy(by);
    const r = Math.max(7, this.radius()); // a little bigger than a player's mark would make it on a phone
    const lift = bz * this.k * 0.35;
    if (a.air) { // shadow on the ground
      ctx.globalAlpha = 0.25; ctx.fillStyle = this.colors.line;
      ctx.beginPath(); ctx.ellipse(X, Y, r * 0.55, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.ball;
    ctx.beginPath();
    const up = this.flip ? lift : -lift;
    ctx.ellipse(X + r * 0.35, Y + up - (a.air ? 0 : r * 0.1), r * 0.62, r * 0.4, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Every player a fingertip at this point on the canvas (CSS pixels) could mean, nearest first.
  hit(px, py) {
    if (!this.play) return [];
    const reach = Math.max(16, this.radius() * 2.2);
    return this.play.players.map(p => {
      const { x, y } = this.pos(this.t, p.i);
      return { i: p.i, d: Math.hypot(this.sx(x) - px, this.sy(y) - py) };
    }).filter(c => c.d < reach).sort((a, b) => a.d - b.d).map(c => c.i);
  }
}

// Easing in and out, for t from 0 to 1.
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Zoomed to the line, where the view is centred, frame by frame ({ x, y } in yards), for a view w by h yards: on the
// ball before the snap, and then the ball can move about the middle of the view, a sixth of the view's width to each
// side and an eighth of its height up or down, before the view follows it, quickly enough to keep a thrown ball in
// sight.
function zoomCamera(play, w, h) {
  const F = play.frames, x = new Float32Array(F.length), y = new Float32Array(F.length);
  let cx = F[0].ball[0], cy = F[0].ball[1];
  F.forEach((f, n) => {
    const [bx, by] = f.ball, wx = Math.max(bx - w / 6, Math.min(bx + w / 6, cx)), wy = Math.max(by - h / 8, Math.min(by + h / 8, cy));
    cx += (wx - cx) * 0.3; cy += (wy - cy) * 0.3;
    x[n] = cx; y[n] = cy;
  });
  return { x, y };
}

// Follow a long play down the field: the view slides up when the ball gets near the top.
function camera(play, rangeY) {
  const top = Y_LOW + rangeY;
  const out = new Float32Array(play.frames.length);
  let c = 0;
  play.frames.forEach((f, n) => {
    const want = Math.max(0, f.ball[1] - (top - rangeY * 0.35));
    c += (want - c) * 0.08;
    out[n] = c;
  });
  return out;
}
