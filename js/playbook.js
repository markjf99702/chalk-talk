// Everything a coach would put in the playbook: formations, plays, fronts, coverages, and what each position does.
// Coordinates are in yards. x runs across the field (0 is the ball, + is the offense's right),
// y runs down the field (0 is the line of scrimmage, + is toward the defense).
// Formations and fronts are written with the strength to the right; the simulator mirrors them.

export const SIDELINE = 26.67;
export const HASH = 3.08;

// Offensive line: the same five in every formation.
// motion: who can go in motion (a receiver off the line) and where he sets on the other side, x as written (strength to
// the right): the Z or the H runs across the formation, behind the line. A formation without it has no motion row.
const LINE = [['LT', -3, -0.6, 'ol'], ['LG', -1.5, -0.6, 'ol'], ['C', 0, -0.6, 'ol'], ['RG', 1.5, -0.6, 'ol'], ['RT', 3, -0.6, 'ol']];

export const FORMATIONS = [
  {
    id: 'iform', name: 'I-Form', personnel: '21', under: true, motion: { who: 'Z', to: -11 },
    blurb: 'Two backs stacked behind the quarterback, a tight end, two receivers. Built to run.',
    players: [['X', -17.5, -0.6, 'wr'], ...LINE, ['Y', 4.6, -0.6, 'te'], ['Z', 14, -1.4, 'wr'],
      ['QB', 0, -1.3, 'qb'], ['FB', 0, -4.3, 'fb'], ['RB', 0, -6.8, 'rb']],
  },
  {
    id: 'single', name: 'Singleback', personnel: '12', under: true, motion: { who: 'Z', to: -10 },
    blurb: 'One back, a tight end at each end of the line, and two receivers a step off the line.',
    players: [['X', -16, -1.4, 'wr'], ['U', -4.6, -0.6, 'te'], ...LINE, ['Y', 4.6, -0.6, 'te'], ['Z', 16, -1.4, 'wr'],
      ['QB', 0, -1.3, 'qb'], ['RB', 0, -6.3, 'rb']],
  },
  {
    id: 'pistol', name: 'Pistol', personnel: '11', under: false, motion: { who: 'H', to: 9.5 },
    blurb: 'The quarterback 4 yards behind the center, nearer than in the shotgun, with the back straight behind him, so where the back lines up doesn\'t tell the defense which way a run is going. A tight end on the line and three receivers.',
    players: [['X', -17.5, -0.6, 'wr'], ['H', -10, -1.4, 'wr'], ...LINE, ['Y', 4.6, -0.6, 'te'], ['Z', 16, -1.4, 'wr'],
      ['QB', 0, -4, 'qb'], ['RB', 0, -7, 'rb']],
  },
  {
    id: 'ace', name: 'Gun Ace', personnel: '12', under: false,
    blurb: 'Shotgun with two tight ends, each split a few yards outside a tackle and a step off the line, and a receiver out wide on each side. From there a tight end can block on a run or get straight into his route.',
    players: [['X', -18, -0.6, 'wr'], ['U', -6.2, -1.4, 'te'], ...LINE, ['Y', 6.2, -1.4, 'te'], ['Z', 18, -0.6, 'wr'],
      ['QB', 0, -5, 'qb'], ['RB', -1.6, -5.2, 'rb']],
  },
  {
    id: 'doubles', name: 'Gun Doubles', personnel: '10', under: false, motion: { who: 'H', to: 6.5 },
    blurb: 'Shotgun with four receivers, two to each side, and one back beside the quarterback.',
    players: [['X', -18, -0.6, 'wr'], ['H', -10, -1.4, 'wr'], ...LINE, ['Y', 10, -1.4, 'wr'], ['Z', 18, -0.6, 'wr'],
      ['QB', 0, -5, 'qb'], ['RB', -1.6, -5.2, 'rb']],
  },
  {
    id: 'trips', name: 'Gun Trips', personnel: '11', under: false, motion: { who: 'H', to: -10 },
    blurb: 'Shotgun with three receivers to one side and one alone on the other. The tight end is the inside man of the three.',
    players: [['X', -18, -0.6, 'wr'], ...LINE, ['Y', 6.2, -1.4, 'te'], ['H', 11, -1.4, 'wr'], ['Z', 18, -0.6, 'wr'],
      ['QB', 0, -5, 'qb'], ['RB', -1.6, -5.2, 'rb']],
  },
  {
    // The back lines up as a receiver: he's one, as a wide receiver is, with a back's legs (the fifth item: the body
    // the simulator gives him).
    id: 'empty', name: 'Empty', personnel: '10', under: false,
    blurb: 'Shotgun with nobody left beside the quarterback: the back splits out into the slot, and there are five receivers, three on one side and two on the other. Only the five linemen are left to block, so a blitz of six can\'t all be picked up, and there\'s no back to hand it to.',
    players: [['X', -18, -0.6, 'wr'], ['RB', -10, -1.4, 'wr', 'rb'], ...LINE, ['Y', 6.5, -1.4, 'wr'], ['H', 11, -1.4, 'wr'], ['Z', 18, -0.6, 'wr'],
      ['QB', 0, -5, 'qb']],
  },
];

