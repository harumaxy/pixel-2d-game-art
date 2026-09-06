import { describe, expect, test } from "bun:test";
import {
  bbox,
  boxDownscale,
  contrastDownscale,
  cornerKey,
  despeckle,
  hasAlpha,
  hflip,
  medianCut,
  luminanceRange,
  oklab,
  outline,
  placeOnSquare,
  stretchLevels,
  unionBox,
  quantize,
  removeBackground,
  removeShadow,
  type Rgba,
} from "./pixelate";

const GREY: [number, number, number] = [128, 128, 128];

/** w×h filled with `fill`, then `rects` painted over. */
function img(
  w: number,
  h: number,
  fill: number[],
  rects: { x: number; y: number; w: number; h: number; c: number[] }[] = [],
): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) data.set(r.c, (y * w + x) * 4);
  return { width: w, height: h, data };
}
const px = (i: Rgba, x: number, y: number) =>
  Array.from(i.data.slice((y * i.width + x) * 4, (y * i.width + x) * 4 + 4));

describe("hasAlpha", () => {
  test("true when any pixel is not fully opaque", () => {
    const i = img(4, 4, [...GREY, 255], [{ x: 0, y: 0, w: 1, h: 1, c: [0, 0, 0, 120] }]);
    expect(hasAlpha(i)).toBe(true);
  });
  test("false for an all-opaque render", () => {
    expect(hasAlpha(img(4, 4, [...GREY, 255]))).toBe(false);
  });
});

describe("removeBackground", () => {
  test("clears the backdrop and enclosed key-coloured gaps alike", () => {
    // 8x8 grey, red 4x4 box in the middle with a grey pixel inside it (a gap between legs)
    const i = img(
      8,
      8,
      [...GREY, 255],
      [
        { x: 2, y: 2, w: 4, h: 4, c: [255, 0, 0, 255] },
        { x: 3, y: 3, w: 1, h: 1, c: [...GREY, 255] },
      ],
    );
    const out = removeBackground(i, GREY, 40);
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 7, 7)[3]).toBe(0);
    expect(px(out, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(out, 3, 3)[3]).toBe(0); // enclosed grey goes too — it flickers white after quantize
  });
  test("tolerance", () => {
    const i = img(4, 4, [140, 130, 120, 255]);
    expect(px(removeBackground(i, GREY, 40), 0, 0)[3]).toBe(0);
    expect(px(removeBackground(i, GREY, 5), 0, 0)[3]).toBe(255);
  });
});

describe("removeShadow", () => {
  const KEY: [number, number, number] = [207, 198, 186]; // warm light grey backdrop
  const SHADOW = [140, 133, 125, 255]; // same hue, darker
  test("drops a shadow touching the cleared backdrop under the feet", () => {
    // 10x20 transparent backdrop, brown boot at rows 12-15, shadow blob at rows 16-17 touching it
    const i = img(
      10,
      20,
      [...KEY, 0],
      [
        { x: 4, y: 12, w: 2, h: 4, c: [90, 60, 40, 255] },
        { x: 2, y: 16, w: 6, h: 2, c: SHADOW },
      ],
    );
    const out = removeShadow(i, KEY);
    expect(px(out, 3, 16)[3]).toBe(0);
    expect(px(out, 7, 17)[3]).toBe(0);
    expect(px(out, 4, 13)).toEqual([90, 60, 40, 255]); // boot stays
  });
  test("leaves a neutral grey part in the upper body alone", () => {
    // grey gas-mask pixel at row 3, adjacent to the transparent backdrop
    const i = img(10, 20, [...KEY, 0], [{ x: 4, y: 3, w: 2, h: 2, c: SHADOW }]);
    const out = removeShadow(i, KEY);
    expect(px(out, 4, 3)[3]).toBe(255);
  });
  test("leaves a shadow-coloured pixel that is not connected to the backdrop", () => {
    const i = img(
      10,
      20,
      [...KEY, 0],
      [
        { x: 2, y: 14, w: 6, h: 4, c: [90, 60, 40, 255] },
        { x: 4, y: 16, w: 1, h: 1, c: SHADOW }, // enclosed by boot
      ],
    );
    expect(px(removeShadow(i, KEY), 4, 16)[3]).toBe(255);
  });
});

test("bbox of opaque pixels", () => {
  const i = img(8, 8, [0, 0, 0, 0], [{ x: 2, y: 3, w: 3, h: 2, c: [1, 2, 3, 255] }]);
  expect(bbox(i)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 5 });
  expect(bbox(img(2, 2, [0, 0, 0, 0]))).toBeUndefined();
});

