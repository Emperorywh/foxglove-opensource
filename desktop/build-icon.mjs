// Generates the Windows app icon (resources/icon.ico) from a PNG source.
//
// electron-builder requires a real .ico containing a 256x256 image. public/favicon.ico
// cannot be used directly: it is only 74x51 and is actually a mislabeled PNG, not an
// ICO container. This script decodes the source PNG (pure Node, no native deps),
// pads it to a square canvas, resizes with premultiplied-alpha filtering, and wraps
// PNG-compressed frames (256/48/32/16) into a single .ico. It also writes
// installerIcon.ico / uninstallerIcon.ico, which electron-builder's NSIS target picks
// up from the buildResources directory automatically.
//
//   node build-icon.mjs [source.png] [output.ico]
//
// Defaults: ../packages/studio-web/public/apple-touch-icon.png -> resources/icon.ico
// (same logo as the favicon, but square and 180x180 instead of 74x51).

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { deflateSync, inflateSync } from "zlib";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  process.argv[2] ??
    path.join(desktopDir, "..", "packages", "studio-web", "public", "apple-touch-icon.png"),
);
const outPath = path.resolve(process.argv[3] ?? path.join(desktopDir, "resources", "icon.ico"));

const ICON_SIZES = [256, 48, 32, 16];

// ---- PNG decode (8-bit RGB/RGBA, non-interlaced). Returns premultiplied float RGBA. ----

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${sourcePath} is not a PNG file`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Float64Array(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? recon[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0:
          v = line[x];
          break;
        case 1:
          v = line[x] + a;
          break;
        case 2:
          v = line[x] + b;
          break;
        case 3:
          v = line[x] + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      recon[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      const alpha = (bpp === 4 ? recon[si + 3] : 255) / 255;
      out[di] = (recon[si] / 255) * alpha;
      out[di + 1] = (recon[si + 1] / 255) * alpha;
      out[di + 2] = (recon[si + 2] / 255) * alpha;
      out[di + 3] = alpha;
    }
    prev = recon;
  }
  return { data: out, width, height };
}

// ---- transforms (all operate on premultiplied float RGBA) ----

function padToSquare(img) {
  const size = Math.max(img.width, img.height);
  if (img.width === size && img.height === size) {
    return img;
  }
  const out = new Float64Array(size * size * 4);
  const ox = Math.floor((size - img.width) / 2);
  const oy = Math.floor((size - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const di = ((y + oy) * size + (x + ox)) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { data: out, width: size, height: size };
}

function resize(img, tw, th) {
  const { data: src, width: sw, height: sh } = img;
  const out = new Float64Array(tw * th * 4);
  const scaleX = sw / tw;
  const scaleY = sh / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const di = (y * tw + x) * 4;
      if (scaleX <= 1 && scaleY <= 1) {
        // bilinear for upscaling
        const fx = (x + 0.5) * scaleX - 0.5;
        const fy = (y + 0.5) * scaleY - 0.5;
        const x0 = Math.max(0, Math.floor(fx));
        const y0 = Math.max(0, Math.floor(fy));
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const wx = Math.min(1, Math.max(0, fx - x0));
        const wy = Math.min(1, Math.max(0, fy - y0));
        for (let c = 0; c < 4; c++) {
          const v00 = src[(y0 * sw + x0) * 4 + c];
          const v10 = src[(y0 * sw + x1) * 4 + c];
          const v01 = src[(y1 * sw + x0) * 4 + c];
          const v11 = src[(y1 * sw + x1) * 4 + c];
          out[di + c] =
            (v00 * (1 - wx) + v10 * wx) * (1 - wy) + (v01 * (1 - wx) + v11 * wx) * wy;
        }
      } else {
        // box average over the covered source rect for downscaling
        const rx0 = x * scaleX;
        const rx1 = (x + 1) * scaleX;
        const ry0 = y * scaleY;
        const ry1 = (y + 1) * scaleY;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let area = 0;
        for (let sy = Math.floor(ry0); sy < Math.ceil(ry1); sy++) {
          for (let sx = Math.floor(rx0); sx < Math.ceil(rx1); sx++) {
            const w = Math.min(rx1, sx + 1) - Math.max(rx0, sx);
            const h = Math.min(ry1, sy + 1) - Math.max(ry0, sy);
            const weight = w * h;
            const si = (sy * sw + sx) * 4;
            r += src[si] * weight;
            g += src[si + 1] * weight;
            b += src[si + 2] * weight;
            a += src[si + 3] * weight;
            area += weight;
          }
        }
        out[di] = r / area;
        out[di + 1] = g / area;
        out[di + 2] = b / area;
        out[di + 3] = a / area;
      }
    }
  }
  return { data: out, width: tw, height: th };
}

// ---- PNG encode (8-bit RGBA, filter "none") ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(img) {
  const { data, width, height } = img;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (stride + 1) + 1 + x * 4;
      const alpha = data[si + 3];
      const unpremultiply = (v) =>
        Math.round(Math.min(1, Math.max(0, alpha > 0 ? v / alpha : 0)) * 255);
      raw[di] = unpremultiply(data[si]);
      raw[di + 1] = unpremultiply(data[si + 1]);
      raw[di + 2] = unpremultiply(data[si + 2]);
      raw[di + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO container ----

function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const entries = Buffer.alloc(16 * frames.length);
  let dataOffset = 6 + 16 * frames.length;
  frames.forEach(({ size, png }, i) => {
    const o = i * 16;
    entries[o] = size >= 256 ? 0 : size; // 0 means 256
    entries[o + 1] = size >= 256 ? 0 : size;
    entries[o + 2] = 0; // palette colors
    entries[o + 3] = 0; // reserved
    entries.writeUInt16LE(1, o + 4); // color planes
    entries.writeUInt16LE(32, o + 6); // bits per pixel
    entries.writeUInt32LE(png.length, o + 8);
    entries.writeUInt32LE(dataOffset, o + 12);
    dataOffset += png.length;
  });
  return Buffer.concat([header, entries, ...frames.map((f) => f.png)]);
}

// ---- main ----

const source = padToSquare(decodePng(readFileSync(sourcePath)));
console.log(`source: ${sourcePath} (padded to ${source.width}x${source.height})`);

const frames = ICON_SIZES.map((size) => ({ size, png: encodePng(resize(source, size, size)) }));
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, buildIco(frames));

// electron-builder picks these up from buildResources for the NSIS installer/uninstaller
copyFileSync(outPath, path.join(path.dirname(outPath), "installerIcon.ico"));
copyFileSync(outPath, path.join(path.dirname(outPath), "uninstallerIcon.ico"));

console.log(`wrote ${outPath} (sizes: ${ICON_SIZES.join("/")}) + installerIcon.ico + uninstallerIcon.ico`);