// Routes, in [out, up] yards from where the receiver lines up. "Out" is toward his own sideline.
// settle: he stops at the end and turns to the quarterback. fromLine: "up" counts from the line of scrimmage, not from
// where he lines up (for back routes that have to end past the line wherever the back starts).
export const ROUTES = {
  go: { readyY: 10, name: 'go', pts: [[0.6, 4], [1, 50]], desc: 'Go: straight down the field, as fast as he can.' },
  seam: { readyY: 9, name: 'seam', pts: [[-0.4, 6], [-0.9, 50]], desc: 'Seam: straight up the field, splitting the deep defenders.' },
  post: { ready: 1, name: 'post', pts: [[0, 11], [-8, 22], [-12, 50]], desc: 'Post: 11 yards up, then breaks toward the goalposts in the middle of the field.' },
  corner: { ready: 1, name: 'corner', pts: [[0, 11], [7, 18], [12, 23], [12, 50]], desc: 'Corner: 11 yards up, then breaks out toward the back corner of the end zone.' },
  out: { ready: 1, name: 'out', pts: [[0, 11], [15, 11]], desc: 'Out: 11 yards up, then a hard cut toward the sideline.' },
  sail: { ready: 1, name: 'sail', pts: [[0, 8], [4, 12.5], [14, 14]], desc: 'Sail: up the field, then bends out toward the sideline at 12 to 14 yards.' },
  dig: { ready: 1, name: 'dig', pts: [[0, 12], [-20, 12.5]], desc: 'Dig: 12 yards up, then a square cut across the middle.' },
  over: { ready: 2, name: 'deep over', pts: [[0, 6], [-8, 13], [-32, 18]], desc: 'Deep over: a crossing route that climbs to about 18 yards on the far side of the field.' },
  slant: { ready: 1, name: 'slant', pts: [[0, 1.5], [-6, 7], [-16, 14]], desc: 'Slant: two steps up, then a sharp angle inside.' },
  hitch: { ready: 1, name: 'hitch', pts: [[0, 6.2], [0, 5.4]], settle: true, desc: 'Hitch: six yards up, then he stops and turns back to the quarterback.' },
  curl: { ready: 1, name: 'curl', pts: [[0, 11], [-0.6, 10]], settle: true, desc: 'Curl: 11 yards up, then curls back inside toward the quarterback.' },
  flat: { ready: 1, name: 'flat', pts: [[1.5, 1.5], [6, 3.5], [14, 4.5]], desc: 'Flat: out toward the sideline about four yards past the line.' },
  drag: { ready: 2, name: 'drag', pts: [[-1.5, 2.5], [-5, 5], [-34, 5.5]], desc: 'Drag: a shallow crossing route about five yards past the line.' },
  drag6: { ready: 2, name: 'drag', pts: [[-1.5, 3], [-5, 6.5], [-34, 7]], desc: 'Drag: a shallow crossing route about six or seven yards past the line.' },
  stick: { ready: 1, name: 'stick', pts: [[0, 5.5], [-0.8, 5.1]], settle: true, desc: 'Stick: five or six yards up, then he stops and turns in to face the quarterback, sitting down in the open spot.' },
  sit: { ready: 2, name: 'sit', pts: [[0, 5], [-1.5, 9]], settle: true, desc: 'Sit: up to about 9 yards, then settles in the hole between the zone defenders.' },
  // Backs: "out" is the side given by the play.
  wheel: { ready: 3, name: 'wheel', pts: [[3, -0.5], [7, 1], [9, 5], [9.5, 50]], desc: 'Wheel: out to the flat, then turns straight up the sideline.' },
  swing: { ready: 2, name: 'swing', pts: [[3, -1.2], [7, -1], [10, 0.5], [11.5, 3]], settle: true, desc: 'Swing: a loop out toward the sideline behind the line, a quick outlet.' },
  bflat: { ready: 1, name: 'flat', fromLine: true, pts: [[3, -4], [7.5, -0.5], [12.5, 3.3]], desc: 'Flat: out of the backfield to the flat, a few yards past the line.' },
  check: { ready: 1, name: 'check-down', fromLine: true, pts: [[3.2, -1], [3.6, 3]], settle: true, delay: 0.9, desc: 'Check-down: stays in to block if a blitzer comes, otherwise slips out to an open spot short.' },
  screen: { ready: 1, name: 'screen', pts: [[4, 1.2], [7, 2.6]], settle: true, delay: 0.85, desc: 'Screen: blocks for a moment, then slips out behind the rush and waits for the ball with linemen in front.' },
  // Not a play's route: what a man in jet motion does on a run, from the spot he was heading for, "out" the way he runs.
  jet: { ready: 1, name: 'jet', pts: [[3, 0.9], [9, 3.4]], desc: 'Jet: keeps running across at full speed, out to the flat, and takes his defender with him.' },
};

// Hot routes: what a receiver (a wide receiver or a tight end) or a back can be given instead of his route before the
// snap, on a pass play (see hotRoutes() in js/sim.js). A tight end or a back can also stay in to block, the way an
// offense gives the quarterback one more blocker against a blitz, for one less receiver; a wide receiver can't.
const RECEIVER = ['go', 'seam', 'post', 'corner', 'out', 'dig', 'slant', 'hitch', 'curl', 'flat', 'drag'];
export const HOT = {
  receiver: RECEIVER,
  te: [...RECEIVER, 'block'],
  back: ['swing', 'wheel', 'check', 'block'],
};

