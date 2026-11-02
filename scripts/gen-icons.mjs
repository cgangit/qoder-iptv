// 生成 webOS 应用图标：把 assets/app-icon-src.png 整幅等比缩放到目标尺寸。
//   icon.png      80x80
//   largeIcon.png 130x130
// 不依赖任何第三方库，使用 Node 内置 zlib 手写 PNG 解码/编码。
// 素材需为方形、可带透明通道；透明区域原样保留，不额外做圆角蒙版。
// 运行：node scripts/gen-icons.mjs  （已挂到 npm 的 prebuild / predev）
import { deflateSync, inflateSync } from 'zlib';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'assets/app-icon-src.png');

/* ---------------- PNG 编解码基础 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 解码 PNG，返回 { width, height, rgba }。仅支持 8bit 非隔行的 RGB/RGBA/灰度。
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error('仅支持 8bit 位深，当前为 ' + depth);
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = px.slice(y * stride, y * stride + stride);
    const prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[i] = v & 0xff;
    }
  }

  // 统一展开成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = px[s + 1];
    } else if (channels === 3) {
      rgba[d] = px[s];
      rgba[d + 1] = px[s + 1];
      rgba[d + 2] = px[s + 2];
      rgba[d + 3] = 255;
    } else {
      px.copy(rgba, d, s, s + 4);
    }
  }
  return { width, height, rgba };
}

/* ---------------- 缩放 ---------------- */

// 面积平均缩放（box filter），按 alpha 预乘避免透明边缘渗色。
// 源图整体等比缩放进 out×out 画布并居中；多余区域透明。
function resizeToSquare(src, out) {
  const dst = Buffer.alloc(out * out * 4);
  const scale = Math.min(out / src.width, out / src.height);
  const drawW = src.width * scale;
  const drawH = src.height * scale;
  const offX = (out - drawW) / 2;
  const offY = (out - drawH) / 2;

  for (let dy = 0; dy < out; dy++) {
    const sy0 = (dy - offY) / scale;
    const sy1 = (dy + 1 - offY) / scale;
    if (sy1 <= 0 || sy0 >= src.height) continue;
    const iy0 = Math.max(0, Math.floor(sy0));
    const iy1 = Math.min(src.height - 1, Math.ceil(sy1) - 1);

    for (let dx = 0; dx < out; dx++) {
      const sx0 = (dx - offX) / scale;
      const sx1 = (dx + 1 - offX) / scale;
      if (sx1 <= 0 || sx0 >= src.width) continue;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(src.width - 1, Math.ceil(sx1) - 1);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        for (let sx = ix0; sx <= ix1; sx++) {
          const i = (sy * src.width + sx) * 4;
          const alpha = src.rgba[i + 3] / 255;
          r += src.rgba[i] * alpha;
          g += src.rgba[i + 1] * alpha;
          b += src.rgba[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      if (!n || a === 0) continue;
      const d = (dy * out + dx) * 4;
      dst[d] = Math.round(r / a);
      dst[d + 1] = Math.round(g / a);
      dst[d + 2] = Math.round(b / a);
      dst[d + 3] = Math.round((a / n) * 255);
    }
  }
  return dst;
}

/* ---------------- 主流程 ---------------- */

function main() {
  if (!existsSync(SRC)) {
    console.error('[gen-icons] 缺少图标素材：assets/app-icon-src.png');
    process.exit(1);
  }
  const src = decodePNG(readFileSync(SRC));
  console.log(`[gen-icons] 素材 ${src.width}x${src.height}`);

  for (const [file, size] of [
    ['icon.png', 80],
    ['largeIcon.png', 130]
  ]) {
    const rgba = resizeToSquare(src, size);
    writeFileSync(resolve(ROOT, file), encodePNG(size, size, rgba));
    console.log(`[gen-icons] ${file} (${size}x${size}) 已生成`);
  }
}

main();
