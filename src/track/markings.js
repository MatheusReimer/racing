import * as THREE from 'three';

// Road markings, drawn by the road's own shader.
//
// A street is not a strip of asphalt. It has a centre line, lane divides, edge
// lines, hatching where it splits and stop lines where it meets another one,
// and their absence is most of why a circuit walled by buildings still reads as
// a track dressed as a city rather than as a city being raced through.
//
// None of it is geometry. The road already knows, per vertex, where it is
// across itself and how far along it has come — `aLane` carries (u, s, half
// width, is-branch) — so every marking is a distance test in the fragment
// shader. That buys three things geometry would not:
//
//   * crispness. Markings are specified in metres and stay 150 mm wide whether
//     the road is nine vertices across or nine hundred, and whether the camera
//     is on top of them or two hundred metres away.
//   * curvature for free. The lines are laid out in the road's own coordinates,
//     so they follow every bend without anything being projected or fitted.
//   * no draw calls and no z-fighting. A second strip of geometry a few
//     millimetres above the tarmac is the usual way to do this and it flickers
//     at distance on exactly the hardware this game is trying to run on.
//
// The cost is that markings cannot be occluded or destroyed independently of
// the road, which is the right trade: they are paint.

/** Widths in metres, so they are the widths a real road actually uses. */
const LINE = 0.14;          // a painted line
const CENTRE_GAP = 0.22;    // between the two halves of a double centre line
const EDGE_INSET = 0.55;    // from the tarmac's edge to the edge line
const DASH = 3.0;           // painted length of a broken line
const DASH_GAP = 6.0;       // and the gap after it

/** How wide a traffic lane is. The road's width decides how many there are. */
const LANE_WIDTH = 3.6;

const PARS = /* glsl */`
varying vec4 vLane;
uniform vec3 uPaintWhite;
uniform vec3 uPaintYellow;
uniform float uMarkWear;
// Where the shortcuts leave, and which side they leave on: (station, side).
uniform vec2 uSplits[8];
uniform int uSplitCount;
uniform float uLapLength;

// A band of width w centred on 0, antialiased against however much of the road
// this fragment covers. Without the fwidth term the lines alias into dotted
// noise the moment they are more than about thirty metres away.
float band(float x, float w) {
  float e = max(fwidth(x), 1e-5);
  return 1.0 - smoothstep(w * 0.5 - e, w * 0.5 + e, abs(x));
}

// 1 while inside the painted part of a broken line, 0 in the gap.
float dashed(float s, float on, float period) {
  float t = mod(s, period);
  float e = max(fwidth(s), 1e-5);
  return smoothstep(-e, e, t) - smoothstep(on - e, on + e, t);
}
`;

const BODY = /* glsl */`
{
  float u = vLane.x;
  float sAlong = vLane.y;
  float halfW = vLane.z;
  float isBranch = vLane.w;

  // Lateral position in metres. Everything below is metres, which is what lets
  // a marking keep its real width on a road whose width changes along its way.
  float x = u * halfW;
  float paint = 0.0;
  vec3 paintCol = uPaintWhite;

  // The edge line, inboard of the tarmac's edge. Solid, always: it is the one
  // marking whose job is to say where the road stops.
  paint = max(paint, band(abs(x) - (halfW - EDGE_INSET), LINE));

  if (isBranch < 0.5) {
    // Double solid centre line, in yellow — the marking that says which side
    // of the road is yours.
    float centre = max(band(x - CENTRE_GAP * 0.5, LINE),
                       band(x + CENTRE_GAP * 0.5, LINE));
    if (centre > paint) { paint = centre; paintCol = uPaintYellow; }

    // Lane divides, broken, at every lane width out from the centre. The road
    // is as wide as it is, so how many there are follows from that rather than
    // from a number written down here.
    float lanes = floor((halfW - EDGE_INSET) / LANE_WIDTH);
    for (float i = 1.0; i <= 4.0; i += 1.0) {
      if (i > lanes) break;
      float at = i * LANE_WIDTH;
      float d = max(band(x - at, LINE), band(x + at, LINE));
      paint = max(paint, d * dashed(sAlong, DASH, DASH + DASH_GAP));
    }
  } else {
    // A branch leaves the road, so it is hatched rather than laned: chevrons
    // pointing back the way you came, which is how a real slip road is painted
    // and reads at a glance as "this is not the main line".
    //
    // Only along its shoulders. A branch's ribbon overlaps the main road for
    // the few metres either side of where it joins, and hatching its full
    // width painted chevrons straight across the highway's lanes there.
    float shoulder = smoothstep(halfW * 0.45, halfW * 0.62, abs(x));
    float chev = abs(x) + sAlong;
    paint = max(paint, band(mod(chev, 3.2) - 1.6, LINE * 1.6) * 0.7 * shoulder);
  }

  // Chevrons warning of a split.
  //
  // A branch is the only decision the road asks the player to make at speed,
  // and until now it gave no warning at all: the shortcut simply appeared. A
  // real road paints the lane you are being invited into, on the side it
  // leaves, for the last forty metres.
  if (isBranch < 0.5) {
    for (int i = 0; i < 8; i++) {
      if (i >= uSplitCount) break;
      // Distance until the split, wrapped, because a lap is a loop and a
      // shortcut fifteen metres ahead can be at station zero.
      float d = uSplits[i].x - sAlong;
      d = mod(d + uLapLength * 0.5, uLapLength) - uLapLength * 0.5;
      if (d < 4.0 || d > 46.0) continue;

      // The outer half of the lane the branch leaves from.
      float side = uSplits[i].y;
      float lane = x * side;
      if (lane < halfW * 0.30 || lane > halfW - EDGE_INSET - 0.2) continue;

      // A V pointing the way you are going: the two arms are the same line in
      // (across, along), mirrored.
      float v = abs(lane - halfW * 0.62) * 1.5 - d;
      float arrow = band(mod(v, 9.0) - 4.5, LINE * 3.2);
      // Fading in rather than starting at full strength, so the last one before
      // the split is the loudest.
      paint = max(paint, arrow * smoothstep(46.0, 22.0, d));
    }
  }

  // Worn, not printed. Paint on a road that is driven on is thinner in the
  // wheel tracks and never quite the white it left the factory.
  float wear = 1.0 - uMarkWear * (0.35 + 0.65 * band(abs(x) - halfW * 0.42, 2.2));
  diffuseColor.rgb = mix(diffuseColor.rgb, paintCol, clamp(paint * wear, 0.0, 1.0));
}
`;