// Each pass play says what every eligible player does, by where he lines up:
// S1, S2, S3 are the receivers on the strong side counted from the outside in, W1, W2 the weak side, RB and FB the backs.
// side: 'S' strong or 'W' weak for back routes. reads: the quarterback's progression, first to last.
export const PLAYS = [
  {
    id: 'iz', name: 'Inside Zone', type: 'run', scheme: 'zone', aim: 1.7,
    blurb: 'Every lineman steps to the play side and blocks whoever shows up in his gap. The back aims at the guard\'s outside hip and reads the blocks: hit it, bend it back, or bounce it.',
  },
  {
    id: 'oz', name: 'Outside Zone', type: 'run', scheme: 'reach', aim: 6.2,
    blurb: 'The whole line runs sideways to reach the play side. The back presses the edge and cuts up into the first lane that opens.',
  },
  {
    id: 'power', name: 'Power', type: 'run', scheme: 'power', aim: 3.4,
    blurb: 'A gap scheme: the play-side linemen block down, the end gets kicked out, and the back-side guard pulls through the hole for the linebacker. With no fullback to kick out the end, the pulling guard does it himself.',
  },
  {
    id: 'counter', name: 'Counter', type: 'run', scheme: 'counter', aim: 3.4,
    blurb: 'A gap run with a fake in it: the back steps away from the play first, to pull the linebackers that way, then takes the handoff back the other way. The back-side guard pulls and kicks out the end, and the play-side line blocks down. With a tight end on the line on the back side to block the end they leave, the back-side tackle pulls too, follows the back through the hole and blocks whoever\'s left there; otherwise he stays home on the back side, and a fullback, if there is one, leads through the hole.',
  },
  {
    id: 'draw', name: 'Draw', type: 'run', scheme: 'draw', aim: 0.4,
    blurb: 'It looks like a pass. The line sets to pass-block and lets the rushers come up the field, and the quarterback hands it to the back late, underneath them.',
  },
  {
    id: 'verts', name: 'Four Verticals', type: 'pass', drop: 'five', reads: ['S2', 'W2', 'S3', 'S1', 'W1', 'RB'],
    routes: r => ({ S1: 'go', S2: 'seam', S3: 'seam', W1: 'go', W2: 'seam', RB: 'check', FB: 'check' }),
    blurb: 'Four receivers run straight down the field: only Cover 4 has a deep defender for each of them. Against two deep safeties, each has a receiver on either side of him, and he can\'t be over both.',
  },
  {
    id: 'smash', name: 'Smash', type: 'pass', drop: 'five', reads: ['S2', 'S1', 'W2', 'W1', 'RB', 'FB'],
    routes: r => ({ S1: 'hitch', S2: 'corner', S3: 'sit', W1: r.W2 ? 'hitch' : 'dig', W2: 'corner', RB: 'check', FB: 'check' }),
    blurb: 'The outside receiver runs a hitch at six yards and the inside one runs a corner route over the top of it. The cornerback can\'t take both. The classic Cover 2 beater.',
  },
  {
    id: 'flood', name: 'Flood', type: 'pass', drop: 'five', reads: ['S2', 'S3', 'FB', 'RB', 'W1'],
    routes: r => ({ S1: 'go', S2: 'sail', S3: 'flat', W1: 'dig', W2: 'seam', RB: r.S3 || r.FB ? 'check' : 'bflat', FB: 'bflat', side: 'S' }),
    blurb: 'Three receivers at three depths on one side: deep, a sail route at 12 to 14 yards, and the flat. It puts more receivers in the area than there are zone defenders. The classic Cover 3 beater.',
  },
  {
    id: 'mesh', name: 'Mesh', type: 'pass', drop: 'five', reads: ['S1', 'S2', 'W2', 'W1', 'S3', 'RB'],
    routes: r => ({ S1: 'corner', S2: 'drag6', S3: 'sit', W1: r.W2 ? 'corner' : 'drag', W2: 'drag', RB: 'swing', FB: 'check', side: 'S' }),
    blurb: 'Two receivers run shallow crossing routes and brush past each other in the middle. Man-to-man defenders get caught in the traffic; against a zone, the crossers settle in the holes.',
  },
  {
    id: 'slants', name: 'Slant-Flat', type: 'pass', drop: 'quick', reads: ['S1', 'S2', 'W1', 'W2'],
    routes: r => ({ S1: 'slant', S2: 'flat', S3: 'seam', W1: 'slant', W2: 'flat', RB: 'check', FB: 'check' }),
    blurb: 'Quick game: the outside receivers run slants, the inside ones run to the flat, and the ball is out in about a second. It beats the blitz.',
  },
  {
    // With three receivers on a side the inside one runs the stick and the slot runs to the flat outside him, so the
    // flat goes away from the man sitting on the stick, not under him; with two, the back runs the flat.
    id: 'stick', name: 'Stick', type: 'pass', drop: 'quick', reads: ['S3', 'S2', 'FB', 'RB', 'W2', 'W1'],
    routes: r => ({ S1: 'go', S2: r.S3 ? 'flat' : 'stick', S3: 'stick', W1: r.W2 ? 'go' : 'slant', W2: 'stick', RB: r.S3 || r.FB ? 'check' : 'bflat', FB: 'bflat', side: 'S' }),
    blurb: 'Quick game: the outside receiver runs off deep, and under him go a stick route, five yards up and sitting down facing the quarterback, and a flat route outside it. With three receivers on a side the inside one runs the stick and the slot runs to the flat; with two, the inside one runs the stick and the back runs to the flat. The defender between them can\'t take both: if he widens for the flat, the stick is open; if he sits on the stick, the flat is.',
  },
  {
    id: 'pa', name: 'Play-Action Shot', type: 'pass', drop: 'pa', reads: ['S1', 'W1', 'S2', 'RB'],
    routes: r => ({ S1: 'post', S2: r.S2 && r.S2.cls === 'te' && r.S2.y > -1 ? 'flat' : 'seam', S3: 'flat', W1: 'over', W2: 'flat', RB: 'block', FB: 'block' }),
    blurb: 'Fake the inside zone handoff to pull the linebackers forward, then throw deep: a post from one side and a deep crossing route from the other, behind the linebackers who bit.',
  },
  {
    id: 'screen', name: 'RB Screen', type: 'pass', drop: 'screen', reads: ['RB'],
    routes: r => ({ S1: 'go', S2: 'go', S3: 'go', W1: 'go', W2: 'go', RB: 'screen', FB: 'block' }),
    blurb: 'Let the rushers through, then flip it to the back behind them with three linemen out in front. Best against the blitz, worst against a defense that sits back and reads it.',
  },
];

