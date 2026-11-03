# Splat Viewer

A browser viewer for Gaussian splat scans (.ply, .spz, .splat, .ksplat, .sog) with orbit and fly controls.
Rendering is done by [Spark](https://sparkjs.dev) on top of [three.js](https://threejs.org); everything else is ours.

## Run it

Double-click `start.bat` (needs Python), then drag a scan onto the page.
Or from a terminal in this folder: `python -m http.server 8123` and open http://localhost:8123.

A scan placed inside this folder can also be opened by URL: `http://localhost:8123/?url=scans/myscan.ply`.

## Files

- `index.html` – page layout, HUD, help panel, library versions (import map)
- `main.js` – scene, loading, orientation, settings panel, keyboard shortcuts, render loop
- `fly-controls.js` – the custom fly camera (WASD/QE, mouse look, smoothing, scroll speed)

## Controls

| Key | Action |
| --- | --- |
| F | Toggle orbit / fly mode |
| Click | Fly mode: capture mouse to look (Esc releases) |
| W A S D | Fly forward / left / back / right |
| E / Q | Fly up / down |
| Shift / Alt | Boost / slow down |
| Scroll | Fly: change speed · Orbit: zoom |
| R | Recenter view |
| 1 / 2 / 3 | Rotate model 90° about X / Y / Z (remembered per file) |
| U | Flip upside down |
| H | Hide help |
| O | Open another file |
