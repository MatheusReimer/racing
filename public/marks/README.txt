Hand marks: what a person says a part of a car is, where the reference could
not say it clearly enough.

One file per body, named for the body. Written by /paint.html (npm run dev,
then /paint.html?car=<body>), read at boot alongside the hulls. Empty or
missing means "nothing to correct", which is the normal case.

A mark is a crate and a rule:

  { "box": [x0, y0, z0, x1, y1, z1], "from": "chrome", "is": "paint" }

— "the chrome in this crate is paint". Coordinates are the body's own, the same
space public/bodies/<name>.bin stores its positions in, and NOT triangle
indices: an index dies the moment anyone re-bakes a hull, while a box in space
is a statement about the car rather than about one triangulation of it.

"from" is the half that does the work. What a reference gets wrong is scattered
through a panel rather than covering it — a quarter of the MX-5's faces come
out chrome, in slivers lying across bodywork that is already right — so the
crate is drawn coarsely, round the whole wing, and the filter keeps it off the
faces that were correct. Leave "from" out and the whole crate becomes one class.

Mirrored in x unless the mark says "mirror": false. A car is symmetric, and
marking one indicator and not the other is a job half done every time.