// Defensive fronts. dl: [label, technique, side]. Technique numbers say where a lineman lines up (see TECHNIQUES).
// lb: [label, rule or [x, y]], x toward the strong side. rush: who rushes on a four-man rush. blitz: who comes on a blitz.
export const FRONTS = [
  {
    id: 'over', name: '4-3 Over', db: 'base',
    blurb: 'Four linemen and three linebackers. The line shifts toward the strong side: the 3-technique tackle lines up on the strong-side guard\'s outside shoulder.',
    dl: [['DE', '5', 'S'], ['DT', '3', 'S'], ['NT', '1', 'W'], ['DE', 'w5', 'W']],
    lb: [['S', 'sam'], ['M', [0.6, 4.8]], ['W', [-3.2, 4.6]]],
    rush: ['DE', 'DT', 'NT', 'DE'], blitz: 'M',
  },
  {
    id: 'under', name: '4-3 Under', db: 'base',
    blurb: 'The line shifts away from the strength: the 3-technique goes to the weak side, the nose shades the strong side of the center, and the Sam linebacker walks up on the line outside the tight end.',
    dl: [['DE', '5', 'S'], ['NT', '1', 'S'], ['DT', '3', 'W'], ['DE', 'w5', 'W']],
    lb: [['S', 'samUp'], ['M', [1.2, 4.8]], ['W', [-2.4, 4.6]]],
    rush: ['DE', 'NT', 'DT', 'DE'], blitz: 'M',
  },
  {
    id: '34', name: '3-4', db: 'base',
    blurb: 'Three linemen and four linebackers: a nose on the center, ends outside the tackles, two inside linebackers, and two outside linebackers standing up on the edges.',
    dl: [['DE', '5', 'S'], ['NT', '0', 'S'], ['DE', '5', 'W']],
    lb: [['S', 'edgeS'], ['M', [1.8, 4.8]], ['W', [-1.8, 4.8]], ['J', 'edgeW']],
    rush: ['DE', 'NT', 'DE', 'J'], blitz: 'M',
  },
  {
    id: 'nickel', name: 'Nickel', db: 'nickel',
    blurb: 'Four linemen, two linebackers and five defensive backs. Built for three-receiver sets: the nickel back comes in for a linebacker to cover the slot.',
    dl: [['DE', '5', 'S'], ['DT', '3', 'S'], ['NT', '1', 'W'], ['DE', 'w5', 'W']],
    lb: [['M', [1.2, 4.8]], ['W', [-2.2, 4.6]]],
    rush: ['DE', 'DT', 'NT', 'DE'], blitz: 'M',
  },
];

// Zones, with the left/right halves of the field written out. x: [from, to], y: [from, to], at: the spot he drops to.
export const ZONES = {
  deepL3: { name: 'deep third', side: 'left', deep: true, x: [-26.7, -8.9], y: [9, 60], at: [-15.5, 14] },
  deepM3: { name: 'deep middle third', side: '', deep: true, x: [-8.9, 8.9], y: [9, 60], at: [0, 15] },
  deepR3: { name: 'deep third', side: 'right', deep: true, x: [8.9, 26.7], y: [9, 60], at: [15.5, 14] },
  deepLH: { name: 'deep half', side: 'left', deep: true, x: [-26.7, 0], y: [9, 60], at: [-8, 15] },
  deepRH: { name: 'deep half', side: 'right', deep: true, x: [0, 26.7], y: [9, 60], at: [8, 15] },
  q1: { name: 'deep quarter', side: 'far left', deep: true, x: [-26.7, -12], y: [8, 60], at: [-16, 13] },
  q2: { name: 'deep quarter', side: 'inside left', deep: true, x: [-12, 0], y: [8, 60], at: [-6, 13] },
  q3: { name: 'deep quarter', side: 'inside right', deep: true, x: [0, 12], y: [8, 60], at: [6, 13] },
  q4: { name: 'deep quarter', side: 'far right', deep: true, x: [12, 26.7], y: [8, 60], at: [16, 13] },
  flatL: { name: 'flat', side: 'left', x: [-26.7, -11], y: [-1, 10], at: [-17, 5] },
  flatR: { name: 'flat', side: 'right', x: [11, 26.7], y: [-1, 10], at: [17, 5] },
  cfL: { name: 'curl-flat', side: 'left', x: [-26.7, -5], y: [0, 12], at: [-12, 8] },
  cfR: { name: 'curl-flat', side: 'right', x: [5, 26.7], y: [0, 12], at: [12, 8] },
  hookL: { name: 'hook-curl', side: 'left', x: [-12, -1.5], y: [2, 13], at: [-6.5, 9.5] },
  hookR: { name: 'hook-curl', side: 'right', x: [1.5, 12], y: [2, 13], at: [6.5, 9.5] },
  mid: { name: 'middle hook', side: '', x: [-6, 6], y: [3, 14], at: [0, 10] },
  rat: { name: 'short middle (the "rat")', side: '', x: [-6, 6], y: [1, 10], at: [0, 7] },
};

