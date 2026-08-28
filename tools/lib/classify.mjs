// What part of a car a triangle belongs to, from the material it wears.
//
// Shared by tools/lowpoly.mjs and tools/decimate.mjs. A class, not a colour:
// shipping the reference's own paint would fight the game, where each vehicle
// picks its own, while "this is glass" lets the game paint it and keep the
// layout.
//
// Names, never the alpha channel. glTF only honours baseColorFactor's alpha
// when alphaMode says to, and these files disagree about that so thoroughly
// that the GC8 declares its own bodywork fully transparent across eight
// thousand triangles. The names differ per author — Carro_Vidro, NGlassMtl1,
// Window_Glass — but the vocabulary is small and survives translation.

export const CLS = { PAINT: 0, GLASS: 1, DARK: 2, CHROME: 3, LAMP: 4, INSIDE: 5 };

// Seats, carpet, dashboard, the wheel in front of the driver. Not the outside
// of a car, and dropped before anything is traced or decimated — a ray fired at
// the greenhouse otherwise goes through the window and lands on the upholstery.
const INTERIOR = /interior|\bint_|seat|banco|cloth|carpet|leather|couro|dash|painel|steer|volante|gauge|pedal|belt|cinto/;

/**
 * A name that carries no information about what it is.
 *
 * Blender's default, and what a good half of Sketchfab's catalogue ships with:
 * `Material`, `Material.005`, `Material__2`. The RX-7 has fifteen of them and
 * one called `redglass`, so on that file the name-based reading returns a car
 * that is ninety-nine per cent paint.
 */
const ANONYMOUS = /^(material|mat|standard|default|lambert|phong|surface|untitled)?[\s._-]*\d*$/;

/**
 * The fallback when the name says nothing: read the material's own appearance.
 *
 * Weaker than a name and used only where there is no name worth reading, but
 * the distinctions that matter here survive it. A tyre is near-black and fully
 * rough; a bumper trim is near-black and smooth; chrome is bright and fully
 * metallic; an indicator lens is small, saturated and orange. Bodywork is
 * whatever is left, which is the same default the named path uses.
 */
function classifyByLook({ rgb, metallic }) {
  if (!rgb) return CLS.PAINT;
  const [r, g, b] = rgb;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const max = Math.max(r, g, b);
  const sat = max > 0 ? (max - Math.min(r, g, b)) / max : 0;
  if (luma < 0.12) return CLS.DARK;
  if (sat > 0.55 && r >= g && g >= b) return CLS.LAMP;   // amber and red lenses
  if (metallic >= 0.7 && luma > 0.35) return CLS.CHROME;
  return CLS.PAINT;
}

export function classify(matName, look = null) {
  const n = (matName ?? '').toLowerCase();
  // A number-plate lamp is not a headlight, and on the GC8 it is the name
  // attached to fifty thousand triangles of car.
  if (/plate|number|placa|licen/.test(n)) return CLS.PAINT;
  if (INTERIOR.test(n)) return CLS.INSIDE;
  if (/light|lamp|farol|lanterna|blink|indicat/.test(n)) return CLS.LAMP;
  if (/glass|vidro|window|janela|screen|glazing|windshield/.test(n)) return CLS.GLASS;
  if (/tire|tyre|pneu|rubber|borracha|plastic|plastico|preto|black|seal|rim|roda|wheel|caliper|disc|grille|grelha|trim|espelho|mirror/.test(n)) return CLS.DARK;
  if (/chrome|crom|alumin|steel|inox|badge|emblem|bumper|parachoque/.test(n)) return CLS.CHROME;
  if (look && ANONYMOUS.test(n)) return classifyByLook(look);
  return CLS.PAINT;
}

export const isWheelName = (n) => /wheel|tyre|tire|rim|hub/i.test(n)
  && !/steer|fly ?wheel|arch|well|house|spare|cover/i.test(n);

/**
 * Tyre and rim geometry, recognised by its material rather than its node.
 *
 * Node names catch the wheels only when somebody named them, and the references
 * that need this most are the ones calling everything `Object_41`. Material
 * names do not have that problem, and the answer they give is dramatic: two
 * million of the Beetle's two point eight million triangles wear `Rubber_Blak`.
 * Four tyres were seventy per cent of the file, and every one of those
 * triangles would have been spent before the bodywork got any.
 *
 * Wheels are rebuilt by the generator from four measured numbers, so this is
 * budget reclaimed rather than detail lost.
 */
export const isWheelMaterial = (m) => /tire|tyre|pneu|borracha|rubber|\brim\b|hubcap|aro/i.test(m ?? '');

// When two classes meet on one triangle, the more particular one wins. Paint is
// what the rest of a car is, so it only takes a face nothing else claims.
export const RANK = [4, 0, 3, 1, 2];
