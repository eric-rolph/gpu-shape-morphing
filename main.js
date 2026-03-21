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

// Arrays containing the points of our quadratic Bezier curves
// Max 20 curves for this demo
uniform vec2 u_p0[20];
uniform vec2 u_p1[20];
uniform vec2 u_p2[20];
uniform int u_num_curves;

uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// Exact mathematical distance to a quadratic Bezier curve
// Adapted math based on standard algebraic roots for Bezier distances
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

    float min_dist = 1000.0;
    int winding = 0;

    // Loop through all geometric Bezier curves evaluating exact distance and winding
    for(int i = 0; i < u_num_curves; ++i) {
        vec2 p0 = u_p0[i];
        vec2 p1 = u_p1[i];
        vec2 p2 = u_p2[i];

        // 1. Distance for Anti-aliasing
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

        // 2. Winding Number for Inside/Outside Evaluation
        winding += calcWinding(uv, p0, p1, p2);
    }

    // Inside features Winding != 0, assign a negative distance
    float signed_dist = (winding != 0) ? -min_dist : min_dist;

    // --- AA ALGORITHM ---
    // Instead of using derivatives or large supersampling, 
    // fwidth maps the world distance slope exactly into screen pixels.
    float fw = fwidth(signed_dist) * 1.5;
    if (fw == 0.0) fw = 0.005;

    // Smoothstep creates our crisp perfectly anti-aliased edge.
    // >0 is outside, <0 is inside. Alpha 1.0 when solid inside.
    float alpha = smoothstep(fw, -fw, signed_dist);

    // Aesthetics: Rich Colors and Lighting
    // Background with soft radial vignette
    float vFactor = length(uv) * 0.25;
    vec3 bgColor = vec3(0.08, 0.08, 0.12) - vFactor;

    // Geometric gradient on the shape itself
    vec3 shapeColor = vec3(
        0.5 + 0.5 * sin(uv.x * 2.0 + u_time * 0.5), 
        0.5 + 0.5 * cos(uv.y * 3.0 + u_time * 0.2), 
        0.9
    );

    // Mix color based on our exact analytical alpha mask
    vec3 outColor = mix(bgColor, shapeColor, alpha);

    // Modern glow: bleed light based on distance outside
    float glow = smoothstep(0.12, 0.0, max(signed_dist, 0.0));
    outColor += shapeColor * glow * 0.35;

    // Subtle edge highlight
    float edge = smoothstep(0.02, 0.0, abs(signed_dist));
    outColor += vec3(1.0, 1.0, 1.0) * edge * 0.2 * alpha;

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

// Utility: get mathematical tangent of a bezier curve at T
function getTangent(p0, p1, p2, t) {
    const invT = 1.0 - t;
    const dx = 2.0 * invT * (p1.x - p0.x) + 2.0 * t * (p2.x - p1.x);
    const dy = 2.0 * invT * (p1.y - p0.y) + 2.0 * t * (p2.y - p1.y);
    const len = Math.hypot(dx, dy);
    if(len === 0) return {x: 1, y: 0};
    return {x: dx / len, y: dy / len};
}


