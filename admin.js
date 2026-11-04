// 管理端 HTTP 服务（框架通过 /<instance>/web/ 反代进来）
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

export function createAdminServer({ core, logger, port, host, origin, tokenFile }) {
  let token = ''
  try {
    if (tokenFile && existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim()
  } catch (e) { logger?.warn?.('读取管理端令牌失败：' + e.message) }

  const pageHtml = (() => {
    const f = join(HERE, 'web', 'index.html')
    return existsSync(f) ? readFileSync(f, 'utf8') : '<h1>UI missing</h1>'
  })()

  const tokenOk = req => {
    if (!token) return true
    const raw = req.headers['x-mengka-managed-token']
    if (typeof raw !== 'string' || raw.length !== token.length) return false
    try { return timingSafeEqual(Buffer.from(raw), Buffer.from(token)) } catch { return false }
  }
  const originOk = req => {
    const o = req.headers.origin
    if (!o || !origin) return true
    return o === origin
  }

  const readBody = async req => {
    let b = ''
    for await (const c of req) { b += c; if (b.length > 256 * 1024) throw new Error('body too large') }
    return b ? JSON.parse(b) : {}
  }

  async function handle(req, res, secure = true) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-mengka-managed-token',
    }
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }

    // 框架健康闸门（不校验令牌）
    if (path === '/api/managed/health') {
      return json(200, { ready: true, connected: core.connected, configured: true, active: true })
    }
    if (path === '/api/managed/control') {
      return json(200, { active: true })
    }

    if (secure && !tokenOk(req)) return json(403, { error: 'forbidden' })
    if (secure && !originOk(req)) return json(403, { error: 'origin rejected' })

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(pageHtml)
    }

    try {
      if (path === '/api/state') return json(200, await core.snapshot())

      if (path === '/api/options' && req.method === 'POST') {
        const body = await readBody(req)
        core.updateOptions(body || {})
        return json(200, await core.snapshot())
      }

      if (path === '/api/shops' && req.method === 'POST') {
        const body = await readBody(req)
        core.updateShops(body?.shops || [], body?.activeShop)
        return json(200, await core.snapshot())
      }

      if (path === '/api/shops/test' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body?.baseUrl) return json(400, { ok: false, error: '缺少 baseUrl' })
        try {
          const r = await core.testShop(body.baseUrl)
          return json(200, { ok: true, total: r.total, message: `连接成功，共 ${r.total} 件商品` })
        } catch (e) {
          return json(200, { ok: false, error: String(e?.message || e) })
        }
      }

      if (path === '/api/shops/products') {
        try {
          const page = Number(url.searchParams.get('page') || 1)
          const keyword = url.searchParams.get('keyword') || ''
          return json(200, await core.listProducts({ page, keyword }))
        } catch (e) {
          return json(400, { error: String(e?.message || e) })
        }
      }

      if (path === '/api/test/reply' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          await core.sendTest({
            targetType: body.targetType === 'group' ? 'group' : 'private',
            targetId: Number(body.targetId),
            text: body.text,
          })
          return json(200, { ok: true, message: '已发送' })
        } catch (e) {
          return json(200, { ok: false, error: String(e?.message || e) })
        }
      }

      return json(404, { error: 'Not found' })
    } catch (e) {
      logger?.error?.('管理端处理异常：' + (e?.message || e))
      return json(400, { error: String(e?.message || e) })
    }
  }

  let server = null
  let fallback = null

  return {
    async start() {
      server = createServer((req, res) => {
        handle(req, res, true).catch(e => {
          logger?.error?.('管理端未捕获异常：' + (e?.message || e))
          try { res.writeHead(500); res.end('{"error":"internal"}') } catch {}
        })
      })
      server.requestTimeout = 60000
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          logger?.info?.(`管理端已监听 ${host}:${port}`)
          resolve()
        })
      })

      // 局域网直连兜底（不校验令牌）
      const uiPort = Number(process.env.MENGKA_PLUGIN_UI_PORT || 18092)
      fallback = createServer((req, res) => { handle(req, res, false).catch(() => { try { res.writeHead(500); res.end() } catch {} }) })
      fallback.on('error', () => {})
      fallback.listen(uiPort, '0.0.0.0', () => logger?.info?.(`直连页已监听 0.0.0.0:${uiPort}`))
    },
    stop() {
      try { server?.close() } catch {}
      try { fallback?.close() } catch {}
    },
  }
}
