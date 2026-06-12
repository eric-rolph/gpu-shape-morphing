// WebGL 2.0 Shader sources
const vertexShaderSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
    // Map from WebGL clip space to a logical 0-1 UV space
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;

// Curve data texture: texel (i, 0) = [p0.xy, p1.xy], texel (i, 1) = [p2.xy, kinkFlag, unused]
// A texture sidesteps fragment uniform limits (the old vec2[350] arrays needed ~1400
// vec4 slots — over the 1024 cap on many mobile/Apple GPUs) and scales to 1024+ curves.
uniform highp sampler2D u_curves;
uniform int u_num_curves;

uniform vec2 u_resolution;
uniform float u_time;
uniform int u_render_mode;
uniform bool u_show_flaws;

uniform vec2 u_offset;
uniform float u_zoom;

in vec2 v_uv;
out vec4 fragColor;

// Exact mathematical distance to a quadratic Bezier curve
// Adapted math by Inigo Quilez, evaluating the derivative of the distance squared 
// function to find the closest algebraic roots. This method eliminates the need
// for coarse bounding geometries or texture atlases.
float sdBezier(vec2 pos, vec2 A, vec2 B, vec2 C) {    
    vec2 a = B - A;
    vec2 b = A - 2.0*B + C;
    vec2 c = a * 2.0;
    vec2 d = A - pos;

    float kk = 1.0 / dot(b,b);
    float kx = kk * dot(a,b);
    float ky = kk * (2.0*dot(a,a)+dot(d,b)) / 3.0;
    float kz = kk * dot(d,a);      

    float res = 0.0;
    float p = ky - kx*kx;
    float p3 = p*p*p;
    float q = kx*(2.0*kx*kx - 3.0*ky) + kz;
    float h = q*q + 4.0*p3;

    if(h >= 0.0) { 
        h = sqrt(h);
        vec2 x = (vec2(h, -h) - q) / 2.0;
        // Real cube root using sign to preserve negativity
        vec2 uv = sign(x) * pow(abs(x), vec2(1.0/3.0));
        float t = uv.x + uv.y - kx;
        t = clamp(t, 0.0, 1.0);
        
        vec2 qos = d + (c + b*t)*t;
        res = dot(qos, qos);
    } else {
        float z = sqrt(-p);
        float v = acos( q/(p*z*2.0) ) / 3.0;
        float m = cos(v);
        float n = sin(v)*1.732050808; // sqrt(3)
        vec3 t = vec3(m + m, -n - m, n - m) * z - kx;
        t = clamp(t, 0.0, 1.0);
        
        vec2 qos = d + (c + b*t.x)*t.x;
        res = dot(qos,qos);
        
        qos = d + (c + b*t.y)*t.y;
        res = min(res, dot(qos,qos));
        // The third root is typically not the minimum for Bezier, but just to be safe:
        qos = d + (c + b*t.z)*t.z;
        res = min(res, dot(qos,qos));
    }
    return sqrt(res);
}

// Ray-casting Winding Number evaluation
// Shoots a horizontal ray strictly to the right (+x) from 'p'
int calcWinding(vec2 p, vec2 P0, vec2 P1, vec2 P2) {
    float A = P0.y - 2.0*P1.y + P2.y;
    float B = 2.0*(P1.y - P0.y);
    float C = P0.y - p.y;
    
    int winding = 0;
    
    // Near-linear case (when control point is flat)
    if (abs(A) < 1e-6) {
        if (abs(B) > 1e-6) {
            float t = -C / B;
            // Use [0, 1) to avoid triggering the same point twice on connecting curves
            if (t >= 0.0 && t < 1.0) {
                float x_int = (1.0-t)*(1.0-t)*P0.x + 2.0*t*(1.0-t)*P1.x + t*t*P2.x;
                if (x_int > p.x) {
                    float dy = P2.y - P0.y;
                    if (dy > 0.0) winding += 1;
                    else if (dy < 0.0) winding -= 1;
                }
            }
        }
        return winding;
    }

    // Solve the quadratic equation for ray intersection
    float disc = B*B - 4.0*A*C;
    if (disc >= 0.0) {
        float sqrt_disc = sqrt(disc);
        float t1 = (-B - sqrt_disc) / (2.0*A);
        float t2 = (-B + sqrt_disc) / (2.0*A);
        
        if (t1 >= 0.0 && t1 < 1.0) {
            float x_int = (1.0-t1)*(1.0-t1)*P0.x + 2.0*t1*(1.0-t1)*P1.x + t1*t1*P2.x;
            if (x_int > p.x) {
                // Exact derivative at intersection
                float dy = 2.0*(1.0-t1)*(P1.y - P0.y) + 2.0*t1*(P2.y - P1.y);
                if (dy > 0.0) winding += 1;
                else if (dy < 0.0) winding -= 1;
            }
        }
        if (t2 >= 0.0 && t2 < 1.0) {
            float x_int = (1.0-t2)*(1.0-t2)*P0.x + 2.0*t2*(1.0-t2)*P1.x + t2*t2*P2.x;
            if (x_int > p.x) {
                float dy = 2.0*(1.0-t2)*(P1.y - P0.y) + 2.0*t2*(P2.y - P1.y);
                if (dy > 0.0) winding += 1;
                else if (dy < 0.0) winding -= 1;
            }
        }
    }
    return winding;
}

