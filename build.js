// 打包脚本：从源码目录生成可导入萌卡的插件 zip。
// 用法：node build.js [输出文件名]
//   - 不传参数时，按清单里的 name + version 自动命名，输出到上一级目录（与源码目录同级）。
//   - 打包会把 bin/（Node 运行时）一并打进 zip，但排除 .git / data / 测试文件等。
// 依赖：Node 18+（用内置 fs/path/zlib 构造 zip，不依赖外部包）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = dirname(fileURLToPath(import.meta.url))

const manifest = JSON.parse(readFileSync(join(ROOT, 'mengka-plugin.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// 输出文件名：优先用命令行参数，否则自动命名
const outName = process.argv[2]
  || `${name}-${version}-windows-amd64.zip`
const outPath = join(dirname(ROOT), outName)

// 需要打进 zip 的相对路径（白名单，避免误打入 .git / data）
function collectFiles(root) {
  const result = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = join(dir, ent.name)
      const rel = relative(root, full).split('\\').join('/')
      if (ent.isDirectory()) {
        if (rel === '.git' || rel === 'data' || rel === '.dbg' || rel === '.testdata') continue
        walk(full)
      } else {
        // 跳过开发/测试/临时文件，不打进插件包
        if (rel === 'build.js' || rel === '.gitignore') continue
        if (rel === 'README.md') continue
        if (/^t_.*\.mjs$/.test(ent.name)) continue
        if (ent.name.endsWith('.tmp') || ent.name.endsWith('.log')) continue
        result.push({ full, rel })
      }
    }
  }
  walk(root)
  return result
}

// ---- 最小 ZIP 写出（使用 STORED + DEFLATE 混合，纯 Node 实现）----
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
function dosDateTime(ms) {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hour = d.getHours()
  const minute = d.getMinutes()
  const second = Math.floor(d.getSeconds() / 2)
  return ((year - 1980) << 9) | (month << 5) | day,
    (hour << 11) | (minute << 5) | second
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function buildZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { full, rel } of files) {
    const raw = readFileSync(full)
    const nameBuf = Buffer.from(rel, 'utf8')
    const isText = /\.(js|mjs|json|html|css|md|txt)$/i.test(rel)
    const data = isText ? deflateRawSync(raw) : raw // 二进制（exe）不压缩，原样存；文本用 raw deflate（ZIP method 8 要求，无 zlib 头）
    const method = isText ? 8 : 0
    const crc = crc32(raw)
    const [dTime, dDate] = (() => {
      const d = new Date(statSync(full).mtimeMs)
      const year = Math.max(1980, d.getFullYear())
      return [
        (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      ]
    })()

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)          // signature
    localHeader.writeUInt16LE(20, 4)                   // version needed
    localHeader.writeUInt16LE(0, 6)                    // flags
    localHeader.writeUInt16LE(method, 8)               // method
    localHeader.writeUInt16LE(dTime, 10)               // time
    localHeader.writeUInt16LE(dDate, 12)               // date
    localHeader.writeUInt32LE(crc, 14)                 // crc32
    localHeader.writeUInt32LE(data.length, 18)         // compressed size
    localHeader.writeUInt32LE(raw.length, 22)          // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26)      // name len
    localHeader.writeUInt16LE(0, 28)                   // extra len
    localParts.push(localHeader, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)               // signature
    central.writeUInt16LE(20, 4)                       // version made by
    central.writeUInt16LE(20, 6)                       // version needed
    central.writeUInt16LE(0, 8)                        // flags
    central.writeUInt16LE(method, 10)                  // method
    central.writeUInt16LE(dTime, 12)
    central.writeUInt16LE(dDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)                       // extra len
    central.writeUInt16LE(0, 32)                       // comment len
    central.writeUInt16LE(0, 34)                       // disk number
    central.writeUInt16LE(0, 36)                       // internal attrs
    central.writeUInt32LE(0, 38)                       // external attrs
    central.writeUInt32LE(offset, 42)                  // local header offset
    centralParts.push(central, nameBuf)
    offset += localHeader.length + nameBuf.length + data.length
  }

  const centralOffset = offset
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)                    // signature
  eocd.writeUInt16LE(0, 4)                              // disk number
  eocd.writeUInt16LE(0, 6)                              // central disk
  eocd.writeUInt16LE(files.length, 8)                   // entries this disk
  eocd.writeUInt16LE(files.length, 10)                  // total entries
  eocd.writeUInt32LE(centralDir.length, 12)             // central size
  eocd.writeUInt32LE(centralOffset, 16)                 // central offset
  eocd.writeUInt16LE(0, 20)                             // comment len

  return Buffer.concat([...localParts, centralDir, eocd])
}

// ---- 主流程 ----
const files = collectFiles(ROOT).sort((a, b) => a.rel.localeCompare(b.rel))

const binFound = files.some(f => f.rel.startsWith('bin/'))
if (!binFound) {
  console.error('[!] 未找到 bin/ 目录（Node 运行时）。打包前请确认 bin/node-win-x64.exe 存在。')
  process.exit(1)
}

const zip = buildZip(files)
writeFileSync(outPath, zip)
const mb = (zip.length / 1024 / 1024).toFixed(1)
console.log(`已生成插件包：${outPath}`)
console.log(`  名称：${name}  版本：${version}`)
console.log(`  文件数：${files.length}  大小：${mb} MB`)
