# Chalk Talk

**Use it: [chalk-talk.junkdrawer.works](https://chalk-talk.junkdrawer.works/)**

**A football coach's board you can run.** Call the offense or the defense, snap it, and watch every route, block, rush and coverage play out in Xs and Os. Afterwards it tells you what happened and why: who came free, which defender was left with two receivers to cover, or how many blockers there were for the defenders in the box. Tap any player to learn his position and his job on that play.

<p align="center">
  <img src="docs/phone-call.png" alt="The board before the snap: Gun Trips against a nickel defense, with the routes for Smash drawn in white chalk and the defense's alignment in yellow Xs" width="250">
  &nbsp;
  <img src="docs/phone-play.png" alt="The same play two seconds after the snap: chalk trails show where everyone went, the zone drops are shaded, and a caption reads 'The quarterback throws to the H on a corner route, his first read.', with the H ringed" width="250">
  &nbsp;
  <img src="docs/phone-result.png" alt="The result card: 'A win for the offense. Gain of 19 yards', the play-by-play, and a coach's note explaining why Smash beats Cover 2" width="250">
</p>

## How it works

- **Pick a side.** Call the offense (formation, strong side, play) or the defense (front, coverage, pressure). The other coach picks his call at random, the way a real one might: nickel against three receivers, base against two backs. Or turn that off and call both sides to study one matchup.
- **Read it before the snap.** The other side's call stays hidden until the snap, but its alignment doesn't: count the safeties deep, see how far off the corners are and count the defenders in the box, the way a quarterback does. Don't like the look? Change your play and he keeps his call, the way an audible works; change your personnel and he substitutes. New look gets you another one.
- **Snap it.** Every player has a job and does it: receivers run their routes, linemen block whoever they're assigned, rushers try to beat their blockers, man defenders chase their receivers a moment late, zone defenders guard their areas, and the quarterback goes through his reads and throws where nobody can get there first. The same call can come out differently each time.
- **Watch it back.** Scrub through the play, slow it to half speed, and see the drawn-up play faintly under the trails of where everyone actually went.
- **Find out why.** A play-by-play, a coach's note on how the call does against what the other side called, and the pre-snap read: the safeties, the corners, the box count, and how many rushers came against how many blockers.
- **Run it a hundred times.** "Run it 20 times each" plays your call against every coverage (or your defense against every play) and charts the average yards and success rate.
- **Learn the words.** Tap any player for his position and his job on the play. The playbook below the board covers positions, personnel, formations, technique numbers and gaps, coverages, plays and routes, and the other words coaches use: the strong side, the box, the zones.
- **Share a play.** "Copy link to this play" makes a link that replays exactly the same snap for whoever opens it.
- No account and no server. Your last calls stay in your browser. It works offline and installs to a phone's home screen.

The simulator is a coaching model, not physics. Blocks are pairs that push each other until one wins, coverage is defenders following receivers or guarding spots, and tackling is a dice roll weighted by angle and who's involved. Over many snaps it comes out near real football: about four yards a carry, around 60% of passes complete, sacks on about one dropback in thirty. The classic matchups mostly work the way coaches draw them up: four verticals hurt Cover 2 and Cover 3 and stall against Cover 4's extra deep defender, crossing routes get open against man coverage, and a safety down in the box slows the run.

## Running it

It's a static site: plain HTML, CSS and JavaScript, with no build step.

```sh
npx serve .                   # or any static file server, then open the printed address
npm test                      # unit tests for the simulator, then the page in Chromium (needs Playwright)
node tools/screenshots.mjs    # redraws docs/*.png and og.png
node tools/make-icons.mjs     # redraws the PNG icons from icon.svg
npm run build                 # dist/chalk-talk.html, the whole app in one file (needs esbuild: npm install)
```

To put it online with GitHub Pages: **Settings → Pages → Build and deployment → Deploy from a branch**, then pick `main` and `/ (root)`. The `CNAME` file serves it at chalk-talk.junkdrawer.works.

### Files

- `js/playbook.js`: the playbook as data: formations, routes, plays, fronts, coverages and zones, what each position does, and the coach's notes.
- `js/sim.js`: the simulator. `prepare()` lines both teams up and hands out every assignment (routes, blocking, protection, rush lanes, man matchups and zone drops); `simulate()` runs the snap at twenty steps a second and records every position, the events, and the result.
- `js/board.js`: draws the field, the players as Xs and Os, the drawn-up assignments and the trails, in chalk (dark) or marker (light).
- `js/app.js`: the page: the choosers, playback, the result and coach's note, the chart, the playbook, share links.
- `js/rng.js`: a seeded random source, so a snap replays exactly from its seed.
- `fonts/`: Barlow, Barlow Condensed, Permanent Marker and Patrick Hand (SIL Open Font License), served from here so nothing loads from elsewhere.
- `sw.js`: keeps a copy for using offline, and opens from it when the connection isn't answering. `FILES` in it is a fingerprint of the files it keeps: change one and `npm test` says what to set it to, so a release never leaves the copy half old.
- `test/sim.test.mjs`: every call against every defense runs to a finish, formations are legal, coverages count right, and the numbers look like football. `test/e2e.mjs`: uses the real page in Chromium.
- `scripts/build.mjs`: bundles everything into one HTML file.
