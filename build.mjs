/**
 * build.mjs — builds the loadable extension into dist/.
 *
 * Responsibilities:
 *  - Bundle the three entry points with esbuild (page world, content script, popup).
 *  - Copy static assets (manifest, popup html/css).
 *  - Generate the extension icons programmatically (no binary assets in the repo).
 *
 * Failure behavior: any error aborts the build with a non-zero exit code; a partial
 * dist/ is never a valid install target — rerun `npm run build` after fixing.
 */
import * as esbuild from "esbuild";
import { mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dist = path.join(root, "dist");

/* ---------------------------------------------------------------- bundles */

const common = {
  bundle: true,
  format: "iife",
  target: "chrome111", // MV3 `world: "MAIN"` content scripts require Chrome 111+
  sourcemap: false,
  logLevel: "info",
};

async function bundle() {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "src/page/index.ts")],
    outfile: path.join(dist, "page.js"),
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "src/content/index.ts")],
    outfile: path.join(dist, "content.js"),
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, "src/popup/popup.ts")],
    outfile: path.join(dist, "popup/popup.js"),
  });
}

/* ------------------------------------------------------------------ icons */
/**
 * Minimal PNG encoder (truecolor RGBA, no interlace) — enough to emit the
 * extension icons without committing binaries or adding dependencies.
 */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels /* Uint8Array RGBA */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((v, i) => {
      raw[y * (size * 4 + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Draws the icon: warm terracotta rounded square, an off-white trunk line with
 * a fork — a literal "prompt tree".
 */
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const bg = [0xd9, 0x77, 0x57]; // warm accent
  const fg = [0xfa, 0xf5, 0xef]; // warm off-white
  const r = size * 0.22; // corner radius
  const setPx = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgb[0];
    px[i + 1] = rgb[1];
    px[i + 2] = rgb[2];
    px[i + 3] = a;
  };
  const insideRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (insideRounded(x, y)) setPx(x, y, bg);

  const dot = (fx, fy, fr) => {
    const cx = fx * size, cy = fy * size, rr = fr * size;
    for (let y = Math.floor(cy - rr); y <= cy + rr; y++)
      for (let x = Math.floor(cx - rr); x <= cx + rr; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) setPx(x, y, fg);
  };
  const line = (x0, y0, x1, y1, w) => {
    const steps = size * 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      dotAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w);
    }
  };
  const dotAt = (fx, fy, fr) => dot(fx, fy, fr);
  // trunk with one fork: root bottom-center, splits to two upper nodes
  line(0.5, 0.78, 0.5, 0.5, 0.045);
  line(0.5, 0.5, 0.32, 0.28, 0.045);
  line(0.5, 0.5, 0.68, 0.28, 0.045);
  dot(0.5, 0.78, 0.09);
  dot(0.32, 0.28, 0.09);
  dot(0.68, 0.28, 0.09);
  return encodePng(size, px);
}

/* ------------------------------------------------------------------- main */

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "icons"), { recursive: true });
  await mkdir(path.join(dist, "popup"), { recursive: true });
  await bundle();
  await copyFile(path.join(root, "src/manifest.json"), path.join(dist, "manifest.json"));
  await copyFile(path.join(root, "src/popup/popup.html"), path.join(dist, "popup/popup.html"));
  await copyFile(path.join(root, "src/popup/popup.css"), path.join(dist, "popup/popup.css"));
  for (const size of [16, 48, 128]) {
    await writeFile(path.join(dist, `icons/icon${size}.png`), drawIcon(size));
  }
  console.log("Built dist/ — load it as an unpacked extension.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
