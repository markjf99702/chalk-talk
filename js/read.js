// The coach's read: what the other side is showing before the snap. This is the look, as the read sees it: what a
// quarterback reads in a defense before the snap, from where the players stand on the board. tools/read-table.mjs
// measures every play against every call the other coach can make, and files each call under the look it shows.

// ---------------------------------------------------------------- the look

// What a quarterback reads in a defense before the snap, from where the players stand on the board's first frame (with
// a man in motion, before he goes): players are { team, label, cls, x, y }, in yards, x across the field and y up it
// from the line of scrimmage.
// - deep: how many are past 10 1/2 yards (the board's safeties count, as in the result card's read);
// - corners: how far off the nearer cornerback is, in the bands the result card uses: pressed (under 2 1/2 yards),
//   about 5 yards off (under 6), or 7 or more;
// - box: how many are in the box, as the simulator counts it (boxCount() in js/sim.js): from the end of the line each
//   side (a tight end within 8 yards of the ball, or else the tackle) out to 3 yards past it, and less than 8 deep;
// - walked: how many men off the line (linebackers and safeties, not the ones standing on the line at the edge, nor
//   the cornerbacks) stand in the box within 4 yards of the line: men walked up close, who might be coming;
// - blockers: the men a run hands blocks to, the line, the fullback and the tight ends within 8 yards (also as
//   boxCount() counts them).
// The key is what the read goes on: two calls with the same key look alike to it, and get the same read.
const EDGE = { under: ['S'], 34: ['S', 'J'] }; // linebackers who stand on the line at the edge in that front
export function lookOf(players, front) {
  const O = players.filter(p => p.team === 'O'), D = players.filter(p => p.team === 'D');
  const te = p => p.cls === 'te' && Math.abs(p.x) < 8;
  const end = sd => Math.max(3, ...O.filter(p => te(p) && Math.sign(p.x) === sd).map(p => Math.abs(p.x)));
  const edge = { [1]: end(1), [-1]: end(-1) };
  const inBox = d => Math.abs(d.x) < edge[Math.sign(d.x) || 1] + 3 && d.y < 8;
  const deep = D.filter(d => d.y > 10.5).length;
  const cy = Math.min(...D.filter(d => d.label === 'CB').map(d => d.y));
  const corners = cy < 2.5 ? 'press' : cy < 6 ? 'five' : 'deep';
  const box = D.filter(inBox).length;
  const off = d => !['DE', 'DT', 'NT', 'CB'].includes(d.label) && !(EDGE[front] || []).includes(d.label);
  const walked = D.filter(d => off(d) && inBox(d) && d.y < 4).length;
  const blockers = O.filter(p => p.cls === 'ol' || te(p) || p.cls === 'fb').length;
  return { deep, corners, box, walked, blockers, key: `${deep}|${corners}|${box}|${walked}` };
}
