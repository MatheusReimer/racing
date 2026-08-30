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
// A mark is a sphere in the body's own coordinates, not a list of triangle
// indices. An index dies the moment anyone re-bakes a hull — and re-baking is
// a live possibility — while a point in space is a statement about the *car*
// rather than about one triangulation of it. It also reads in a diff.

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

/**
 * Apply marks to a class per face.
 *
 * @param classes  one class per triangle, edited in place
 * @param centres  {cx, cy, cz} face centres in body coordinates
 * @param marks    [{ at: [x, y, z], r, is }]
 * @returns how many faces a person's hand moved
 */
export function applyMarks(classes, centres, marks) {
  if (!marks?.length) return 0;
  const { cx, cy, cz } = centres;
  let moved = 0;
  for (const m of marks) {
    const cls = MARK_KINDS[m.is];
    if (cls === undefined || !Array.isArray(m.at)) continue;
    const [mx, my, mz] = m.at;
    const r2 = (m.r ?? 0.08) ** 2;
    // Mirrored unless the mark says otherwise: a car is symmetric, and marking
    // one indicator and not the other is a job half done every time.
    const sides = m.mirror === false ? [1] : [1, -1];
    for (let t = 0; t < classes.length; t++) {
      if (classes[t] === cls) continue;
      for (const s of sides) {
        const dx = cx[t] - mx * s;
        const dy = cy[t] - my;
        const dz = cz[t] - mz;
        if (dx * dx + dy * dy + dz * dz <= r2) { classes[t] = cls; moved++; break; }
      }
    }
  }
  return moved;
}
