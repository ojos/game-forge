// render.mjs — 一覧の 1 項目を、パレット画像（画素）へ描く（#438）。

import { COLORS } from './variants.mjs';

/**
 * 1 項目を描く。パレットは [地, 墨, アンバー] の 3 色に固定する。
 * @param {import('./variants.mjs').Variant} v
 * @returns {import('./png.mjs').IndexedImage}
 */
export function renderVariant(v) {
  const gw = v.grid[0].length * v.scale;
  const gh = v.grid.length * v.scale;
  const width = v.width ?? gw;
  const height = v.height ?? gh;
  if (gw > width || gh > height) throw new Error(`${v.path}: 格子（${gw}×${gh}）が画像（${width}×${height}）に収まらない`);
  const ox = v.left ?? Math.floor((width - gw) / 2);
  if (ox < 0 || ox + gw > width) throw new Error(`${v.path}: 格子の左端 ${ox} では画像（幅 ${width}）からはみ出す`);
  const oy = Math.floor((height - gh) / 2);
  const ground = v.ground === 'transparent' ? 'transparent' : COLORS[v.ground];
  const palette = [ground, v.ink === 'light' ? COLORS.inkOnLight : COLORS.inkOnDark, COLORS.amber];
  const pixels = new Uint8Array(width * height);
  v.grid.forEach((row, gy) => {
    [...row].forEach((c, gx) => {
      if (c === '.') return;
      const index = c === 'K' ? 1 : c === 'A' ? 2 : -1;
      if (index < 0) throw new Error(`${v.path}: 格子に未知の記号 ${JSON.stringify(c)}`);
      for (let dy = 0; dy < v.scale; dy++) {
        pixels.fill(index, (oy + gy * v.scale + dy) * width + ox + gx * v.scale, (oy + gy * v.scale + dy) * width + ox + (gx + 1) * v.scale);
      }
    });
  });
  return { width, height, palette, pixels };
}
