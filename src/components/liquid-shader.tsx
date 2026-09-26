import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
  attribute vec2 a_position;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform vec2 u_resolution;
  uniform float u_time;

  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);
    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), local.x),
      local.y
    );
  }

  float fbm(vec2 point) {
    float value = 0.0;
    float amplitude = 0.52;
    mat2 rotation = mat2(0.82, 0.57, -0.57, 0.82);
    for (int octave = 0; octave < 5; octave++) {
      value += amplitude * noise(point);
      point = rotation * point * 2.03 + vec2(7.3, 4.1);
      amplitude *= 0.49;
    }
    return value;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    vec2 point = uv - 0.5;
    point.x *= u_resolution.x / u_resolution.y;

    float time = u_time * 0.46;
    vec2 flow = vec2(
      fbm(point * 1.22 + vec2(time * 0.18, -time * 0.12)),
      fbm(point * 1.22 + vec2(4.8 - time * 0.14, 2.6 + time * 0.20))
    );
    vec2 fold = vec2(
      fbm(point * 1.48 + flow * 2.65 + vec2(1.7, 8.2) + time * 0.15),
      fbm(point * 1.36 + flow * 2.25 + vec2(8.3, 2.8) - time * 0.11)
    );

    float liquid = fbm(point * 1.58 + fold * 3.0 + vec2(-time * 0.12, time * 0.08));
    float contour = sin((point.x * 0.78 + point.y * 0.42 + liquid * 1.95) * 8.3 - time * 2.1);
    float fineContour = sin((point.x * -0.38 + point.y * 0.72 + fold.y * 1.62) * 12.4 + time * 1.35);
    float ridge = pow(1.0 - abs(contour), 8.0);
    float fineRidge = pow(1.0 - abs(fineContour), 13.0);
    float basin = smoothstep(0.18, 0.94, liquid);

    vec3 ink = vec3(0.035, 0.025, 0.035);
    vec3 oxblood = vec3(0.28, 0.028, 0.055);
    vec3 crimson = vec3(0.82, 0.045, 0.095);
    vec3 flare = vec3(1.0, 0.34, 0.27);

    vec3 color = mix(ink, oxblood, basin * 0.88);
    color = mix(color, crimson, smoothstep(0.48, 0.96, flow.x + liquid * 0.34) * 0.46);
    color += crimson * ridge * (0.18 + basin * 0.48);
    color += flare * fineRidge * ridge * 0.32;

    float leftGlow = 1.0 - smoothstep(0.12, 1.2, distance(point, vec2(-0.66, 0.20)));
    float lowerGlow = 1.0 - smoothstep(0.08, 0.96, distance(point, vec2(0.52, -0.48)));
    color += crimson * (leftGlow * 0.10 + lowerGlow * 0.12);

    float vignette = smoothstep(0.95, 0.22, length(point * vec2(0.82, 1.0)));
    color *= 0.63 + vignette * 0.50;
    color += (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.012;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export function LiquidShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
    });
    if (!gl) return undefined;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return undefined;

    const program = gl.createProgram();
    if (!program) return undefined;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return undefined;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    if (!buffer) return undefined;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const startedAt = performance.now();
    let frame = 0;

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(window.innerWidth * scale));
      const height = Math.max(1, Math.round(window.innerHeight * scale));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };

    const render = (now: number) => {
      resize();
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, reducedMotion ? 0 : (now - startedAt) / 1_000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reducedMotion) frame = window.requestAnimationFrame(render);
    };

    window.addEventListener('resize', resize);
    frame = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  return <canvas className="liquid-shader" ref={canvasRef} aria-hidden="true" />;
}
