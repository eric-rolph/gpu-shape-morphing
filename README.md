# GPU Font Engine (Real-Time Vector Morphing)

> A blazing fast, zero-dependency WebGL 2.0 demonstration of rendering and morphing complex vector shapes purely with mathematics in the fragment shader.

![Demo](demo.png)

## Why This Exists

Traditional font rendering parses bezier curves on the CPU, triangulates them, and pushes vertices to the GPU. Or it relies on precomputed Signed Distance Field (SDF) texture atlases which lose infinite zoom clarity or take up valuable memory. 

Inspired by Eric Lengyel's brilliant **Slug** rendering algorithm, this project evaluates the mathematical equations of quadratic Bezier curves **natively in the fragment shader**. It mathematically determines the pixel boundary coverage using the standard `fwidth` derivative technique, meaning no textures, no triangulation preprocessing, and flawless visual fidelity at any scale.

## Features

- 🏎️ **Textureless Rendering:** Mathematically exact curve distance roots (no SDF atlases).
- 🧮 **Exact Vector AA:** Perfect anti-aliasing handled via analytic derivatives.
- 🧬 **Dynamic Structure Morphing:** Modulate Bezier anchor points dynamically at 60 FPS in pure JavaScript without triggering any expensive tessellation overhead.
- 🌬️ **Algorithmic Weight:** Inflate or deflate shapes simply by dynamically offsetting normals at runtime.

## Quick Start

You don't need `npm`, `yarn`, or a heavy build pipeline. It's a single raw HTML/JS/WebGL native application.

1. Clone the repository.
2. Serve the directory with any local HTTP server:
   ```bash
   python -m http.server 10101
   # or
   npx http-server -p 10101
   ```
3. Open `http://localhost:10101` in your browser.

## Architecture

This project strictly follows the principle of providing geometry to the GPU in the rawest mathematical form:

### 1. The Geometry
A stylized letter "A" is constructed in `main.js` out of exactly 10 contiguous Quadratic Bezier Curves. 
The JavaScript loop reads UI sliders and runs mathematical shifts (Tension drops peaks, Weight expands normal radii, Slant applies shear matrices), and uploads this raw array to the GPU on every `requestAnimationFrame` tick.

### 2. The Fragment Engine
The WebGL fragment shader performs two critical mathematical functions simultaneously for every pixel:
1. **Ray Intersection Winding:** It casts an implicit ray across the Bezier formulas to determine if the pixel is functionally *Inside* or *Outside* the vector path using the Even/Odd topological rule.
2. **Shortest Unsigned Distance:** Using algebraic cubic root finding, it computes the exact mathematical distance to the closest Bezier limit for anti-aliasing bounds.

The values are mapped to `smoothstep(fwidth(signed), -fwidth(signed), signed)` to return perfectly anti-aliased sub-pixel pixel coverage geometry.

## Contributing

This is a proof-of-concept for real-time typeface manipulation geometry. If you want to replace the `basePoints` with a complete font interpreter or a TrueType-to-quadratic parser, pull requests are warmly welcomed!

## License

MIT © 2026 