void main() {
    // Center at 0, map to approx [-1.2, 1.2] based on aspect ratio
    vec2 uv = (v_uv - 0.5) * 2.5; 
    uv.x *= u_resolution.x / u_resolution.y;
    
    // Apply User Agent Pan and Zoom
    uv = (uv - u_offset) / u_zoom;

    float min_dist = 1000.0;
    int winding = 0;
    float flaw_intensity = 0.0;

    // Loop through all geometric Bezier curves evaluating exact distance and winding
    for(int i = 0; i < u_num_curves; ++i) {
        vec4 c0 = texelFetch(u_curves, ivec2(i, 0), 0);
        vec4 c1 = texelFetch(u_curves, ivec2(i, 1), 0);
        vec2 p0 = c0.xy;
        vec2 p1 = c0.zw;
        vec2 p2 = c1.xy;
        float kink = c1.z;

        // The curve lies inside the convex hull of its control points, so this
        // box bounds both the true distance and any possible ray intersections.
        vec2 bmin = min(p0, min(p1, p2));
        vec2 bmax = max(p0, max(p1, p2));

        // 1. Distance for Anti-aliasing. The box distance is a lower bound on the
        // true distance, so curves that provably cannot lower the running minimum
        // (or feed the kink glow) skip the expensive cubic root solve entirely.
        vec2 gap = max(max(bmin - uv, uv - bmax), vec2(0.0));
        float boxDist = length(gap);
        float threshold = (u_show_flaws && kink > 0.5) ? max(min_dist, 0.05) : min_dist;
        if (boxDist < threshold) {
            float d;
            vec2 b_vec = p0 - 2.0*p1 + p2;
            if (dot(b_vec, b_vec) < 1e-6) {
                // It's a linear segment, fallback to precise line segment distance
                vec2 pa = uv - p0, ba = p2 - p0;
                float h = clamp( dot(pa,ba)/max(dot(ba,ba), 1e-8), 0.0, 1.0 );
                d = length( pa - ba*h );
            } else {
                // Evaluate cubic roots for true quadratic bezier distance
                d = sdBezier(uv, p0, p1, p2);
            }

            min_dist = min(min_dist, d);
            if (u_show_flaws && kink > 0.5) {
                flaw_intensity += smoothstep(0.04, 0.0, d);
            }
        }

        // 2. Winding Number — only curves whose hull straddles the +x ray can contribute
        if (uv.y >= bmin.y && uv.y <= bmax.y && uv.x < bmax.x) {
            winding += calcWinding(uv, p0, p1, p2);
        }
    }

    // Inside features Winding != 0, assign a negative distance
    float signed_dist = (winding != 0) ? -min_dist : min_dist;

    // --- AA ALGORITHM ---
    // Instead of using derivatives or large supersampling, 
    // fwidth maps the world distance slope exactly into screen pixels.
    float fw = fwidth(signed_dist) * 1.5;
    if (fw == 0.0) fw = 0.005;

    // Smoothstep creates our crisp perfectly anti-aliased edge.
    float alpha = smoothstep(fw, -fw, signed_dist);

    if (u_render_mode == 1) { // Ink Bleed (Physics simulation)
        // High-frequency deterministic noise to simulate paper capillary action
        float noise = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
        float bleed = noise * 0.04;
        alpha = smoothstep(fw + bleed, -fw - bleed, signed_dist - 0.015);
    }
    // ClearType (mode 2) is handled below as a per-channel mix; the base alpha
    // already equals its green-channel coverage.

    // Aesthetics: Rich Colors and Lighting
    // Background with soft radial vignette
    float vFactor = length(uv) * 0.25;
    vec3 bgColor = vec3(0.08, 0.08, 0.12) - vFactor;

    // Technical Artist Feature: Smooth mathematical grid lines
    vec2 grid_uv = uv * 5.0;
    vec2 grid = abs(fract(grid_uv - 0.5) - 0.5) / max(fwidth(grid_uv), 0.001);
    float gridLine = min(grid.x, grid.y);
    float gridAlpha = 1.0 - min(gridLine, 1.0);
    bgColor += vec3(0.2, 0.2, 0.5) * gridAlpha * 0.15;

    // Geometric gradient on the shape itself
    vec3 shapeColor = vec3(
        0.5 + 0.5 * sin(uv.x * 2.0 + u_time * 0.5), 
        0.5 + 0.5 * cos(uv.y * 3.0 + u_time * 0.2), 
        0.9
    );

    // Mix color based on our exact analytical alpha mask
    vec3 outColor = mix(bgColor, shapeColor, alpha);

    // Apply subpixel bleeding if active
    if (u_render_mode == 2) {
        float dR = signed_dist - dFdx(signed_dist) * 0.33;
        float dG = signed_dist;
        float dB = signed_dist + dFdx(signed_dist) * 0.33;
        outColor = mix(bgColor, shapeColor, vec3(
            smoothstep(fw, -fw, dR),
            smoothstep(fw, -fw, dG),
            smoothstep(fw, -fw, dB)
        ));
    }

    // Modern glow: bleed light based on distance outside
    float glow = smoothstep(0.12, 0.0, max(signed_dist, 0.0));
    
    // Technical Asset Pipeline: Output raw distance field natively
    if (u_render_mode == 3) {
        // Map raw distance to linear pixel space [0, 1] for external Game Engines
        // Base edge is precisely 0.5. Inside is > 0.5, Outside is < 0.5
        float sdfVal = clamp(-signed_dist * 8.0 + 0.5, 0.0, 1.0);
        outColor = vec3(sdfVal);
        glow = 0.0; // Override glows
    } else {
        outColor += shapeColor * glow * 0.35;
    }

    // Subtle edge highlight
    float edge = smoothstep(0.02, 0.0, abs(signed_dist));
    outColor += vec3(1.0, 1.0, 1.0) * edge * 0.2 * alpha;
    
    // Overlay red debug kinks if inspected
    if (flaw_intensity > 0.0) {
        outColor = mix(outColor, vec3(1.0, 0.0, 0.2), min(flaw_intensity, 1.0));
    }

    fragColor = vec4(outColor, 1.0);
}
`;


// Let's setup the JavaScript math defining our base typographic control points
// A stylized and complex letter "A" created with 10 Bezier curves total.
const basePoints = [
    // Outer Shell (Clockwise Winding)
    {id: 0, x: -0.6, y: -0.8}, // Bottom Left
    {id: 1, x: -0.2, y: 0.0},  // Left Control
    {id: 2, x: 0.0, y: 0.8},   // Peak
    {id: 3, x: 0.2, y: 0.0},   // Right Control
    {id: 4, x: 0.6, y: -0.8},  // Bottom Right
    {id: 5, x: 0.4, y: -0.8},  // Flat Bottom Right Control
    {id: 6, x: 0.3, y: -0.8},  // Inner Right Base
    {id: 7, x: 0.2, y: -0.4},  // Inner Right Control
    {id: 8, x: 0.15, y: -0.2}, // Crossbar Right Extents
    {id: 9, x: 0.0, y: -0.25}, // Crossbar Center Dip
    {id: 10, x: -0.15, y: -0.2},// Crossbar Left Extents
    {id: 11, x: -0.2, y: -0.4}, // Inner Left Control
    {id: 12, x: -0.3, y: -0.8}, // Inner Left Base
    {id: 13, x: -0.4, y: -0.8}, // Flat Bottom Left Control
    
    // Inner Shell "Hole" (Counter-Clockwise Winding)
    {id: 14, x: 0.1, y: 0.0},   // Start Right
    {id: 15, x: 0.05, y: 0.2},  // Travel Up-Left
    {id: 16, x: 0.0, y: 0.4},   // Inner Peak
    {id: 17, x: -0.05, y: 0.2}, // Travel Down-Left
    {id: 18, x: -0.1, y: 0.0},  // End Left
    {id: 19, x: 0.0, y: -0.05}  // Bottom Dip 
];

// Connectivity definition: Which points form the Bezier curves [P0, P1, P2]
const curvesDef = [
    [0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 8],
    [8, 9, 10], [10, 11, 12], [12, 13, 0],
    [14, 15, 16], [16, 17, 18], [18, 19, 14]
];

// Hard cap on curve count — bounded by the data texture width (min guaranteed
// texture size in WebGL2 is 2048) and by per-pixel loop cost in the shader.
const MAX_CURVES = 1024;

// The morphed (post weight/slant/tension) points, refreshed every frame by the
// render loop. Module-scoped so the export builders see live geometry.
let currentPoints = basePoints.map(p => ({x: p.x, y: p.y}));

// Utility: get mathematical tangent of a bezier curve at T
function getTangent(p0, p1, p2, t) {
    const invT = 1.0 - t;
    const dx = 2.0 * invT * (p1.x - p0.x) + 2.0 * t * (p2.x - p1.x);
    const dy = 2.0 * invT * (p1.y - p0.y) + 2.0 * t * (p2.y - p1.y);
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return {x: 1, y: 0};
    return {x: dx / len, y: dy / len};
}


function initWebGL() {
    const canvas = document.getElementById('webgl-canvas');
    // preserveDrawingBuffer keeps the back buffer readable after compositing so the
    // PNG/SDF export's toDataURL() doesn't capture a cleared (blank) frame.
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });

    if (!gl) {
        console.error("WebGL 2.0 not supported!");
        document.body.insertAdjacentHTML('beforeend',
            '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#f4f4f5;font-family:Inter,sans-serif;text-align:center;padding:24px;">' +
            '<p>This demo requires WebGL 2.0, which your browser or GPU does not support.</p></div>');
        return null;
    }

    // Compile Shaders
    function createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    const vShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        return null;
    }

    // Create a simple fullscreen quad
    const positions = new Float32Array([
        -1.0, -1.0,   1.0, -1.0,  -1.0,  1.0,
        -1.0,  1.0,   1.0, -1.0,   1.0,  1.0
    ]);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    return { gl, program, canvas };
}

function start() {
    const context = initWebGL();
    if (!context) return;
    const { gl, program, canvas } = context;

    // Get Uniform Locations
    const u_curves_loc = gl.getUniformLocation(program, "u_curves");
    const u_num_curves_loc = gl.getUniformLocation(program, "u_num_curves");
    const u_resolution_loc = gl.getUniformLocation(program, "u_resolution");
    const u_time_loc = gl.getUniformLocation(program, "u_time");
    const u_render_mode_loc = gl.getUniformLocation(program, "u_render_mode");
    const u_show_flaws_loc = gl.getUniformLocation(program, "u_show_flaws");

    const u_offset_loc = gl.getUniformLocation(program, "u_offset");
    const u_zoom_loc = gl.getUniformLocation(program, "u_zoom");

    // Curve data texture: column i holds one curve, row 0 = [p0, p1], row 1 = [p2, kink, 0]
    const curveTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_CURVES, 2, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(program);
    gl.uniform1i(u_curves_loc, 0);

    // UI Elements
    const weightXEl = document.getElementById('weight-x');
    const weightYEl = document.getElementById('weight-y');
    const slantEl = document.getElementById('slant');
    const tensionEl = document.getElementById('tension');
    const breathingEl = document.getElementById('breathing');
    const renderModeEl = document.getElementById('render-mode');
    const showFlawsEl = document.getElementById('show-flaws');

    const weightXValEl = document.getElementById('weight-x-val');
    const weightYValEl = document.getElementById('weight-y-val');
    const slantValEl = document.getElementById('slant-val');
    const tensionValEl = document.getElementById('tension-val');

    // Update displayed values
    function attachSliderUpdate(el, valEl) {
        const updateText = () => { valEl.innerText = parseFloat(el.value).toFixed(2); };
        el.addEventListener('input', updateText);
        el.addEventListener('change', updateText);
    }
    attachSliderUpdate(weightXEl, weightXValEl);
    attachSliderUpdate(weightYEl, weightYValEl);
    attachSliderUpdate(slantEl, slantValEl);
    attachSliderUpdate(tensionEl, tensionValEl);

    // Per-frame upload scratch: two RGBA32F rows of up to MAX_CURVES texels each
    const curveTexData = new Float32Array(MAX_CURVES * 8);
    const kinksArray = new Float32Array(MAX_CURVES);

    // Pre-allocate tracking arrays
    let normals = new Array(currentPoints.length).fill(null).map(() => ({x: 0, y: 0, count: 0}));

    // Pan & Zoom Camera State
    let camZoom = 1.0;
    let camOffsetX = 0.0;
    let camOffsetY = 0.0;
    let isDragging = false;
    let lastMouse = {x:0, y:0};

    // The shader maps the viewport so that the screen height always spans 2.5
    // logical units, so one CSS pixel of mouse travel = 2.5 / clientHeight units.
    const uvPerPixel = () => 2.5 / canvas.clientHeight;

    window.addEventListener('mousedown', (e) => {
        if(e.button !== 0 || e.target !== canvas) return;
        isDragging = true;
        lastMouse = {x: e.clientX, y: e.clientY};
    });
    window.addEventListener('mouseup', () => isDragging = false);
    window.addEventListener('mousemove', (e) => {
        if(isDragging) {
            const s = uvPerPixel();
            camOffsetX += (e.clientX - lastMouse.x) * s;
            camOffsetY -= (e.clientY - lastMouse.y) * s;
            lastMouse = {x: e.clientX, y: e.clientY};
        }
    });
    // Bound to the canvas (not window) so the wheel does nothing over the UI panel
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.1, Math.min(camZoom * zoomFactor, 50.0));

        // Zoom about the cursor: keep the world point under the pointer fixed
        const rect = canvas.getBoundingClientRect();
        const s = uvPerPixel();
        const ux = (e.clientX - rect.left - rect.width / 2) * s;
        const uy = (rect.height / 2 - (e.clientY - rect.top)) * s;
        const ratio = newZoom / camZoom;
        camOffsetX = ux - (ux - camOffsetX) * ratio;
        camOffsetY = uy - (uy - camOffsetY) * ratio;
        camZoom = newZoom;
    }, {passive: false});

    const overlayCanvas = document.getElementById('overlay-canvas');
    const overlayCtx = overlayCanvas.getContext('2d');
    const showSkeletonEl = document.getElementById('show-skeleton');

    function render(timeMs) {
        const time = timeMs / 1000.0;

        // Resize handler — render at device resolution (capped at 2x) for crisp
        // edges on HiDPI displays; the canvases stay at 100vw/100vh CSS size.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pxWidth = Math.round(window.innerWidth * dpr);
        const pxHeight = Math.round(window.innerHeight * dpr);
        if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
            canvas.width = pxWidth;
            canvas.height = pxHeight;
            overlayCanvas.width = pxWidth;
            overlayCanvas.height = pxHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }

        // Handle dynamic dataset sizing from UFO import dropzone
        if (currentPoints.length !== basePoints.length) {
            currentPoints = basePoints.map(p => ({x: p.x, y: p.y}));
            normals = new Array(currentPoints.length).fill(null).map(() => ({x: 0, y: 0, count: 0}));
        }

        // Fetch user inputs
        const weightX = parseFloat(weightXEl.value);
        const weightY = parseFloat(weightYEl.value);
        const slant = parseFloat(slantEl.value);
        const tension = parseFloat(tensionEl.value);
        const isBreathing = breathingEl.checked;
        const renderMode = parseInt(renderModeEl.value);
        const showFlaws = showFlawsEl.checked;

        // Reset tracking structures to base
        for(let i=0; i<currentPoints.length; i++) {
            currentPoints[i].x = basePoints[i].x;
            currentPoints[i].y = basePoints[i].y;
            normals[i].x = 0; normals[i].y = 0; normals[i].count = 0;
        }

        // --- 1. TENSION MORPHING ---
        // Radically alter the structural shape based on slider. The indices target
        // the built-in "A" topology, so guard against smaller imported glyphs.
        if (currentPoints.length > 19) {
            // Pull down the main peaks
            currentPoints[2].y -= tension * 0.9;
            currentPoints[16].y -= tension * 0.45;

            // Push the side legs inward to make it rounder/shorter
            currentPoints[1].x -= tension * 0.5;
            currentPoints[3].x += tension * 0.5;

            // Collapse the crossbar
            currentPoints[9].y -= tension * 0.3;
            currentPoints[19].y -= tension * 0.15;
        }


        // --- 2. BREATHING / VIBRATION EFFECT ---
        if (isBreathing) {
            // Apply a low-frequency pulse
            const scale = 1.0 + Math.sin(time * 6.0) * 0.05;
            for(let i=0; i<currentPoints.length; i++) {
                currentPoints[i].x *= scale;
                currentPoints[i].y *= scale;
            }
        }


        // --- 3. WEIGHT EXTRUSION (MATHEMATICAL) ---
        // We find the normal for EVERY geometric point and offset along it
        
        // Accumulate normals from adjacent curves
        for (const c of curvesDef) {
            const p0 = currentPoints[c[0]];
            const p1 = currentPoints[c[1]];
            const p2 = currentPoints[c[2]];
            
            const t0 = getTangent(p0, p1, p2, 0.0);
            normals[c[0]].x -= t0.y; normals[c[0]].y += t0.x; normals[c[0]].count++;
            
            // For control points, estimate the center normal
            const t1 = getTangent(p0, p1, p2, 0.5); 
            normals[c[1]].x -= t1.y; normals[c[1]].y += t1.x; normals[c[1]].count++;
            
            const t2 = getTangent(p0, p1, p2, 1.0);
            normals[c[2]].x -= t2.y; normals[c[2]].y += t2.x; normals[c[2]].count++;
        }

        // Apply independent stroke weights mathematically
        if (weightX !== 0.0 || weightY !== 0.0) {
            for(let i=0; i<currentPoints.length; i++) {
                if(normals[i].count > 0) {
                    const nx = normals[i].x / normals[i].count;
                    const ny = normals[i].y / normals[i].count;
                    const len = Math.sqrt(nx * nx + ny * ny);
                    if(len > 0.0) {
                        currentPoints[i].x += (nx / len) * weightX;
                        currentPoints[i].y += (ny / len) * weightY;
                    }
                }
            }
        }

        // --- 4. SLANT / ITALIC ---
        // A simple mathematical shear
        if (slant !== 0) {
            for(let i=0; i<currentPoints.length; i++) {
                currentPoints[i].x += currentPoints[i].y * slant;
            }
        }
        
        // --- 5. DETECT MATH FLAWS ---
        for (let i = 0; i < curvesDef.length; i++) {
            kinksArray[i] = 0.0;
            if (showFlaws) {
                // Determine if tangent has a sharp inner fold
                let dx = currentPoints[curvesDef[i][1]].x - currentPoints[curvesDef[i][0]].x;
                let dy = currentPoints[curvesDef[i][1]].y - currentPoints[curvesDef[i][0]].y;
                let dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < 0.02) kinksArray[i] = 1.0;
            }
        }

        // --- Upload to WebGL ---
        // Pack the two texture rows back to back: texSubImage2D below uploads a
        // numCurves-wide region, so row 1 starts at numCurves * 4 floats.
        const numCurves = curvesDef.length;
        for(let i=0; i<numCurves; i++) {
            const p0 = currentPoints[curvesDef[i][0]];
            const p1 = currentPoints[curvesDef[i][1]];
            const p2 = currentPoints[curvesDef[i][2]];

            const r0 = i * 4;
            const r1 = (numCurves + i) * 4;
            curveTexData[r0]   = p0.x;  curveTexData[r0+1] = p0.y;
            curveTexData[r0+2] = p1.x;  curveTexData[r0+3] = p1.y;
            curveTexData[r1]   = p2.x;  curveTexData[r1+1] = p2.y;
            curveTexData[r1+2] = kinksArray[i];
            curveTexData[r1+3] = 0.0;
        }

        gl.useProgram(program);

        if (numCurves > 0) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, numCurves, 2, gl.RGBA, gl.FLOAT,
                curveTexData.subarray(0, numCurves * 8));
        }

        gl.uniform1i(u_num_curves_loc, numCurves);
        gl.uniform1i(u_render_mode_loc, renderMode);
        gl.uniform1i(u_show_flaws_loc, showFlaws ? 1 : 0);
        
        gl.uniform2f(u_resolution_loc, canvas.width, canvas.height);
        gl.uniform1f(u_time_loc, time);

        gl.uniform2f(u_offset_loc, camOffsetX, camOffsetY);
        gl.uniform1f(u_zoom_loc, camZoom);

        // Draw quad
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- 6. DRAW OVERLAY SKELETON ---
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        if (showSkeletonEl.checked) {
            const hw = overlayCanvas.width / 2;
            const hh = overlayCanvas.height / 2;
            // Exact inverse of the shader mapping: uv spans 2.5 units over the
            // canvas height, and the aspect correction means the x scale is the
            // same height-derived factor.
            const pxPerUv = overlayCanvas.height / 2.5;

            function toScreen(pt) {
                const mappedX = pt.x * camZoom + camOffsetX;
                const mappedY = pt.y * camZoom + camOffsetY;
                return {
                    x: hw + mappedX * pxPerUv,
                    y: hh - mappedY * pxPerUv
                };
            }

            overlayCtx.lineWidth = 1.5 * dpr;
            // Draw Tangents
            overlayCtx.strokeStyle = 'rgba(168, 85, 247, 0.4)'; // Secondary color
            overlayCtx.beginPath();
            for(let i=0; i<curvesDef.length; i++) {
                let p0 = toScreen(currentPoints[curvesDef[i][0]]);
                let p1 = toScreen(currentPoints[curvesDef[i][1]]);
                let p2 = toScreen(currentPoints[curvesDef[i][2]]);
                overlayCtx.moveTo(p0.x, p0.y);
                overlayCtx.lineTo(p1.x, p1.y);
                overlayCtx.lineTo(p2.x, p2.y);
            }
            overlayCtx.stroke();
            
            // Draw Points
            for(let i=0; i<currentPoints.length; i++) {
                let p = toScreen(currentPoints[i]);
                overlayCtx.fillStyle = '#6366f1'; // Primary color
                overlayCtx.beginPath();
                overlayCtx.arc(p.x, p.y, 4 * dpr, 0, Math.PI*2);
                overlayCtx.fill();
            }
        }
        
        // Continuous Loop
        requestAnimationFrame(render);
    }

    // Begin Loop
    requestAnimationFrame(render);
}

// Global cache for opentype font object
let activeFont = null;

// Convert opentype.js paths into geometric curves
function updateFontPreview(text) {
    if (!activeFont || !text) return;

    const path = activeFont.getPath(text, 0, 0, 1000);
    const newPoints = [];
    const newCurves = [];

    let currentX = 0, currentY = 0;

    // Bounds tracking — include control points (x1/y1, x2/y2) so wide curve
    // handles can't push geometry outside the normalized viewport.
    const bounds = {minX:Infinity, maxX:-Infinity, minY:Infinity, maxY:-Infinity};
    const track = (x, y) => {
        if (typeof x !== 'number' || typeof y !== 'number') return;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
    };
    path.commands.forEach(cmd => {
        track(cmd.x, cmd.y);
        track(cmd.x1, cmd.y1);
        track(cmd.x2, cmd.y2);
    });
    if (!isFinite(bounds.minX)) return; // nothing drawable (e.g. whitespace only)

    let scale = 1.6 / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-6);
    let offsetX = -(bounds.minX + bounds.maxX) * 0.5 * scale;
    let offsetY = -(bounds.minY + bounds.maxY) * 0.5 * scale;

    const addCurve = (p0x, p0y, p1x, p1y, p2x, p2y) => {
        let scP0 = {x: p0x * scale + offsetX, y: -(p0y * scale + offsetY)};
        let scP1 = {x: p1x * scale + offsetX, y: -(p1y * scale + offsetY)};
        let scP2 = {x: p2x * scale + offsetX, y: -(p2y * scale + offsetY)};
        
        const idx = newPoints.length;
        newPoints.push({id: idx, x: scP0.x, y: scP0.y});
        newPoints.push({id: idx+1, x: scP1.x, y: scP1.y});
        newPoints.push({id: idx+2, x: scP2.x, y: scP2.y});
        newCurves.push([idx, idx+1, idx+2]);
    };

    path.commands.forEach(cmd => {
        if (cmd.type === 'M') { currentX = cmd.x; currentY = cmd.y; }
        else if (cmd.type === 'L') {
            // Convert line to exact quadratic
            let cx = (currentX + cmd.x)/2; let cy = (currentY + cmd.y)/2;
            addCurve(currentX, currentY, cx, cy, cmd.x, cmd.y);
            currentX = cmd.x; currentY = cmd.y;
        }
        else if (cmd.type === 'Q') {
            addCurve(currentX, currentY, cmd.x1, cmd.y1, cmd.x, cmd.y);
            currentX = cmd.x; currentY = cmd.y;
        }
        else if (cmd.type === 'C') {
            // Rough cubic -> quad approximation (midpoint of controls)
            let cx = (cmd.x1 + cmd.x2)/2; let cy = (cmd.y1 + cmd.y2)/2;
            addCurve(currentX, currentY, cx, cy, cmd.x, cmd.y);
            currentX = cmd.x; currentY = cmd.y;
        }
        else if (cmd.type === 'Z') { /* Path closed */ }
    });

    if (newCurves.length === 0) return; // keep the current shape rather than alerting
    if (newCurves.length > MAX_CURVES) {
        alert(`String too complex. Contains ${newCurves.length} geometric curves (Max ${MAX_CURVES}). Try fewer characters.`);
        return;
    }
    basePoints.length = 0; basePoints.push(...newPoints);
    curvesDef.length = 0; curvesDef.push(...newCurves);
}

// Robust parsing function Integration
function addDragAndDropSupport() {
    const dropZone = document.getElementById('drop-zone');
    const liveTextUI = document.getElementById('live-text-container');
    const liveTextInput = document.getElementById('live-text');
    
    liveTextInput.addEventListener('input', (e) => {
        updateFontPreview(e.target.value || " ");
    });
    
    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('active');
    });

    document.body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        // relatedTarget is null when the drag exits the window entirely — without
        // this the full-screen overlay stays up and blocks all UI interaction.
        if (e.target === dropZone || !e.relatedTarget) dropZone.classList.remove('active');
    });

    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');

        const file = e.dataTransfer.files[0];
        if (!file) return;
        const name = file.name.toLowerCase();

        if (name.endsWith('.ttf') || name.endsWith('.otf') || name.endsWith('.woff')) {
            if (typeof opentype === 'undefined') {
                return alert('OpenType.js failed to load (offline or CDN blocked) — .ttf/.otf parsing is unavailable.');
            }
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    activeFont = opentype.parse(ev.target.result);
                    liveTextUI.style.display = 'block';
                    updateFontPreview(liveTextInput.value);
                } catch (err) {
                    alert('Could not parse OpenType font format.');
                    console.error(err);
                }
            };
            reader.readAsArrayBuffer(file);
            return;
        }

        if (!name.endsWith('.glif')) return alert('Please drop a valid .ttf, .otf, or .glif file.');
        
        activeFont = null;
        liveTextUI.style.display = 'none';

        const reader = new FileReader();
        reader.onload = (ev) => {
            const parser = new DOMParser();
            const xml = parser.parseFromString(ev.target.result, "text/xml");
            if (xml.querySelector("parsererror")) {
                return alert('Could not parse .glif file — invalid XML.');
            }

            const newPoints = [];
            const newCurves = [];
            let pid = 0;
            const contours = Array.from(xml.querySelectorAll("contour"));

            // Normalize against the bounds of the WHOLE glyph, not per contour —
            // per-contour scaling blows counters (holes) up to the outline's size.
            const bounds = {minX:Infinity, maxX:-Infinity, minY:Infinity, maxY:-Infinity};
            contours.forEach(contour => {
                contour.querySelectorAll("point").forEach(pt => {
                    const x = parseFloat(pt.getAttribute("x"));
                    const y = parseFloat(pt.getAttribute("y"));
                    if (isNaN(x) || isNaN(y)) return;
                    bounds.minX = Math.min(bounds.minX, x);
                    bounds.maxX = Math.max(bounds.maxX, x);
                    bounds.minY = Math.min(bounds.minY, y);
                    bounds.maxY = Math.max(bounds.maxY, y);
                });
            });
            if (!isFinite(bounds.minX)) {
                return alert('No contour points found in this .glif file.');
            }

            const scale = 1.6 / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-6);
            const offsetX = -(bounds.minX + bounds.maxX) * 0.5 * scale;
            const offsetY = -(bounds.minY + bounds.maxY) * 0.5 * scale;

            contours.forEach(contour => {
                const pts = Array.from(contour.querySelectorAll("point"));
                let firstPtIdx = pid;

                for(let i=0; i<pts.length; i++) {
                    let x = parseFloat(pts[i].getAttribute("x")) * scale + offsetX;
                    let y = parseFloat(pts[i].getAttribute("y")) * scale + offsetY;
                    newPoints.push({id: pid++, x: x, y: y});
                }

                // Pair them into rough quadratics for visualization
                for(let i=0; i<pts.length; i++) {
                    let p0 = firstPtIdx + i;
                    let p1 = firstPtIdx + ((i+1) % pts.length);
                    let p2 = firstPtIdx + ((i+2) % pts.length);
                    newCurves.push([p0, p1, p2]);
                }
            });

            if (newCurves.length > 0 && newCurves.length <= MAX_CURVES) {
                basePoints.length = 0; basePoints.push(...newPoints);
                curvesDef.length = 0; curvesDef.push(...newCurves);
            } else {
                alert("File contains too many curves for standalone browser prototype (" + newCurves.length + "/" + MAX_CURVES + " max).");
            }
        };
        reader.readAsText(file);
    });
}


// Build a UFO .glif document from the LIVE morphed geometry (weight/slant/tension
// applied), walking the curve list so on-curve points get type="qcurve", control
// points stay untyped (offcurve), and discontinuities start a new contour.
function buildGlifXML() {
    const fmt = (pt) => `x="${Math.round((pt.x + 1.0) * 500.0)}" y="${Math.round((pt.y + 1.0) * 500.0)}"`;
    const samePos = (a, b) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<glyph name="morphed_export" format="2">\n  <outline>\n`;
    let contourStart = null;

    for (let i = 0; i < curvesDef.length; i++) {
        const p0 = currentPoints[curvesDef[i][0]];
        const p1 = currentPoints[curvesDef[i][1]];
        const p2 = currentPoints[curvesDef[i][2]];

        const prevEnd = i > 0 ? currentPoints[curvesDef[i-1][2]] : null;
        if (!prevEnd || !samePos(prevEnd, p0)) {
            if (contourStart) xml += `    </contour>\n`;
            xml += `    <contour>\n      <point ${fmt(p0)} type="qcurve"/>\n`;
            contourStart = p0;
        }

        xml += `      <point ${fmt(p1)}/>\n`;

        // Suppress the closing on-curve point when the contour wraps back to its
        // start — UFO contours are implicitly closed.
        const nextStart = i + 1 < curvesDef.length ? currentPoints[curvesDef[i+1][0]] : null;
        const endsContour = !nextStart || !samePos(nextStart, p2);
        if (!(endsContour && samePos(p2, contourStart))) {
            xml += `      <point ${fmt(p2)} type="qcurve"/>\n`;
        }
    }
    if (contourStart) xml += `    </contour>\n`;
    xml += `  </outline>\n</glyph>`;
    return xml;
}