function initWebGL() {
    const canvas = document.getElementById('webgl-canvas');
    const gl = canvas.getContext('webgl2');
    
    if (!gl) {
        console.error("WebGL 2.0 not supported!");
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
    const u_p0_loc = gl.getUniformLocation(program, "u_p0");
    const u_p1_loc = gl.getUniformLocation(program, "u_p1");
    const u_p2_loc = gl.getUniformLocation(program, "u_p2");
    const u_num_curves_loc = gl.getUniformLocation(program, "u_num_curves");
    const u_resolution_loc = gl.getUniformLocation(program, "u_resolution");
    const u_time_loc = gl.getUniformLocation(program, "u_time");

    // UI Elements
    const weightEl = document.getElementById('weight');
    const slantEl = document.getElementById('slant');
    const tensionEl = document.getElementById('tension');
    const breathingEl = document.getElementById('breathing');

    const weightValEl = document.getElementById('weight-val');
    const slantValEl = document.getElementById('slant-val');
    const tensionValEl = document.getElementById('tension-val');

    // Update displayed values
    function attachSliderUpdate(el, valEl) {
        const updateText = () => { valEl.innerText = parseFloat(el.value).toFixed(2); };
        el.addEventListener('input', updateText);
        el.addEventListener('change', updateText);
    }
    attachSliderUpdate(weightEl, weightValEl);
    attachSliderUpdate(slantEl, slantValEl);
    attachSliderUpdate(tensionEl, tensionValEl);

    // Pre-allocate WebGL arrays to avoid GC pressure in requestAnimationFrame
    const p0Array = new Float32Array(curvesDef.length * 2);
    const p1Array = new Float32Array(curvesDef.length * 2);
    const p2Array = new Float32Array(curvesDef.length * 2);

    function render(timeMs) {
        const time = timeMs / 1000.0;

        // Resize handler
        if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }

        // Fetch user inputs
        const weight = parseFloat(weightEl.value);
        const slant = parseFloat(slantEl.value);
        const tension = parseFloat(tensionEl.value);
        const isBreathing = breathingEl.checked;

        // Clone base points
        let currentPoints = basePoints.map(p => ({x: p.x, y: p.y}));

        // --- 1. TENSION MORPHING ---
        // Radically alter the structural shape based on slider
        // Pull down the main peaks
        currentPoints[2].y -= tension * 0.9;
        currentPoints[16].y -= tension * 0.45;
        
        // Push the side legs inward to make it rounder/shorter
        currentPoints[1].x -= tension * 0.5;
        currentPoints[3].x += tension * 0.5;

        // Collapse the crossbar
        currentPoints[9].y -= tension * 0.3;
        currentPoints[19].y -= tension * 0.15;


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
        let normals = new Array(currentPoints.length).fill(null).map(() => ({x: 0, y: 0, count: 0}));

        // Accumulate normals from adjacent curves
        for (let c of curvesDef) {
            let p0 = currentPoints[c[0]];
            let p1 = currentPoints[c[1]];
            let p2 = currentPoints[c[2]];
            
            let t0 = getTangent(p0, p1, p2, 0.0);
            normals[c[0]].x += -t0.y; normals[c[0]].y += t0.x; normals[c[0]].count++;
            
            // For control points, estimate the center normal
            let t1 = getTangent(p0, p1, p2, 0.5); 
            normals[c[1]].x += -t1.y; normals[c[1]].y += t1.x; normals[c[1]].count++;
            
            let t2 = getTangent(p0, p1, p2, 1.0);
            normals[c[2]].x += -t2.y; normals[c[2]].y += t2.x; normals[c[2]].count++;
        }

        // Apply weight mathematically
        if (weight !== 0.0) {
            for(let i=0; i<currentPoints.length; i++) {
                if(normals[i].count > 0) {
                    let nx = normals[i].x / normals[i].count;
                    let ny = normals[i].y / normals[i].count;
                    let len = Math.hypot(nx, ny);
                    if(len > 0.0) {
                        currentPoints[i].x += (nx / len) * weight;
                        currentPoints[i].y += (ny / len) * weight;
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

        // --- Upload to WebGL ---
        for(let i=0; i<curvesDef.length; i++) {
            let p0 = currentPoints[curvesDef[i][0]];
            let p1 = currentPoints[curvesDef[i][1]];
            let p2 = currentPoints[curvesDef[i][2]];

            p0Array[i*2] = p0.x;     p0Array[i*2+1] = p0.y;
            p1Array[i*2] = p1.x;     p1Array[i*2+1] = p1.y;
            p2Array[i*2] = p2.x;     p2Array[i*2+1] = p2.y;
        }

        gl.useProgram(program);

        gl.uniform2fv(u_p0_loc, p0Array);
        gl.uniform2fv(u_p1_loc, p1Array);
        gl.uniform2fv(u_p2_loc, p2Array);
        gl.uniform1i(u_num_curves_loc, curvesDef.length);
        
        gl.uniform2f(u_resolution_loc, canvas.width, canvas.height);
        gl.uniform1f(u_time_loc, time);

        // Draw quad
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Continuous Loop
        requestAnimationFrame(render);
    }

    // Begin Loop
    requestAnimationFrame(render);
}

// Start application
window.onload = start;