// Coverages. deep: zone per role (CBL/CBR are the corners on the left and right, SL/SR the safeties by side).
// under: the underneath zones, handed to whoever is nearest. blitzUnder: the same with one fewer man.
export const COVERAGES = [
  {
    id: 'c0', name: 'Cover 0', man: true, shell: 0, press: true,
    blurb: 'Man-to-man on every receiver with nobody deep. Everyone else blitzes. The ball has to come out fast, but one missed tackle can go the distance.',
  },
  {
    id: 'c1', name: 'Cover 1', man: true, shell: 1, press: true, deep: { FS: 'deepM3' }, extra: 'rat',
    blurb: 'Man-to-man with one free safety deep in the middle. The defender left over sits in the short middle (the "rat") to take away crossing routes.',
  },
  {
    id: 'c2', name: 'Cover 2', shell: 2, deep: { CBL: 'flatL', CBR: 'flatR', SL: 'deepLH', SR: 'deepRH' },
    under: ['hookL', 'mid', 'hookR'], blitzUnder: ['hookL', 'hookR'],
    blurb: 'Two safeties split the deep field in halves, the corners sit in the flats, three linebackers drop underneath. Soft spots: the deep middle between the safeties, and the sideline between the corner and the safety.',
  },
  {
    id: 'c3', name: 'Cover 3', shell: 1, deep: { CBL: 'deepL3', FS: 'deepM3', CBR: 'deepR3' },
    under: ['cfL', 'hookL', 'hookR', 'cfR'], blitzUnder: ['cfL', 'mid', 'cfR'],
    blurb: 'Three deep (the two corners and the free safety each take a third) and four underneath. Sound against the run with a safety down in the box; soft in the flats and the seams.',
  },
  {
    id: 'c4', name: 'Cover 4', shell: 2, deep: { CBL: 'q1', SL: 'q2', SR: 'q3', CBR: 'q4' },
    under: ['cfL', 'mid', 'cfR'], blitzUnder: ['cfL', 'cfR'],
    blurb: 'Quarters: four defenders deep, each with a quarter of the field, and three underneath. Takes away the deep ball and lets the safeties come up on runs; short throws are there.',
  },
];

export const PRESSURES = [
  { id: 'four', name: 'Rush four', blurb: 'Four rushers, seven in coverage.' },
  { id: 'blitz', name: 'Blitz', blurb: 'One more man rushes: five rushers, one fewer in coverage.' },
];

// Who blitzes, on a blitz (not in Cover 0, which sends everyone not covering a receiver): the Mike unless another is
// picked. A blitzer lined up outside the tackles comes off the edge. (See blitzerFor() in js/sim.js for when each can.)
export const BLITZERS = [
  { id: 'M', name: 'Mike', words: 'the Mike linebacker, from the middle' },
  { id: 'W', name: 'Will', words: 'the Will linebacker, from the weak side' },
  { id: 'NB', name: 'Nickel back', words: 'the nickel back, off the edge from over the slot' },
  { id: 'SS', name: 'Safety', words: 'the strong safety, down from the box' },
];

// Technique numbers, in order across the line from the center out (the playbook lists them this way).
export const TECHNIQUES = [
  ['0-technique', 'Head-up on the center.'],
  ['1-technique', 'On the center\'s shoulder, in the A gap.'],
  ['2-technique', 'Head-up on a guard.'],
  ['3-technique', 'On the guard\'s outside shoulder, in the B gap.'],
  ['4-technique', 'Head-up on a tackle.'],
  ['5-technique', 'On the tackle\'s outside shoulder, in the C gap.'],
  ['Wide 5-technique', 'Outside the tackle, wider than a 5.'],
  ['7-technique', 'On the tight end\'s inside shoulder. It sits inside the 6 because the usual numbering keeps odd numbers for lining up on a man\'s shoulder and even numbers for head-up.'],
  ['6-technique', 'Head-up on the tight end.'],
  ['9-technique', 'Outside the tight end.'],
  ['2i and 4i', 'On the inside shoulder of a guard (2i) or a tackle (4i).'],
];

// What each position is. Defense labels are the shorthand coaches draw on the board.
export const POSITIONS = {
  QB: ['Quarterback', 'Takes the snap and runs the offense: hands off, throws, or keeps it himself. Reads the defense before and after the snap.'],
  RB: ['Running back', 'The main ball carrier. Also picks up blitzers and catches passes out of the backfield.'],
  RBwide: ['Running back, split out', 'With nobody left in the backfield (Empty), the back lines up in the slot as a fifth receiver and runs a receiver\'s routes.'],
  FB: ['Fullback', 'A blocking back who lines up in front of the tailback and leads him through the hole.'],
  X: ['Split end (X)', 'A wide receiver on the line of scrimmage, usually on the side away from the tight end. Being on the line, he can be jammed right at the snap.'],
  Z: ['Flanker (Z)', 'A wide receiver who lines up a step off the line, usually on the tight end\'s side. Being off the line, he is allowed to go in motion.'],
  H: ['Slot receiver (H)', 'Lines up between the wide receiver and the line, a step off it. Runs quick routes and crossing routes in the middle.'],
  Y: ['Tight end (Y)', 'Lines up at the end of the line or just outside it. Blocks like a lineman and catches like a receiver.'],
  Yslot: ['Slot receiver (Y)', 'In a four-receiver set the Y is a second slot receiver; in sets with a tight end, Y is usually the tight end.'],
  U: ['Second tight end (U)', 'The second tight end, on the other end of the line. Blocks on runs, leaks out on passes.'],
  LT: ['Left tackle', 'Protects the quarterback\'s blind side (for a right-handed passer). Often the best pass blocker on the line.'],
  LG: ['Left guard', 'Lines up beside the center. Guards pull on some runs: they leave their spot and lead through a hole on the other side.'],
  C: ['Center', 'Snaps the ball and usually makes the line\'s blocking calls.'],
  RG: ['Right guard', 'Lines up beside the center. Guards pull on some runs: they leave their spot and lead through a hole on the other side.'],
  RT: ['Right tackle', 'Blocks the edge on the right side, often against the defensive end on the tight end\'s side.'],
  DE: ['Defensive end', 'Lines up at the end of the defensive line. Rushes the passer from the edge, and keeps runs from getting outside him ("sets the edge").'],
  DT: ['Defensive tackle', 'Lines up inside, over a guard. As a 3-technique he shoots the gap and gets into the backfield.'],
  NT: ['Nose tackle', 'Lines up on or right next to the center. Takes on double teams so the linebackers behind him can run free.'],
  S: ['Sam linebacker', 'The strong-side linebacker: lines up on the tight end\'s side and takes on the tight end, against runs and in coverage.'],
  M: ['Mike linebacker', 'The middle linebacker, usually the one who calls the defense. Fills the inside gaps against the run.'],
  W: ['Will linebacker', 'The weak-side linebacker, away from the tight end. Often the fastest linebacker; chases plays from sideline to sideline.'],
  J: ['Jack linebacker', 'The weak-side outside linebacker in a 3-4. Stands up on the edge and usually rushes the passer.'],
  S34: ['Sam linebacker', 'In a 3-4, the strong-side outside linebacker: stands up on the edge outside the tight end, sets the edge on runs and drops into coverage on passes.'],
  CB: ['Cornerback', 'Covers the wide receivers, man-to-man or in a zone, deep or short depending on the call.'],
  NB: ['Nickel back', 'A fifth defensive back who comes on for a linebacker to cover a slot receiver.'],
  FS: ['Free safety', 'Usually the deepest defender, the last line. When he\'s the only safety deep (Cover 1 and Cover 3) he guards the deep middle.'],
  SS: ['Strong safety', 'Lines up on the strong side, closer to the line. Helps against the run and covers tight ends and slots.'],
};