// Build an SVG from the live morphed geometry. fill-rule="nonzero" matches the
// shader's winding test (winding != 0).
function buildSVG() {
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 4 4" width="1024" height="1024">\n`;
    // Invert Y axis to match graphic design space (WebGL Y points up, SVG Y points down)
    svg += `  <g transform="scale(1, -1)">\n`;
    svg += `    <path fill="#6366f1" fill-rule="nonzero" d="`;

    for(let i=0; i<curvesDef.length; i++) {
        let p0 = currentPoints[curvesDef[i][0]];
        let p1 = currentPoints[curvesDef[i][1]];
        let p2 = currentPoints[curvesDef[i][2]];

        // Continuous path logic (start subpath if P0 doesn't match last P2)
        if (i === 0) {
            svg += `M ${p0.x} ${p0.y} `;
        } else {
            let lastP2 = currentPoints[curvesDef[i-1][2]];
            if (Math.abs(lastP2.x - p0.x) > 0.001 || Math.abs(lastP2.y - p0.y) > 0.001) {
                svg += `Z M ${p0.x} ${p0.y} `;
            }
        }
        svg += `Q ${p1.x} ${p1.y} ${p2.x} ${p2.y} `;
    }
    svg += `Z" />\n  </g>\n</svg>`;
    return svg;
}

