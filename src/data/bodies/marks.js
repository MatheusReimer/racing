// What a person says a part of a car is.
//
// The classifier reads material names and colours, and on a thirty-year-old
// model that gets you `carpaint`, `black`, `chrome` and — for a hundred and
// sixty thousand triangles of the MX-5 — `material`. No rule written here can
// know that one patch of `material` is an indicator lens and the next is a
// wing. A person looking at the car knows instantly.
//
// So this is the override, and it wins over everything the code decides on its
// own: the symmetry pass, the needle pass, the classifier itself. If somebody
// said that spot is dark, it is dark.
//
// A mark is a crate and a rule:
//
//   { box: [x0, y0, z0, x1, y1, z1], from: 'chrome', is: 'paint' }
//
// — "the chrome in this crate is paint". `from` is the half that matters. What
// a reference gets wrong is scattered *through* a panel rather than covering
// it: a quarter of the MX-5's faces come out chrome, in slivers lying across
// yellow bodywork, and the wing they lie on is already right. A mark without
// `from` flattens the crate to one class and takes the good faces with the bad;
// with it, the same crate can be drawn coarsely — a whole wing, both doors —
// and still only touch what was wrong. Coarse and precise at once, which no
// shape alone can be.
//
// The crate is why this is not a ball. A ball big enough to hold a panel is
// also deep enough to reach through the car: measured, a 60 cm ball on the
// MX-5's bonnet took the wing, the door, the interior and the far side of the
// car with it. A crate has six faces you can put where the panel ends, and can
// be flattened to the thickness of the panel itself.
//
// Coordinates are the body's own — the same space public/bodies/<name>.bin
// stores its positions in — and NOT triangle indices. An index dies the moment
// anyone re-bakes a hull, and re-baking is a live possibility, while a box in
// space is a statement about the *car* rather than about one triangulation of
// it. It also reads in a diff.

/** What a mark can say. `remove` deletes the faces instead of recolouring. */
export const MARK_KINDS = {
  paint: 0, glass: 1, dark: 2, chrome: 3, lamp: 4, remove: 5,
};

/** Loaded marks, by body name. Filled by `loadMarks`, or by a tool off disk. */
export const MARKS = {};

/**
 * Read the mark files that exist. A body with none is the normal case, so a
 * 404 is not an error — it is the answer.
 */
export async function loadMarks(names, base = 'marks/') {
  await Promise.all(names.map(async (n) => {
    try {
      const res = await fetch(`${base}${n}.json`);
      if (!res.ok) return;
      const marks = await res.json();
      if (Array.isArray(marks) && marks.length) MARKS[n] = marks;
    } catch {
      // No marks for this body. That is most of them.
    }
  }));
  return MARKS;
}

/** A mark's crate, corners sorted, or null if the mark cannot be read. */
export function boxOf(m) {
  const b = m?.box;
  if (!Array.isArray(b) || b.length !== 6 || b.some((v) => !Number.isFinite(v))) return null;
  return [
    Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]),
    Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5]),
  ];
}

/**
 * Which classes a mark is allowed to change. `null` is every one of them.
 *
 * A `from` naming nothing the classifier can emit returns a mask that matches
 * nothing, rather than falling back to "anything": a typo in a mark file should
 * do nothing at all, not repaint the whole crate.
 */
function fromOf(m) {
  if (m.from == null) return null;
  const names = Array.isArray(m.from) ? m.from : [m.from];
  const mask = new Uint8Array(6);
  for (const n of names) {
    const c = MARK_KINDS[n];
    if (c !== undefined) mask[c] = 1;
  }
  return mask;
}

/**
 * One mark against one class array.
 *
 * @param write  false to count what it would move without moving it, which is
 *               what the editor shows before you commit to a crate.
 * @returns how many faces the mark moves
 */
function applyOne(classes, centres, m, write) {
  const cls = MARK_KINDS[m?.is];
  const box = boxOf(m);
  if (cls === undefined || !box) return 0;
  const only = fromOf(m);
  const { cx, cy, cz } = centres;
  // Mirrored unless the mark says otherwise: a car is symmetric, and marking
  // one indicator and not the other is a job half done every time.
  const mirror = m.mirror !== false;
  let moved = 0;
  for (let t = 0; t < classes.length; t++) {
    const c = classes[t];
    if (c === cls) continue;
    if (only && !only[c]) continue;
    // y and z first: they reject most of the car before x has to think about
    // which side of it we are on.
    if (cy[t] < box[1] || cy[t] > box[4] || cz[t] < box[2] || cz[t] > box[5]) continue;
    const x = cx[t];
    if (!((x >= box[0] && x <= box[3]) || (mirror && -x >= box[0] && -x <= box[3]))) continue;
    if (write) classes[t] = cls;
    moved++;
  }
  return moved;
}

/**
 * Apply marks to a class per face, in order — a later mark sees what an earlier
 * one did, so a crate can be corrected by a smaller crate laid over it.
 *
 * @param classes  one class per triangle, edited in place
 * @param centres  {cx, cy, cz} face centres in body coordinates
 * @param marks    [{ box: [x0,y0,z0,x1,y1,z1], is, from?, mirror? }]
 * @returns how many faces a person's hand moved
 */
export function applyMarks(classes, centres, marks) {
  let moved = 0;
  for (const m of marks ?? []) moved += applyOne(classes, centres, m, true);
  return moved;
}

/** How many faces a mark would move, without moving them. For the editor. */
export function countMark(classes, centres, mark) {
  return applyOne(classes, centres, mark, false);
}