export const PERSONNEL = 'Personnel is two digits: how many running backs, then how many tight ends. The rest of the five eligible receivers are wide receivers. 21 is two backs and one tight end; 10 is one back, no tight end, four receivers.';

// Down and distance: the situations the board can be set to, in the Situation row above your call. The yellow line on
// the board is the line to gain, togo yards up the field. A play is a success when it gains 40% of the yards to go on
// first down, 60% on second, and all of them on third and fourth: Pro-Football-Reference's definition (Sports Reference
// blog, "Success Rate Comes to Pro Football Reference!", Jonah Gardner, 1 September 2023). On 1st & 10 that's the
// 4 yards the board counted before it had downs. On fourth down, a play short of the line hands the ball to the other
// team: a turnover on downs.
// nfl: what NFL teams did in that situation in the 2023 regular season, in percent, counted from nflverse's 2023
// play-by-play and participation files (kneel-downs, spikes and two-point tries left out): how often the offense
// dropped back to pass (a scramble counts as a pass); how often the defense had five or more defensive backs on the
// field (nickel, or six of them); and against a dropback, how often it rushed five or more, and how often it played each
// of the five coverages on this board (the rest were others: Cover 6, two-man and the like). The other coach's calls
// lean the way these move from 1st & 10 (see rollTheirs() in js/app.js); the blurbs say what they show.
export const SITUATIONS = [
  {
    id: '1and10', down: 1, togo: 10, name: '1st & 10',
    nfl: { pass: 52, nickel: 71, blitz: 25, cover: { c0: 1, c1: 29, c2: 16, c3: 24, c4: 12 } },
    blurb: 'Ten yards to go for a first down, and four downs to get there. A gain of 4 yards, 40% of the 10, is a success: it leaves a manageable second down. NFL offenses passed on about half of these snaps in 2023.',
  },
  {
    id: '2and6', down: 2, togo: 6, name: '2nd & 6',
    nfl: { pass: 58, nickel: 77, blitz: 27, cover: { c0: 3, c1: 33, c2: 14, c3: 22, c4: 10 } },
    blurb: 'Six to go. On second down a success is 60% of it, and in whole yards that\'s 4 again: it leaves a short third down. NFL offenses passed on about three snaps in five here.',
  },
  {
    id: '3and2', down: 3, togo: 2, name: '3rd & 2',
    nfl: { pass: 62, nickel: 85, blitz: 25, cover: { c0: 6, c1: 49, c2: 14, c3: 15, c4: 6 } },
    blurb: 'Third down: only the first down is a success, here 2 yards. NFL offenses still passed on about three snaps in five, and defenses played more man coverage: Cover 1 on about half the throws.',
  },
  {
    id: '3and8', down: 3, togo: 8, name: '3rd & 8',
    nfl: { pass: 96, nickel: 98, blitz: 39, cover: { c0: 4, c1: 41, c2: 13, c3: 12, c4: 10 } },
    blurb: 'Third and long: only the first down, all 8 yards, is a success, and a 6-yard gain is a failure. NFL offenses passed on 96 snaps in 100, so defenses had five or six defensive backs out, blitzed more and played more Cover 1.',
  },
  {
    id: '4and1', down: 4, togo: 1, name: '4th & 1',
    nfl: { pass: 31, nickel: 60, blitz: 59, cover: { c0: 18, c1: 48, c2: 11, c3: 8, c4: 3 } },
    blurb: 'Fourth down: a yard for a first down, or the other team gets the ball where the play ends, a turnover on downs. NFL offenses ran on about two snaps in three; defenses played man coverage and blitzed on most throws.',
  },
];
// The yards a play has to gain to be a success in a situation: 40%, 60% or all of the yards to go, in the whole yards
// the board counts (60% of 6 is 3.6, so 4).
export const NEED = [0.4, 0.6, 1, 1];
export const needed = s => Math.ceil(NEED[s.down - 1] * s.togo - 1e-9);

