Hand marks: what a person says a part of a car is, where the reference could
not say it clearly enough.

One file per body, named for the body. Written by /paint.html (npm run dev),
read at boot alongside the hulls. Empty or missing means "nothing to correct",
which is the normal case.

A mark is a sphere in the body's own coordinates — the same space
public/bodies/<name>.bin stores its positions in — and NOT a list of triangle
indices. An index dies the moment anyone re-bakes a hull; a point in space is a
statement about the car rather than about one triangulation of it, and survives.