test("luminanceRange ignores transparent pixels", () => {
  const i = img(
    4,
    1,
    [255, 255, 255, 0],
    [
      { x: 0, y: 0, w: 1, h: 1, c: [20, 20, 20, 255] },
      { x: 1, y: 0, w: 1, h: 1, c: [100, 100, 100, 255] },
    ],
  );
  expect(luminanceRange([i], 0, 1)).toEqual({ lo: 20, hi: 100 });
});

test("stretchLevels maps lo..hi onto the output range and clamps", () => {
  const i = img(
    3,
    1,
    [0, 0, 0, 255],
    [
      { x: 1, y: 0, w: 1, h: 1, c: [100, 100, 100, 255] },
      { x: 2, y: 0, w: 1, h: 1, c: [200, 200, 200, 255] },
    ],
  );
  const out = stretchLevels(i, 100, 200, 0.1, 0.9);
  expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]); // below lo clamps to 0
  expect(px(out, 1, 0).slice(0, 3)).toEqual([26, 26, 26]);
  expect(px(out, 2, 0).slice(0, 3)).toEqual([230, 230, 230]);
});

test("unionBox spans every box", () => {
  expect(
    unionBox([
      { x0: 2, y0: 3, x1: 5, y1: 5 },
      { x0: 1, y0: 4, x1: 4, y1: 9 },
    ]),
  ).toEqual({ x0: 1, y0: 3, x1: 5, y1: 9 });
  expect(unionBox([])).toBeUndefined();
});

test("placeOnSquare anchors the box's bottom-centre", () => {
  const i = img(8, 8, [0, 0, 0, 0], [{ x: 2, y: 3, w: 3, h: 2, c: [9, 9, 9, 255] }]);
  const out = placeOnSquare(i, bbox(i)!, 16, 2);
  // box becomes 6x4, bottom at y=16, centred: x 5..11, y 12..16
  expect(px(out, 5, 12)[3]).toBe(255);
  expect(px(out, 10, 15)[3]).toBe(255);
  expect(px(out, 4, 12)[3]).toBe(0);
  expect(px(out, 5, 11)[3]).toBe(0);
});

test("boxDownscale averages and binarises alpha", () => {
  const i = img(4, 4, [0, 0, 0, 0], [{ x: 0, y: 0, w: 2, h: 2, c: [200, 100, 0, 255] }]);
  const out = boxDownscale(i, 2);
  expect(px(out, 0, 0)).toEqual([200, 100, 0, 255]);
  expect(px(out, 1, 1)[3]).toBe(0);
  // half-covered cell: 2 of 4 pixels opaque -> alpha 255 (>= 50%)
  const j = img(4, 4, [0, 0, 0, 0], [{ x: 0, y: 0, w: 2, h: 1, c: [10, 20, 30, 255] }]);
  expect(px(boxDownscale(j, 2), 0, 0)).toEqual([10, 20, 30, 255]);
});

test("quantize snaps to nearest palette colour and leaves alpha", () => {
  const i = img(1, 2, [0, 0, 0, 0], [{ x: 0, y: 0, w: 1, h: 1, c: [250, 5, 5, 255] }]);
  const out = quantize(i, [
    [255, 0, 0],
    [0, 0, 255],
  ]);
  expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(px(out, 0, 1)[3]).toBe(0);
});

test("medianCut returns n colours from opaque pixels only", () => {
  const i = img(
    4,
    1,
    [0, 0, 0, 0],
    [
      { x: 0, y: 0, w: 2, h: 1, c: [255, 0, 0, 255] },
      { x: 2, y: 0, w: 2, h: 1, c: [0, 0, 255, 255] },
    ],
  );
  const pal = medianCut(i, 2).sort((a, b) => a[0] - b[0]);
  expect(pal).toEqual([
    [0, 0, 255],
    [255, 0, 0],
  ]);
});

test("hflip mirrors x", () => {
  const i = img(2, 1, [0, 0, 0, 0], [{ x: 0, y: 0, w: 1, h: 1, c: [7, 7, 7, 255] }]);
  expect(px(hflip(i), 1, 0)).toEqual([7, 7, 7, 255]);
  expect(px(hflip(i), 0, 0)[3]).toBe(0);
});

test("cornerKey takes the corner colour, ignoring one odd corner", () => {
  const i = img(4, 4, [200, 190, 180, 255], [{ x: 0, y: 0, w: 1, h: 1, c: [0, 0, 0, 255] }]);
  expect(cornerKey(i)).toEqual([200, 190, 180]);
});