// Drills: five snaps against one call from the other coach, and then a line from the coach's notes on what beats it.
// On offense his defense is the drill's (with his front set to your personnel: nickel against three or four receivers,
// the 4-3 Over against two backs or two tight ends); on defense he runs from the drill's formation, a different run
// each snap. A snap counts as a success by its down, as everywhere on the board (see SITUATIONS): on 1st & 10, a gain
// of 4 yards or more. Each note says what the board shows over many snaps on 1st & 10 (and 2nd & 6, where a success is 4
// yards too); long says it for 3rd & 8, and short for a short third or fourth down, 3rd & 2 and 4th & 1, where a success
// is the first down (test/sim.test.mjs holds them all to it).
export const DRILLS = [
  {
    id: 'c2', name: 'Beat Cover 2', side: 'O', coverage: 'c2', pressure: 'four',
    brief: 'They play Cover 2 and rush four, every snap.',
    note: 'Four Verticals gains the most yards a play against Cover 2 here, throwing into its deep holes; then Smash, the classic Cover 2 beater, which goes after the one behind the corner in the flat, and the Play-Action Shot. For a sure 4 yards, Slant-Flat gets there most often, about four times in five, with quick throws in front of the corner sitting in the flat or beside him; Stick and the Draw come next, about three times in four.',
    long: 'On 3rd & 8 the surest 4 yards don\'t all get there: Stick makes the first down only about one time in ten. Four Verticals, Slant-Flat, Smash, the Play-Action Shot, Mesh and Flood make it about two times in five to half the time each, with throws into the holes past the line to gain or a catch on the run.',
    short: 'On 3rd & 2, Slant-Flat, Stick, the Draw and the zone runs make it most often, three or four times in five, with Flood close behind. On 4th & 1, a single yard, the runs come first: Inside Zone, the Draw, Outside Zone and Counter make it most often, about four times in five or better.',
  },
  {
    id: 'c3', name: 'Beat Cover 3', side: 'O', coverage: 'c3', pressure: 'four',
    brief: 'They play Cover 3 and rush four, every snap.',
    note: 'Four Verticals, Flood and the Play-Action Shot gain the most yards a play against Cover 3 here, about as many as each other: four receivers going deep against three deep defenders; Flood, the classic Cover 3 beater, putting three receivers on the two zone defenders on one side; and the Play-Action Shot\'s deep crosser, running in behind linebackers who stepped up for the fake. For a sure 4 yards, Slant-Flat gets there most often, about four times in five: the defender between the slant and the flat can\'t take both. Next, about seven times in ten, come Stick, the Draw and Smash.',
    long: 'On 3rd & 8 Flood makes the first down most often, about three times in five: the sail settles at 12 to 14 yards, past the line to gain. Next, about two times in five to half the time, come the Play-Action Shot, its deep crosser running in behind the linebackers, Smash, the Draw and Stick. Four Verticals makes it about one time in three, and so does Slant-Flat, a sure 4 yards on first down.',
    short: 'On 3rd & 2, Slant-Flat, Stick, the Draw and Smash make it most often, about three times in four. On 4th & 1 the Draw and Inside Zone make it most often, more than four times in five, with Slant-Flat and Stick close behind and the RB Screen about three times in four.',
  },
  {
    id: 'blitz', name: 'Beat the blitz', side: 'O', coverage: 'c0', pressure: 'blitz',
    brief: 'They blitz, every snap. Count who\'s coming and who\'s left to cover.',
    note: 'Against an all-out blitz, Stick, Flood and the RB Screen succeed most often here, about two times in three. The quarterback waits until the rusher nobody blocks is nearly on him, then throws hot to a man with a step on his defender: the stick turning in at 5 yards, or one of Flood\'s three receivers on a side. The screen lets the rushers run past the back. Mesh and Slant-Flat come next, about half the time or a little more. Every run goes straight into it, about one time in four.',
    long: 'On 3rd & 8 against an all-out blitz, Flood makes the first down most often, about half the time: three one-on-ones on one side, with nobody over the top. Next, about two times in five, come the Play-Action Shot, Four Verticals, Smash and Mesh. Stick, the surest 4 yards against it, makes 8 about one time in three, and the RB Screen about one time in four.',
    short: 'On a short third or fourth down Stick and the RB Screen make it most often, about four times in five, and on 4th & 1 the zone runs as often: with everyone rushing and nobody deep, a back who gets past the rush has room. On 3rd & 2 Flood, Mesh and Outside Zone make it about seven times in ten. The Draw runs into the rush: it makes it about one time in five on 3rd & 2 and one in three on 4th & 1.',
  },
  {
    id: 'run', name: 'Stop the run against I-Form', side: 'D', formation: 'iform',
    brief: 'They run from I-Form, every snap: any of the five runs, to either side.',
    note: 'Against two backs and a tight end, put more defenders in the box than they have blockers: the 4-3 Over with Cover 1 and a blitz has eight against seven, and stops about six runs in ten here. The 4-3 Over in Cover 0 stops more, about three in four, but with nobody deep, the runs that get through go a long way.',
    long: 'On 3rd & 8 a run has to go all 8 yards, and against I-Form most calls hold it short about four times in five: the 4-3 Over with Cover 1 and a blitz about nine in ten. Cover 3 rushing four lets the most through, about one in three.',
    short: 'On a short third or fourth down a run needs only a yard or two, and against I-Form it usually gets it: about one run in three is held short on 3rd & 2, one in five on 4th & 1. Cover 0\'s all-out blitz holds about half short on 3rd & 2 and, from the 4-3, about one in three on 4th & 1, as many as any call here. With two safeties deep and four rushing, the 4-3 Over hardly ever stops it on 4th & 1, about one time in 15.',
  },
];

