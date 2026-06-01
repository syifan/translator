// Generates resources/trayTemplate.png (+ @2x) — a small caption-bubble glyph
// drawn as a black template image (macOS recolors it for the menu bar).
// Pure Node (zlib for PNG IDAT); no native deps.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0)
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    rgba[(y * size + x) * 4 + 3] = a // black with alpha
  }

  const pad = Math.round(size * 0.1)
  const left = pad
  const right = size - pad
  const top = pad
  const bot = Math.round(size * 0.7)
  const r = Math.round(size * 0.2)

  const inBubble = (x, y) => {
    if (x < left || x > right || y < top || y > bot) return false
    if (x < left + r && y < top + r) return (x - (left + r)) ** 2 + (y - (top + r)) ** 2 <= r * r
    if (x > right - r && y < top + r) return (x - (right - r)) ** 2 + (y - (top + r)) ** 2 <= r * r
    if (x < left + r && y > bot - r) return (x - (left + r)) ** 2 + (y - (bot - r)) ** 2 <= r * r
    if (x > right - r && y > bot - r) return (x - (right - r)) ** 2 + (y - (bot - r)) ** 2 <= r * r
    return true
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let on = inBubble(x, y)
      // little tail at bottom-left
      const tailTop = bot - 1
      const tailX0 = left + Math.round(size * 0.16)
      if (y >= tailTop && y <= bot + Math.round(size * 0.16)) {
        const dy = y - tailTop
        if (x >= tailX0 && x <= tailX0 + Math.round(size * 0.2) - dy) on = true
      }
      if (on) set(x, y, 255)
    }
  }

  // Knock out two caption "lines" (set alpha back to 0).
  const lineH = Math.max(1, Math.round(size * 0.08))
  const lx0 = left + Math.round(size * 0.16)
  const lx1 = right - Math.round(size * 0.16)
  const ly1 = top + Math.round((bot - top) * 0.34)
  const ly2 = top + Math.round((bot - top) * 0.6)
  for (const ly of [ly1, ly2]) {
    for (let y = ly; y < ly + lineH; y++) {
      for (let x = lx0; x <= lx1; x++) set(x, y, 0)
    }
  }

  return encodePng(size, size, rgba)
}

const out = join(here, '..', 'resources')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'trayTemplate.png'), drawIcon(16))
writeFileSync(join(out, 'trayTemplate@2x.png'), drawIcon(32))
console.log('Wrote tray icons to', out)
