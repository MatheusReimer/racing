// Low-poly hulls traced off reference cars by tools/lowpoly.mjs.
//
// One entry per body type that has a real car behind it. `BODY_TYPES` in
// chassis.js still supplies how a build stretches a car around; these supply
// what it is a car *of*. A body type with no hull here falls back to the
// generated silhouette.
//
// These are derivative geometry, not measurements, so the reference's licence
// reaches the game: 205 GTI, MX-5 (NA), Impreza GC8 and the Beetle are CC-BY
// and need crediting; the S15 is CC BY-NC-SA, which is non-commercial and
// share-alike. refs/README.txt has the provenance.
import hatch from './hatch.js';
import coupe from './coupe.js';
import roadster from './roadster.js';
import rally from './rally.js';
import beetle from './fusca.js';

export const HULLS = { hatch, coupe, roadster, rally, beetle };
