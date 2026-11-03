# Splat Viewer

A browser viewer for Gaussian splat scans (.ply, .spz, .splat, .ksplat, .sog) with orbit, fly and walk modes.
In walk mode a little third-person character walks around on the scan, with gravity, jumping and stairs.
Rendering is done by [Spark](https://sparkjs.dev) on top of [three.js](https://threejs.org); everything else is ours.

## Run it

Double-click `start.bat` (needs Python), then drag a scan onto the page.
Or from a terminal in this folder: `python -m http.server 8123` and open http://localhost:8123.

A scan placed in a `scans/` folder here can also be opened by URL: `http://localhost:8123/?url=scans/myscan.ply`
(`scans/` and splat files are git-ignored).

## How walking works

Splats aren't solid, so when you first enter walk mode the scan is turned into an invisible grid of
5 cm blocks (`voxel-grid.js`). A block is solid when an opaque-enough, small-enough splat sits in it;
single-block pinholes are filled, and the floor height is detected and made fully solid because scanned
floors are usually patchy. The character (`walk-controls.js`) collides with those blocks Minecraft-style.

Press **C** to see the blocks. If the character falls through things or bumps into thin air, tweak the
**Collision** settings in the panel and press **Rebuild collision**. Gravity follows the model's
orientation, so fix a tilted scan with the rotate buttons first. Sizes are in scan units, which are
meters for most phone scans; for other scans, set **Player height** to match.

## Files

- `index.html` – page layout, HUD, help panel, library versions (import map)
- `main.js` – scene, loading, modes, orientation, collision setup, settings panel, shortcuts, render loop
- `fly-controls.js` – the fly camera (WASD/QE, mouse look, smoothing, scroll speed)
- `walk-controls.js` – the walking character: physics, step-up, third-person camera, avatar
- `voxel-grid.js` – builds the collision blocks from the splats and answers collision queries

## Controls

| Key | Action |
| --- | --- |
| F | Switch mode: orbit → fly → walk |
| Click | Fly / walk: capture mouse to look (Esc releases) |
| W A S D | Move forward / left / back / right |
| E / Q | Fly up / down |
| Space | Walk: jump |
| Shift / Alt | Fly: boost / slow down · Walk: run |
| Scroll | Orbit: zoom · Fly: speed · Walk: camera distance (all the way in = first person) |
| V | Walk: first / third person |
| T | Walk: back to last solid ground |
| C | Show collision blocks |
| R | Recenter view |
| 1 / 2 / 3 | Rotate model 90° about X / Y / Z (remembered per file) |
| U | Flip upside down |
| H | Hide help |
| O | Open another file |