/**
 * Teach a road material to paint its own markings.
 *
 * @param material  the road's MeshStandardMaterial
 * @param palette   the biome's palette; `markings: false` opts a district out
 */
export function paintMarkings(material, palette = {}, track = null) {
  if (palette.markings === false) return material;

  const splits = splitsOf(track);

  const white = palette.markWhite ?? '#c9c6bd';
  // Duller than a paint chip. Road yellow is a pigment that has been rained on
  // and driven over, and at full saturation it reads as a stripe of highlighter.
  const yellow = palette.markYellow ?? '#a8892f';

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPaintWhite = { value: new THREE.Color(white) };
    shader.uniforms.uPaintYellow = { value: new THREE.Color(yellow) };
    shader.uniforms.uMarkWear = { value: palette.markWear ?? 0.28 };
    shader.uniforms.uSplits = { value: splits.slots };
    shader.uniforms.uSplitCount = { value: splits.count };
    shader.uniforms.uLapLength = { value: splits.lap };

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec4 aLane;\nvarying vec4 vLane;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLane = aLane;');

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${constants()}\n${PARS}\nvoid main() {`)
      // After the map, so the markings sit on the asphalt rather than under it,
      // and before lighting, so they are lit like paint on a road and not like
      // an emissive decal.
      .replace('#include <map_fragment>', `#include <map_fragment>\n${BODY}`);
  };
  // Two materials compiled from the same source need different keys, or Three
  // hands the second one the first one's program.
  material.customProgramCacheKey = () => `markings:${white}:${yellow}`;
  return material;
}

/**
 * The branches, as (station, side) pairs the shader can test against.
 *
 * Side comes from which way the branch's first point lies off the main line,
 * measured rather than stored: a branch knows where it goes and the track knows
 * where it was, and the sign of one against the other is the answer.
 */
function splitsOf(track) {
  const slots = Array.from({ length: 8 }, () => new THREE.Vector2());
  if (!track?.branches?.length) return { slots, count: 0, lap: 1 };

  const at = { x: 0, y: 0, z: 0 };
  const tan = { x: 0, z: 0 };
  let count = 0;
  for (const br of track.branches) {
    if (count >= slots.length) break;
    const s = br.entryS ?? 0;
    track.path.pointAt(s, at);
    track.path.tangentAt(s, tan);
    // A point a little way down the branch, against the main line's normal.
    const p = br.path.pointAt(Math.min(br.path.length, 30));
    const side = Math.sign((p.x - at.x) * tan.z + (p.z - at.z) * -tan.x) || 1;
    slots[count++].set(s, side);
  }
  return { slots, count, lap: Math.max(1, track.length) };
}

function constants() {
  return `const float LINE = ${LINE.toFixed(3)};
const float CENTRE_GAP = ${CENTRE_GAP.toFixed(3)};
const float EDGE_INSET = ${EDGE_INSET.toFixed(3)};
const float DASH = ${DASH.toFixed(3)};
const float DASH_GAP = ${DASH_GAP.toFixed(3)};
const float LANE_WIDTH = ${LANE_WIDTH.toFixed(3)};`;
}
