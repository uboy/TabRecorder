/**
 * generate-icons.js
 *
 * Generates minimal valid PNG icon files required by manifest.json.
 * Run once before loading the extension:
 *
 *   node scripts/generate-icons.js
 *
 * Output:
 *   icons/icon32.png   — 32×32 red circle on dark background
 *   icons/icon128.png  — 128×128 red circle on dark background
 *
 * This script has zero npm dependencies. It writes raw PNG bytes using
 * Node's built-in `zlib` for DEFLATE compression and `crypto` for CRC-32.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

// ─── PNG encoder ──────────────────────────────────────────────────────────────

/**
 * Compute PNG CRC-32 for a chunk type + data buffer.
 * PNG uses CRC-32 with the standard polynomial 0xEDB88320.
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/**
 * Build a single PNG chunk: length(4) + type(4) + data + crc(4).
 * @param {string} type   4-character ASCII chunk type
 * @param {Buffer} data
 */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcValue  = uint32BE(crc32(crcInput));
  return Buffer.concat([uint32BE(data.length), typeBytes, data, crcValue]);
}

/**
 * Encode a raw RGBA pixel array into a valid PNG file buffer.
 *
 * @param {number}   width
 * @param {number}   height
 * @param {Buffer}   rgba  — width * height * 4 bytes (RGBA)
 * @returns {Buffer}
 */
function encodePNG(width, height, rgba) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: width(4), height(4), bitDepth(1)=8, colorType(1)=2(RGB) or 6(RGBA),
  // compression(1)=0, filter(1)=0, interlace(1)=0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 6;  // color type: RGBA
  ihdrData[10] = 0;  // compression method: deflate
  ihdrData[11] = 0;  // filter method: adaptive
  ihdrData[12] = 0;  // interlace: none
  const ihdr = pngChunk('IHDR', ihdrData);

  // Build raw filtered image data (filter type 0 = None per scanline)
  const scanlineSize = 1 + width * 4; // 1 filter byte + 4 bytes per pixel
  const rawData = Buffer.alloc(height * scanlineSize);
  for (let y = 0; y < height; y++) {
    rawData[y * scanlineSize] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const dstOff = y * scanlineSize + 1 + x * 4;
      rawData[dstOff]     = rgba[srcOff];     // R
      rawData[dstOff + 1] = rgba[srcOff + 1]; // G
      rawData[dstOff + 2] = rgba[srcOff + 2]; // B
      rawData[dstOff + 3] = rgba[srcOff + 3]; // A
    }
  }

  // Compress with DEFLATE (zlib)
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idat       = pngChunk('IDAT', compressed);

  // IEND chunk (always empty)
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ─── Icon pixel generator ─────────────────────────────────────────────────────

/**
 * Generate RGBA pixel data for a red circle on a dark navy background.
 *
 * @param {number} size  — icon dimensions in pixels (square)
 * @returns {Buffer}      size * size * 4 bytes
 */
function generateIconPixels(size) {
  const rgba   = Buffer.alloc(size * size * 4);
  const cx     = size / 2;
  const cy     = size / 2;
  const radius = size * 0.38; // circle radius (leaves a small margin)
  const rSq    = radius * radius;

  // Background: #1a1a2e (dark navy), full opacity
  const bgR = 0x1a, bgG = 0x1a, bgB = 0x2e;
  // Circle fill: #cc2222 (strong red), full opacity
  const fgR = 0xcc, fgG = 0x22, fgB = 0x22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx  = x - cx + 0.5; // sample at pixel center
      const dy  = y - cy + 0.5;
      const off = (y * size + x) * 4;

      // Simple anti-alias: sample 4 sub-pixels
      let covered = 0;
      for (const sx of [-0.25, 0.25]) {
        for (const sy of [-0.25, 0.25]) {
          if ((dx + sx) ** 2 + (dy + sy) ** 2 <= rSq) covered++;
        }
      }
      const alpha = covered / 4; // 0, 0.25, 0.5, 0.75, or 1.0

      if (alpha > 0) {
        // Blend fg over bg
        rgba[off]     = Math.round(fgR * alpha + bgR * (1 - alpha));
        rgba[off + 1] = Math.round(fgG * alpha + bgG * (1 - alpha));
        rgba[off + 2] = Math.round(fgB * alpha + bgB * (1 - alpha));
        rgba[off + 3] = 255;
      } else {
        rgba[off]     = bgR;
        rgba[off + 1] = bgG;
        rgba[off + 2] = bgB;
        rgba[off + 3] = 255;
      }
    }
  }

  return rgba;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const iconsDir = path.join(__dirname, '..', 'icons');
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  const sizes = [32, 128];
  for (const size of sizes) {
    const pixels  = generateIconPixels(size);
    const pngData = encodePNG(size, size, pixels);
    const outPath = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(outPath, pngData);
    console.log(`Generated ${outPath} (${pngData.length} bytes)`);
  }

  console.log('Icons generated successfully.');
}

main();