// Coach's notes on how a pass concept tends to fare against each coverage. Short and plain.
export const NOTES = {
  verts: {
    c0: 'No safety deep against four vertical routes: every one is a footrace with nobody over the top. But Cover 0 sends a rusher the line can\'t block, so the ball has to come out before he gets there, often hot.',
    c1: 'One free safety can\'t help on all four. The go routes outside are one-on-ones with the corners in man coverage, and the check-down is there when they\'re covered.',
    c2: 'Each half-field safety has two receivers running at him: the seam inside him and the go route outside, past the corner sitting in the flat. He can\'t stay over both.',
    c3: 'Four vertical routes on three deep defenders should leave a seam open, but the hook defenders carry the seams up the field and the free safety stays over the top of them. The throw has to beat both, and the check-down is often the answer.',
    c4: 'Quarters puts four defenders deep, one for each vertical route. The deep shots are taken away; the check-down underneath is there.',
  },
  smash: {
    c0: 'Against man with no help, the corner route is a footrace to the sideline, and that\'s where the ball goes most often. But Cover 0 sends a rusher the line can\'t block: when he\'s nearly there before the corner route comes open, the ball comes out hot, to whoever is nearest the spot he left.',
    c1: 'Man coverage turns Smash into one-on-ones. The corner route, breaking away from the man chasing it toward the sideline, is the one that comes open: the free safety in the middle is a long way from it.',
    c2: 'The Cover 2 corner sits in the flat, so he can\'t carry the corner route, and the half-field safety is a long way from the sideline. Built to beat exactly this.',
    c3: 'The Cover 3 corner bails deep and takes away the corner route, but that leaves the hitch open underneath him.',
    c4: 'Quarters is built to stop this: four defenders deep, so the corner route has a corner and a safety over it. What\'s left is the hitch underneath, open but short.',
  },
  flood: {
    c0: 'Against man, Flood is three one-on-ones on one side. Cover 0 sends a rusher the line can\'t block, and once he\'s nearly there the ball comes out hot, to whichever man has a step on his: the back in the flat, or a deep route with nobody over the top.',
    c1: 'The free safety can\'t help on routes breaking toward the sideline, and the back\'s flat route is a one-on-one in space against a linebacker: the easy throw.',
    c2: 'The Cover 2 corner is caught between the sail and the flat route under it. When he sinks under the sail, with the safety over the top of it, the back in the flat is open; when he stays in the flat, the sail is open in front of the safety. The ball goes to each about as often.',
    c3: 'Three receivers on one side against two zone defenders there (the corner deep and the curl-flat defender short). Someone is left uncovered. Built to beat exactly this.',
    c4: 'Quarters puts four deep, and the corner and safety on that side stay deep: the sail settles in front of them at 12 to 14 yards, and the flat is open underneath it too.',
  },
  mesh: {
    c0: 'The two crossers brush past each other, and man defenders trailing them run into the traffic. With no help in the middle, a clean catch can go a long way.',
    c1: 'The crossers pick the man defenders off each other, and a crosser who gets past the "rat" in the short middle is running away from the man chasing him.',
    c2: 'The three underneath defenders sit on the crossers, but the corner route over the corner in the flat is open: the same hole Smash goes after.',
    c3: 'The corner route runs into the deep third the Cover 3 corner is guarding, so the ball goes underneath most of the time, to the crossers and the back\'s swing, for short gains.',
    c4: 'Four deep defenders take away the corner route. The crossers and the back\'s swing underneath are open, but the deep defenders come down on them before they get far.',
  },
  slants: {
    c0: 'Quick throws are the answer to an all-out blitz: the ball is out before the rush gets there. A slant beating a press corner has nobody behind him.',
    c1: 'Slants against outside-leverage corners are open inside. The rat in the middle is the danger.',
    c2: 'The Cover 2 corner sits in the flat, right where the flat route goes, and the linebackers sit over the slant. Both are short throws: the slant inside the corner is thrown more often and goes farther, and the flat is open in front of him, with the corner right there to tackle.',
    c3: 'The curl-flat defender has to choose: widen for the flat and the slant comes open behind him, or squeeze the slant and the flat is free.',
    c4: 'Quarters corners play off and deep, so there\'s room underneath for both quick routes.',
  },
  pa: {
    c0: 'With no deep safety, play-action is all-or-nothing: the deep routes are one-on-ones, but the blitz arrives before the fake is over. From I-Form, with both backs blocking and only three out, the quarterback looks to the tight end in the flat first, at once.',
    c1: 'The free safety has to pick the post or the deep crosser. The fake pulls the underneath defenders up, and the crosser runs behind them. From I-Form, with both backs blocking and only three out, a blitz brings seven against seven blockers, and the quarterback looks to the tight end in the flat first, at once.',
    c2: 'Two deep safeties sit over the top of the post, but the linebackers bite on the fake and the crosser gets the space they left.',
    c3: 'The lone middle safety can\'t take both the post and the deep crosser, and the linebackers who stepped up for the fake are out of the throwing lane.',
    c4: 'Quarters safeties read the run fake and come up, which is exactly when the post goes behind them, or they stay home and the crosser is underneath.',
  },
  stick: {
    c0: 'Against an all-out blitz the ball comes out hot, before the rusher nobody blocks gets there: most often to the stick, turning in at five yards with his man a step behind him, or to the back in the flat, who has his man waiting for him there and is tackled short more often. With nobody deep, a catch can go a long way.',
    c1: 'In man coverage the stick turns in at five yards and sits down, with the man chasing him still behind him: an easy completion most of the time, though a short one, with the free safety deep.',
    c2: 'The Cover 2 corner sits in the flat, so a receiver running to it is covered. The ball goes most often to the stick, settling in front of the linebackers and behind the corner, and otherwise to the back coming out of the backfield to the flat, who gains more.',
    c3: 'The curl-flat defender has to choose: when he sits on the stick, the flat route outside him is open, and that\'s where the ball goes most of the time; when he goes with the flat, the quarterback comes back to the stick, open where he was. Cover 3\'s corners bail deep, so there\'s room underneath, for short gains.',
    c4: 'Quarters keeps four deep and three underneath, so the stick and the flat are both open, but short: the safeties come down fast once the ball is caught.',
  },
  screen: {
    c0: 'The screen\'s best look: every rusher in an all-out blitz runs past the back, and there\'s nobody left to tackle him but the corners, who are running with their receivers.',
    c1: 'Man defenders are turned and running with their receivers. The man on the back is the one who has to beat three linemen.',
    c2: 'The underneath zone defenders are facing the quarterback and see it coming. It works only if the linemen get to them first.',
    c3: 'The curl-flat defender is often right where the screen goes. Screens against Cover 3 need the linemen to block him quickly.',
    c4: 'Three underneath defenders, two of them out wide, so the middle is thin; but the quarters safeties come down fast once the back has the ball.',
  },
};