function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], {type: mimeType});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Start application
window.onload = () => {
    start();
    addDragAndDropSupport();

    // Developer Backend Export Agent
    document.getElementById('btn-export').addEventListener('click', () => {
        if (curvesDef.length === 0) return;
        downloadBlob(buildGlifXML(), 'text/xml', `gpu_morphed_${Date.now()}.glif`);
    });

    // SDF / Image Exporter — toBlob avoids data-URL size limits on large canvases
    document.getElementById('btn-export-png').addEventListener('click', () => {
        const c = document.getElementById('webgl-canvas');
        c.toBlob((blob) => {
            if (!blob) return alert('PNG capture failed.');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `gpu_texture_asset_${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(url);
        }, 'image/png');
    });

    // SVG Vector Asset Exporter
    document.getElementById('btn-export-svg').addEventListener('click', () => {
        if (curvesDef.length === 0) return;
        downloadBlob(buildSVG(), 'image/svg+xml', `vector_shape_${Date.now()}.svg`);
    });

    // UX Research: Add keyboard shortcut to hide UI
    window.addEventListener('keydown', (e) => {
        // Don't hijack typing in the live-text field (or any future text input)
        if (e.target.matches('input[type="text"], textarea, select')) return;
        if (e.key.toLowerCase() === 'h') {
            const panel = document.querySelector('.controls-panel');
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            }
        }
    });
};
