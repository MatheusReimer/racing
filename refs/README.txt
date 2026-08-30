Reference car models. Ignored by git, and deliberately: they are other
people's work, three of them NonCommercial, and the repository ships the
decimated result in public/bodies/ rather than the source.

This directory was lost once already, and with it the provenance. If it goes
again, CREDITS.md and this file are what let it be rebuilt: every model below
was found back on Sketchfab by title and author, and confirmed by its triangle
count against the numbers recorded in the commits that baked the hulls.

  body      model                                author              tris    licence
  hatch     1997 Peugeot 205 GTI                 Maroi Mister        244.2k  CC BY
  coupe     1999 Nissan Silvia S15 Spec-S Aero   Ddiaz Design        164k    CC BY-NC-SA
  rotary    1999 Mazda RX-7 FD                   OUTPISTON           650.3k  CC BY-NC-SA
  gt        1982 Audi Quattro B2                 OUTPISTON            48.8k  CC BY-NC-SA
  roadster  1989 Mazda MX-5 (NA)                 Res1n                 1.1M  CC BY
  rally     Impreza WRX STi Version VI (GC8)     Mona x Supercars    155.7k  CC BY
  beetle    VW Beetle                            Parasar2022           2.8M  CC BY

  hatch     https://sketchfab.com/3d-models/1997-peugeot-205-gti-e1f8335a73a9442eb06ff8624718ac76
  coupe     https://sketchfab.com/3d-models/1999-nissan-silvia-s15-spec-s-aero-b520fe10c0374d168ab349dc6528e5af
  rotary    https://sketchfab.com/3d-models/1999-mazda-rx-7-fd-6ea4245c67c1438189fe37ca91516d78
  gt        https://sketchfab.com/3d-models/1982-audi-quattro-b2-a6eff52559b04aeaa99a6305a0ef8029
  roadster  https://sketchfab.com/3d-models/1989-mazda-mx-5-na-bd6429f3d02a426f9a714a66c33bb353
  rally     https://sketchfab.com/3d-models/subaru-impreza-wrx-sti-version-vi-gc8-457f01e7e8d14b088e3f092c1be9e75c
  beetle    https://sketchfab.com/3d-models/vw-beetle-94fb019aff254873914f39b830953e30

<body>.glb is the file the tools read — tools/lib/model.mjs handles .glb, .obj
and .stl, and only the glTF path carries material names, colours and alpha,
which is the whole input the classifier has. An .obj read here comes back with
`mat: ''` and `rgb: null`, so it is not a substitute.

original/<body>/ is the author's own upload, for editing rather than for the
pipeline. What that is varies, and so does whether it has quads — glTF and GLB
store triangles only, by specification, so where the author uploaded one of
those there is no quad version of that car anywhere:

  hatch     scene.gltf              triangles only
  coupe     FINAL_MODEL.fbx         format holds quads; not counted here
  rotary    .glb                    triangles only
  gt        .glb                    triangles only
  roadster  .obj    566,177 quads,  13,313 tris,     42 n-gons
  rally     .obj              0 quads, 155,652 tris
  beetle    .obj  1,410,355 quads,      824 tris,  1,109 n-gons
