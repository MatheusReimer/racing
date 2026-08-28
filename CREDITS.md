# Credits

## Car bodies

The files in `public/bodies/` are not modelled here. Each one is a real car's
own surface, collapsed to a triangle budget by `tools/decimate.mjs` — the
reference's geometry with fewer vertices in it. That is derivative work, and
the licence travels with it.

| body | reference | author | licence |
| --- | --- | --- | --- |
| `hatch` | 1997 Peugeot 205 GTI | Maroi Mister | CC BY |
| `coupe` | 1999 Nissan Silvia S15 Spec-S | Ddiaz Design | CC BY-NC-SA |
| `rotary` | 1999 Mazda RX-7 FD | OUTPISTON | CC BY-NC-SA |
| `gt` | 1982 Audi Quattro B2 | OUTPISTON | CC BY-NC-SA |
| `roadster` | 1989 Mazda MX-5 (NA) | Res1n | CC BY |
| `rally` | Subaru Impreza WRX STi (GC8) | Mona x Supercars | CC BY |
| `beetle` | early-fifties VW Beetle | Parasar2022 | CC BY |

All seven require attribution, which is what this file is for.

**Three are NonCommercial and ShareAlike**, and that binds the game they ship
in rather than only this table: `coupe`, `rotary` and `gt`. As long as those
files are in the repository, the project cannot be sold, and a ShareAlike
obligation attaches to it. If this is ever meant to be commercial they have to
be replaced — with another reference under a permissive licence, or with a body
generated rather than decimated — and the longer their surfaces stay, the more
of the game is tuned around them.

`tools/silhouette.mjs` is the other way to use a reference: it measures one into
about twenty numbers a generator is steered by. Those numbers are facts about a
car — 4.06 m long because the thing it was measured from is — and carry no
licence. Nothing in `public/bodies/` came from that path.

The reference models themselves are not in this repository (`refs/` is ignored).
