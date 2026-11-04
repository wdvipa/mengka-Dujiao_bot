// 打包脚本：从源码目录生成可导入萌卡的插件 zip。
//
// 用法：
//   node build.js                 打包全部三个平台（win-x64 / linux-x64 / linux-arm64）
//   node build.js win             只打 Windows x64
//   node build.js linux-amd64     只打 Linux amd64
//   node build.js linux-arm64     只打 Linux arm64
//
// 平台二进制约定（放在 bin/ 下，均不入 git）：
//   bin/node-win-x64.exe   Windows amd64 入口
//   bin/node-linux-x64     Linux amd64 入口（ELF x86-64）
//   bin/node-linux-arm64   Linux arm64 入口（ELF AArch64）
//
// 依赖：Node 18+（用内置 fs/path/zlib 构造 zip，不依赖外部包）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = dirname(fileURLToPath(import.meta.url))

const manifest = JSON.parse(readFileSync(join(ROOT, 'mengka-plugin.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// 平台定义：target 名 -> { bin, entry, suffix, os, arch }
const PLATFORMS = {
  win: {
    bin: 'bin/node-win-x64.exe',
    entry: 'bin/node-win-x64.exe',
    suffix: 'windows-amd64',
  },
  'linux-amd64': {
    bin: 'bin/node-linux-x64',
    entry: 'bin/node-linux-x64',
    suffix: 'linux-amd64',
  },
  'linux-arm64': {
    bin: 'bin/node-linux-arm64',
    entry: 'bin/node-linux-arm64',
    suffix: 'linux-arm64',
  },
}

// ---------------- zip 构造 ----------------
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function buildZip(files, manifestOverride) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { full, rel } of files) {
    // 清单文件用平台专属内容覆盖（entry 指向本平台可执行文件）
    const raw = (manifestOverride && rel === 'mengka-plugin.json')
      ? Buffer.from(manifestOverride, 'utf8')
      : readFileSync(full)
    const nameBuf = Buffer.from(rel, 'utf8')
    const data = deflateRawSync(raw, { level: 6 })   // ZIP method 8 要求 raw deflate
    const method = 8
    const crc = crc32(raw)
    const st = statSync(full)
    const d = new Date(st.mtimeMs)
    const year = Math.max(1980, d.getFullYear())
    const dTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
    const dDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dTime, 10)
    localHeader.writeUInt16LE(dDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dTime, 12)
    central.writeUInt16LE(dDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    // Linux 可执行文件需要 0755 权限位（高 16 位为 unix mode）
    const isExec = /^bin\//.test(rel)
    central.writeUInt32LE(isExec ? (0o100755 << 16) >>> 0 : (0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += localHeader.length + nameBuf.length + data.length
  }

  const centralOffset = offset
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

// ---------------- 文件收集 ----------------
function collectFiles(root, platformKey) {
  const plat = PLATFORMS[platformKey]
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
        // 开发/测试文件不入包
        if (rel === 'build.js' || rel === '.gitignore' || rel === 'README.md') continue
        if (/^t_.*\.mjs$/.test(ent.name)) continue
        if (ent.name.endsWith('.tmp') || ent.name.endsWith('.log')) continue
        // bin/ 只保留本平台入口
        if (rel.startsWith('bin/') && rel !== plat.bin) continue
        result.push({ full, rel })
      }
    }
  }
  walk(root)
  return result
}

// ---------------- 打包单个平台 ----------------
function packPlatform(platformKey) {
  const plat = PLATFORMS[platformKey]
  const binPath = join(ROOT, plat.bin)
  if (!existsSync(binPath)) {
    throw new Error(`缺少 ${plat.bin}，请先把对应平台的 node 可执行文件放到 bin/ 下`)
  }

  const files = collectFiles(ROOT, platformKey).sort((a, b) => a.rel.localeCompare(b.rel))

  // 平台专属清单（entry 指向本平台可执行文件）
  const platManifest = JSON.stringify({
    ...manifest,
    runtime: { ...manifest.runtime, entry: plat.entry },
  }, null, 2)

  const outName = `${name}-${version}-${plat.suffix}.zip`
  const outPath = join(dirname(ROOT), outName)
  const zip = buildZip(files, platManifest)
  writeFileSync(outPath, zip)
  const mb = (zip.length / 1024 / 1024).toFixed(1)
  console.log(`  [${platformKey}] ${outName}  ${files.length} 文件  ${mb} MB`)
  return outPath
}

// ---------------- 主流程 ----------------
const arg = process.argv[2]
const targets = arg
  ? (PLATFORMS[arg] ? [arg] : (() => { console.error(`未知平台：${arg}（可用：${Object.keys(PLATFORMS).join(' / ')}）`); process.exit(1) })())
  : Object.keys(PLATFORMS)

console.log(`打包 ${name} v${version}`)
for (const t of targets) {
  try {
    packPlatform(t)
  } catch (e) {
    console.error(`  [${t}] 跳过：${e.message}`)
  }
}