describe("contrastDownscale", () => {
  const KHAKI = [150, 140, 100, 255];
  test("a thin dark line keeps its cell dark where the box mean would wash it out", () => {
    // 16x16 khaki with a 2px dark belt across rows 6-7: cells (y=0) cover rows 0-7
    const i = img(16, 16, KHAKI, [{ x: 0, y: 6, w: 16, h: 2, c: [30, 25, 20, 255] }]);
    const c = contrastDownscale(i, 2);
    const b = boxDownscale(i, 2);
    expect(px(c, 0, 0)[0]).toBeLessThan(60);
    expect(px(b, 0, 0)[0]).toBeGreaterThan(100);
    expect(px(c, 0, 1)).toEqual(KHAKI); // no line in the lower cells
  });
  test("half-cover alpha rule matches boxDownscale", () => {
    // rows 0-5 clear: the top cells are empty, the bottom cells are exactly half covered
    const i = img(8, 8, KHAKI, [{ x: 0, y: 0, w: 8, h: 6, c: [0, 0, 0, 0] }]);
    const c = contrastDownscale(i, 2);
    expect(px(c, 0, 0)[3]).toBe(0);
    expect(px(c, 0, 1)).toEqual(KHAKI);
  });
});

test("oklab: black, white and a grey are on the L axis, red is not", () => {
  expect(oklab(0, 0, 0)[0]).toBeCloseTo(0, 3);
  expect(oklab(255, 255, 255)[0]).toBeCloseTo(1, 3);
  const g = oklab(128, 128, 128);
  expect(Math.abs(g[1]) + Math.abs(g[2])).toBeLessThan(0.001);
  expect(oklab(255, 0, 0)[1]).toBeGreaterThan(0.2);
});

test("quantize picks the perceptually nearest palette entry", () => {
  // dark brown vs dark grey: RGB distance would tie-ish, Oklab keeps the hue
  const pal: [number, number, number][] = [
    [58, 58, 58],
    [74, 64, 56],
  ];
  const i = img(1, 1, [70, 58, 48, 255]);
  expect(px(quantize(i, pal), 0, 0)).toEqual([74, 64, 56, 255]);
});

describe("despeckle", () => {
  test("drops a crumb blob and recolours a lone odd pixel", () => {
    const RED = [255, 0, 0, 255],
      BLUE = [0, 0, 255, 255];
    const i = img(
      8,
      8,
      [0, 0, 0, 0],
      [
        { x: 1, y: 1, w: 3, h: 3, c: RED },
        { x: 2, y: 2, w: 1, h: 1, c: BLUE }, // blue speck inside red
        { x: 5, y: 5, w: 3, h: 1, c: BLUE }, // 3px crumb, off the body
      ],
    );
    const o = despeckle(i);
    expect(px(o, 2, 2)).toEqual(RED);
    expect(px(o, 6, 5)[3]).toBe(0);
    expect(px(o, 1, 1)).toEqual(RED);
  });
  test("keeps a blob of CRUMB pixels", () => {
    const i = img(8, 8, [0, 0, 0, 0], [{ x: 1, y: 1, w: 4, h: 1, c: [1, 2, 3, 255] }]);
    expect(px(despeckle(i), 4, 1)[3]).toBe(255);
  });
  test("leaves a 2px run of its own colour alone when it is part of the body", () => {
    const i = img(
      6,
      6,
      [0, 0, 0, 0],
      [
        { x: 0, y: 0, w: 6, h: 6, c: [9, 9, 9, 255] },
        { x: 1, y: 1, w: 2, h: 1, c: [1, 2, 3, 255] },
      ],
    );
    expect(px(despeckle(i), 1, 1)).toEqual([1, 2, 3, 255]);
  });
});

test("outline paints the 4-neighbourhood of the opaque area", () => {
  const i = img(5, 5, [0, 0, 0, 0], [{ x: 2, y: 2, w: 1, h: 1, c: [9, 9, 9, 255] }]);
  const o = outline(i, [1, 1, 1]);
  expect(px(o, 2, 1)).toEqual([1, 1, 1, 255]);
  expect(px(o, 1, 2)).toEqual([1, 1, 1, 255]);
  expect(px(o, 1, 1)[3]).toBe(0); // diagonal untouched
  expect(px(o, 2, 2)).toEqual([9, 9, 9, 255]);
});

test("placeOnSquare leaves `bottom` rows clear", () => {
  const i = img(4, 4, [1, 2, 3, 255]);
  const o = placeOnSquare(i, { x0: 0, y0: 0, x1: 4, y1: 4 }, 8, 1, 2);
  expect(px(o, 4, 5)[3]).toBe(255);
  expect(px(o, 4, 6)[3]).toBe(0);
});
