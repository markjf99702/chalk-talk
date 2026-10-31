// The board: draws the field, both teams, the drawn-up assignments, and the play as it runs.
// It reads its colours from CSS custom properties, so the chalkboard (dark) and whiteboard (light) look
// both come from css/app.css.
import { SIDELINE, HASH } from './playbook.js';

const W_YDS = SIDELINE * 2 + 1.6; // a little room outside each sideline
// The bottom of the view, behind the offense: the deepest a back or a dropping quarterback goes (about nine yards), and
// room past that for his label, so it isn't cut off at the edge.
const Y_LOW = -12;

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
    this.mineTeam = 'O';
    this.selected = -1;
    this.colors = {};
    this.grain = null;
    this.resize();
  }

  readColors() {
    const cs = getComputedStyle(this.cv);
    const v = n => cs.getPropertyValue(n).trim();
    this.colors = { line: v('--field-line'), off: v('--off'), def: v('--def'), los: v('--los'), ball: v('--ball'), hot: v('--hot'), chalk: v('--chalk-grain') === '1' };
    this.makeGrain();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.k = this.w / W_YDS; // pixels per yard
    this.rangeY = this.h / this.k;
    this.grain = null;
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

  setPlay(play) { this.play = play; this.t = 0; this.camTrack = play ? camera(play, this.rangeY) : null; }

  duration() { return this.play ? this.play.frames[this.play.frames.length - 1].t : 0; }

  // Frame lookup, blending between the two nearest recorded frames.
  at(t) {
    const F = this.play.frames, dt = F.length > 1 ? F[1].t - F[0].t : 0.05;
    const f = Math.max(0, Math.min(F.length - 1, t / dt));
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

  // Yards to pixels (CSS pixels).
  sx(x) { const v = (x + W_YDS / 2) * this.k; return this.flip ? this.w - v : v; }
  sy(y) { const v = (Y_LOW + this.camY + this.rangeY - y) * this.k; return this.flip ? this.h - v : v; }

  render() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.play) return;
    this.camY = this.cam(this.t);
    this.field();
    const pre = this.t <= 0.001;
    this.assignments(pre ? 1 : 0.22);
    if (!pre) this.trails();
    this.players();
    this.ballDraw();
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
    const y0 = Y_LOW + this.camY - 1, y1 = y0 + this.rangeY + 2;
    ctx.lineCap = 'round';
    // sidelines
    ctx.strokeStyle = C.line; ctx.globalAlpha = 0.55; ctx.lineWidth = 2;
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(this.sx(sd * SIDELINE), this.sy(y0)); ctx.lineTo(this.sx(sd * SIDELINE), this.sy(y1)); ctx.stroke(); }
    // yard lines every five, hash marks every yard
    for (let y = Math.ceil(y0); y <= y1; y++) {
      if (y % 5 === 0) {
        ctx.globalAlpha = y % 10 === 0 ? 0.32 : 0.22; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(this.sx(-SIDELINE), this.sy(y)); ctx.lineTo(this.sx(SIDELINE), this.sy(y)); ctx.stroke();
      } else {
        ctx.globalAlpha = 0.26; ctx.lineWidth = 1;
        const tick = 0.7;
        for (const hx of [-HASH, HASH]) { ctx.beginPath(); ctx.moveTo(this.sx(hx - tick / 2), this.sy(y)); ctx.lineTo(this.sx(hx + tick / 2), this.sy(y)); ctx.stroke(); }
        for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(this.sx(sd * SIDELINE), this.sy(y)); ctx.lineTo(this.sx(sd * (SIDELINE - tick)), this.sy(y)); ctx.stroke(); }
      }
    }
    // yard markers, counted from the line of scrimmage
    ctx.globalAlpha = 0.5; ctx.fillStyle = C.line;
    const fs = Math.max(9, Math.min(13, k * 0.95));
    ctx.font = `600 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) {
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

  // The drawn-up play: routes, blocks, rush lanes, zone drops, man assignments.
  assignments(alpha) {
    const { ctx, play } = this;
    const show = team => (team === this.mineTeam ? this.showMine : this.showTheirs);
    const P = play.players;
    const lw = Math.max(1.6, Math.min(2.6, this.k * 0.18));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const o of play.overlay) {
      if (!show(o.team)) continue;
      const col = this.teamColor(o.team);
      const sel = this.selected >= 0 ? (o.i === this.selected || o.to === this.selected) : true;
      ctx.globalAlpha = alpha * (sel ? 0.95 : 0.25);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw;
      const from = P[o.i];
      if (o.kind === 'route' || o.kind === 'carry' || o.kind === 'qb' || o.kind === 'pull') {
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
        if (o.blitz) ctx.strokeStyle = ctx.fillStyle = this.colors.hot;
        this.poly(o.pts.slice(0, 2));
        this.arrow(o.pts[0], o.pts[1]);
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

  poly(pts) {
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach((p, n) => (n ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
    ctx.stroke();
  }

  arrow(a, b) {
    const { ctx } = this;
    const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
    const ang = Math.atan2(by - ay, bx - ax), s = Math.max(6, Math.min(10, this.k * 0.6));
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

  radius() { return Math.max(5, Math.min(10.5, this.k * 0.62)); }

  players() {
    const { ctx, play } = this;
    const r = this.radius();
    const { a } = this.at(this.t);
    const carrier = a.c;
    const lw = Math.max(1.8, Math.min(2.8, r * 0.3));
    ctx.lineWidth = lw; ctx.lineCap = 'round';
    const fs = Math.max(8.5, Math.min(12, r * 1.15));
    ctx.font = `700 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of play.players) {
      const { x, y } = this.pos(this.t, p.i);
      const X = this.sx(x), Y = this.sy(y);
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
      if (this.labels) {
        ctx.globalAlpha = dim ? 0.45 : 0.92;
        // offense labels sit on their own side of the ball, defense labels on theirs
        const away = (p.team === 'O') !== this.flip ? 1 : -1;
        ctx.fillText(p.label, X, Y + away * (r + fs * 0.62));
      }
    }
    ctx.globalAlpha = 1;
  }

  ballDraw() {
    const { ctx } = this;
    const { a, b, u } = this.at(this.t);
    const bx = a.ball[0] + (b.ball[0] - a.ball[0]) * u, by = a.ball[1] + (b.ball[1] - a.ball[1]) * u, bz = a.ball[2] + (b.ball[2] - a.ball[2]) * u;
    const X = this.sx(bx), Y = this.sy(by);
    const r = this.radius();
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

  // Which player is under a point on the canvas (CSS pixels), or -1.
  hit(px, py) {
    if (!this.play) return -1;
    let best = -1, bd = Math.max(16, this.radius() * 2.2);
    for (const p of this.play.players) {
      const { x, y } = this.pos(this.t, p.i);
      const d = Math.hypot(this.sx(x) - px, this.sy(y) - py);
      if (d < bd) { bd = d; best = p.i; }
    }
    return best;
  }
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
