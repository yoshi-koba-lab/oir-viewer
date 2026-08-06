/**
 * The volume ray-marching shaders, shared by the interactive 3D view and the
 * plate export renderer.
 *
 * Extracted so the two cannot drift: a plate PDF that shaded its wells even
 * slightly differently from what the user set up on screen would be a figure
 * that does not match the inspection it came from.
 */

export const vertexShader = `
  out vec3 vOrigin;
  out vec3 vDirection;
  uniform vec3 cameraPos;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vOrigin = cameraPos;
    vDirection = position - cameraPos;
  }
`;

/**
 * Fragment shader (GLSL3): ray-march through the volume bounding box.
 * Supports up to 4 channels with individual colors and contrast.
 * Two modes: MIP (maximum intensity projection) and alpha compositing.
 */
export const fragmentShader = `
  precision highp float;
  precision highp sampler3D;

  in vec3 vOrigin;
  in vec3 vDirection;

  out vec4 fragColor;

  uniform sampler3D uVolume0;
  uniform sampler3D uVolume1;
  uniform sampler3D uVolume2;
  uniform sampler3D uVolume3;
  uniform int uNumChannels;
  uniform vec3 uColors[4];
  uniform float uMins[4];
  uniform float uMaxs[4];
  uniform bool uVisible[4];
  uniform int uSteps;
  // Sub-range of the stack to render, in normalised volume Z (0..1).
  uniform float uZMin;
  uniform float uZMax;

  vec2 intersectBox(vec3 orig, vec3 dir) {
    vec3 tMin = (vec3(0.0) - orig) / dir;
    vec3 tMax = (vec3(1.0) - orig) / dir;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    float tNear = max(max(t1.x, t1.y), t1.z);
    float tFar = min(min(t2.x, t2.y), t2.z);
    return vec2(tNear, tFar);
  }

  float sampleChannel(int ch, vec3 pos) {
    if (ch == 0) return texture(uVolume0, pos).r;
    if (ch == 1) return texture(uVolume1, pos).r;
    if (ch == 2) return texture(uVolume2, pos).r;
    if (ch == 3) return texture(uVolume3, pos).r;
    return 0.0;
  }

  void main() {
    vec3 rayDir = normalize(vDirection);
    vec2 bounds = intersectBox(vOrigin, rayDir);
    if (bounds.x > bounds.y) discard;
    bounds.x = max(bounds.x, 0.0);

    float stepSize = 1.0 / float(uSteps);
    vec3 maxColor = vec3(0.0);

    for (int i = 0; i < 512; i++) {
      if (i >= uSteps) break;
      float t = bounds.x + float(i) * (bounds.y - bounds.x) * stepSize;
      if (t > bounds.y) break;

      vec3 samplePos = vOrigin + rayDir * t;
      if (any(lessThan(samplePos, vec3(0.0))) || any(greaterThan(samplePos, vec3(1.0)))) continue;
      // Restrict to the selected slab of the stack.
      if (samplePos.z < uZMin || samplePos.z > uZMax) continue;

      vec3 color = vec3(0.0);
      for (int ch = 0; ch < 4; ch++) {
        if (ch >= uNumChannels) break;
        if (!uVisible[ch]) continue;

        float raw = sampleChannel(ch, samplePos);
        float rangeInv = 1.0 / max(uMaxs[ch] - uMins[ch], 0.001);
        float norm = clamp((raw - uMins[ch]) * rangeInv, 0.0, 1.0);
        color += uColors[ch] * norm;
      }

      maxColor = max(maxColor, color);
    }

    fragColor = vec4(maxColor, 1.0);
  }
`;
