// 独角数卡商城助手 · 核心业务
// 参考 cardlike-assistant 的结构：按 post_type 派发事件、协议选择、发送封装、配置持久化。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'

export const PLUGIN_ID = 'dujiao-shop'
export const VERSION = '2.2.0'
export const ACTIONS = Object.freeze([
  'get_plugin_context',
  'get_bot_list',
  'get_protocol_list',
  'send_friend_msg',
  'send_group_msg',
])

const API_PREFIX = '/api/v1'

// ---------------- 工具 ----------------

const sleep = ms => new Promise(r => setTimeout(r, ms))
const asInt = v => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}
const bool = (v, d = false) => (v === undefined || v === null ? d : v === true || v === 1 || v === '1')

const accountId = row => {
  const id = Number(row?.self_id ?? row?.selfId ?? row?.user_id ?? row?.uin ?? row?.qq ?? row?.id)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}
const protocolIdOf = row => {
  const v = row?.protocol?.id ?? row?.protocol_id ?? row?.protocolId
  return v === undefined || v === null ? null : Number(v)
}
const onlineRow = row => {
  if (!row) return false
  if (row.online === false || row.online === 0 || row.online === '0') return false
  if (row.online === true || row.online === 1 || row.online === '1') return true
  const status = String(row.status ?? '').toLowerCase()
  return !status || status === '1' || ['online', 'connected'].includes(status)
}
function rows(result, key = '') {
  const candidates = [
    result, result?.data, result?.[key], result?.data?.[key],
    result?.list, result?.data?.list, result?.items, result?.data?.items,
  ]
  return candidates.find(Array.isArray) || []
}

// 消息段取文本（与 cardlike 的 textOf 一致）
export function textOf(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  return message
    .filter(seg => seg?.type === 'text')
    .map(seg => String(seg.data?.text || ''))
    .join('')
    .trim()
}

// 多语言字段取值（独角数卡标题/描述是 {zh-CN,zh-TW,en-US}）
export function pickText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return String(v['zh-CN'] || v['zh-TW'] || v['en-US'] || '')
  return String(v)
}
export function money(v) {
  if (v == null || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? '¥' + n.toFixed(2) : String(v)
}
export function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ---------------- 本地加密存储 ----------------

function loadKey(dir) {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'credential.key')
  try {
    const buf = readFileSync(f)
    if (buf.length === 32) return buf
  } catch { /* 首次 */ }
  const key = randomBytes(32)
  writeFileSync(f, key, { mode: 0o600 })
  return key
}
function seal(key, obj) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}
function unseal(key, p) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'))
  d.setAuthTag(Buffer.from(p.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(p.data, 'base64')), d.final()]).toString('utf8'))
}
const isSealed = j => j && typeof j === 'object' && typeof j.iv === 'string' && typeof j.data === 'string'

function createStore(dir) {
  const key = loadKey(dir)
  return {
    read(name, fallback) {
      const f = join(dir, name)
      try {
        if (!existsSync(f)) return fallback
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return isSealed(j) ? unseal(key, j) : j
      } catch {
        try { renameSync(f, f + '.corrupt-' + Date.now()) } catch {}
        return fallback
      }
    },
    write(name, value) {
      const f = join(dir, name)
      const tmp = f + '.tmp'
      writeFileSync(tmp, JSON.stringify(seal(key, value)), { mode: 0o600 })
      renameSync(tmp, f)
    },
  }
}

// ---------------- 配置 ----------------

const DEFAULT_MENU = [
  '【独角数卡商城】',
  '/dj list [页码]      浏览商品',
  '/dj search 关键词    搜索商品',
  '/dj info 序号        商品详情',
  '/dj bind 密码        设置查询密码（邮箱自动用 QQ 号）',
  '/dj buy 序号 [数量]  下单并返回支付链接',
  '/dj orders [页码]    我的订单与卡密',
  '/dj shop [序号]      查看 / 切换商城',
  '/dj help             本帮助',
].join('\n')

export function normalizeShopUrl(u) {
  let s = String(u || '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s.replace(/\/+$/, '')
}

function normalizeShopList(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const shops = (Array.isArray(r.shops) ? r.shops : [])
    .slice(0, 5)
    .map((s, i) => ({
      label: String(s?.label || (i === 0 ? '主站' : '商城' + (i + 1))),
      baseUrl: normalizeShopUrl(s?.baseUrl),
      enabled: s?.enabled !== false,
    }))
    .filter(s => s.baseUrl)
  const activeShop = shops.length
    ? Math.max(0, Math.min(shops.length - 1, Number.isInteger(r.activeShop) ? r.activeShop : 0))
    : 0
  return { shops, activeShop }
}

const DEFAULT_OPTIONS = {
  enabled: true,
  replyToGroup: true,
  commandPrefix: '/dj,独角',
  maxProducts: 15,
  cooldownSeconds: 3,
  owners: '',
}
function normalizeOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d
  }
  return {
    enabled: o.enabled !== false,
    replyToGroup: o.replyToGroup !== false,
    commandPrefix: Array.isArray(o.commandPrefix)
      ? o.commandPrefix.map(x => String(x).trim()).filter(Boolean).join(',')
      : (String(o.commandPrefix ?? DEFAULT_OPTIONS.commandPrefix).trim() || DEFAULT_OPTIONS.commandPrefix),
    maxProducts: num(o.maxProducts ?? o.maxProductsInList, DEFAULT_OPTIONS.maxProducts, 1, 50),
    cooldownSeconds: num(o.cooldownSeconds, DEFAULT_OPTIONS.cooldownSeconds, 0, 60),
    owners: String(o.owners || '').replace(/[^\d,，\s]/g, '').trim(),
  }
}

function normalizeUsers(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const users = {}
  for (const [k, v] of Object.entries(r.users || {})) {
    if (!v || typeof v !== 'object') continue
    const email = String(v.email || '').trim()
    const orderPassword = String(v.orderPassword || '')
    if (!email || !orderPassword) continue
    users[String(k)] = { email, orderPassword, updatedAt: asInt(v.updatedAt) || Date.now() }
  }
  return { users }
}

// ---------------- 商城 API ----------------

const guestAuth = (email, password) => {
  const raw = `${String(email).trim().toLowerCase()}\n${String(password).trim()}`
  const b64 = Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return 'Guest ' + b64
}

class ShopError extends Error {
  constructor(message, status) { super(message); this.name = 'ShopError'; this.status = status || 0 }
}

async function shopRequest(shop, { path, method = 'GET', params, body, headers, timeoutMs = 20000 }) {
  const url = new URL(shop.baseUrl + API_PREFIX + path)
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const h = { Accept: 'application/json', ...(headers || {}) }
  let payload
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  let res
  try {
    res = await fetch(url.toString(), { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ShopError(`连接商城失败：${e?.message || e}`)
  }
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!json) throw new ShopError(res.ok ? '商城返回内容无法解析' : `商城返回 HTTP ${res.status}`, res.status)
  if (typeof json.status_code === 'number' && json.status_code !== 0) {
    throw new ShopError(json.msg || `商城业务错误 ${json.status_code}`, json.status_code)
  }
  if (!res.ok) throw new ShopError(json.msg || `商城返回 HTTP ${res.status}`, res.status)
  return json
}

const defaultShopApi = {
  async ping(shop) {
    const r = await shopRequest(shop, { path: '/public/products', params: { page: 1, page_size: 1 }, timeoutMs: 8000 })
    return { total: r?.pagination?.total ?? 0 }
  },
  async products(shop, { page = 1, pageSize = 10, keyword = '' } = {}) {
    const r = await shopRequest(shop, { path: '/public/products', params: { page, page_size: pageSize, keyword } })
    return { items: Array.isArray(r.data) ? r.data : [], pagination: r.pagination || null }
  },
  async product(shop, slug) {
    const r = await shopRequest(shop, { path: '/public/products/' + encodeURIComponent(slug) })
    return r.data
  },
  async categories(shop) {
    const r = await shopRequest(shop, { path: '/public/categories' })
    return Array.isArray(r.data) ? r.data : []
  },
  async createGuestOrder(shop, { email, orderPassword, items }) {
    const r = await shopRequest(shop, {
      method: 'POST', path: '/guest/orders',
      body: { email, order_password: orderPassword, items },
      headers: { Authorization: guestAuth(email, orderPassword) },
    })
    return r.data
  },
  async guestOrder(shop, { orderNo, email, orderPassword }) {
    const r = await shopRequest(shop, {
      path: '/guest/orders/' + encodeURIComponent(orderNo),
      headers: { Authorization: guestAuth(email, orderPassword) },
    })
    return r.data
  },
  async guestOrders(shop, { email, orderPassword, page = 1, pageSize = 5 }) {
    const r = await shopRequest(shop, {
      path: '/guest/orders', params: { page, page_size: pageSize },
      headers: { Authorization: guestAuth(email, orderPassword) },
    })
    return { items: Array.isArray(r.data) ? r.data : [], pagination: r.pagination || null }
  },
  async guestPay(shop, { orderNo, channelId, email, orderPassword }) {
    const r = await shopRequest(shop, {
      method: 'POST', path: '/guest/payments',
      body: { order_no: orderNo, channel_id: channelId },
      headers: { Authorization: guestAuth(email, orderPassword) },
    })
    return r.data
  },
}

// 卡密：fulfillment.payload 是纯文本，一行一条；卡密挂在子订单上
export function extractSecrets(order) {
  const out = []
  const NL = String.fromCharCode(10)
  const push = v => {
    const s = String(v ?? '').trim()
    if (!s) return
    for (const rawLine of s.split(NL)) {
      const t = rawLine.trim()
      if (t && !out.includes(t)) out.push(t)
    }
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return
    const f = node.fulfillment
    if (f && typeof f === 'object' && f.payload) push(f.payload)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(order)
  return out
}

// 3.0 文档：群临时消息同样走 friend_message 权限
const MSG_TYPES = new Set(['group_message', 'friend_message', 'group_temp_message'])

const STATUS_TEXT = {
  pending_payment: '待支付', paid: '已支付', delivering: '发货中',
  delivered: '已发货', completed: '已完成', canceled: '已取消',
  refunded: '已退款', expired: '已过期',
}

// ---------------- 助手主体 ----------------

export function createAssistant({ api, dataPath, logger, shopOverride }) {
  const store = createStore(dataPath)
  const shopApi = shopOverride || defaultShopApi
  const log = {
    info: m => logger?.info?.(m),
    warn: m => logger?.warn?.(m),
    error: m => logger?.error?.(m),
  }

  const state = {
    connected: false,
    closed: false,
    protocols: [],
    sessions: new Map(),   // selfId -> Set(protocolId)
    botInfo: new Map(),
    listCache: new Map(),
    cooldown: new Map(),
    stats: { received: 0, sent: 0, orders: 0, lastEventAt: 0 },
  }

  const getOptions = () => normalizeOptions(store.read('options.json', DEFAULT_OPTIONS))
  const saveOptions = o => store.write('options.json', normalizeOptions(o))
  const getShops = () => normalizeShopList(store.read('shops.json', { shops: [], activeShop: 0 }))
  const saveShops = s => store.write('shops.json', normalizeShopList(s))
  const getUsers = () => normalizeUsers(store.read('users.json', { users: {} }))
  const saveUsers = u => store.write('users.json', normalizeUsers(u))

  function call(action, params = {}, timeoutMs = 15000) {
    return api.call(action, params, { timeoutMs })
  }

  function activeShop() {
    const s = getShops()
    return s.shops[s.activeShop] || s.shops[0] || null
  }

  function pickProtocol(selfId, preferred = null) {
    const set = state.sessions.get(String(selfId))
    if (!set?.size) return null
    if (preferred != null && [...set].some(id => String(id) === String(preferred))) return preferred
    const available = [...set]
    const score = id => {
      const p = state.protocols.find(item => String(item.id) === String(id)) || {}
      const platform = String(p.platform || '').toLowerCase()
      const type = String(p.type || '').toLowerCase()
      if (platform === 'android' && type === 'phone') return 0
      if (platform === 'android') return 1
      if (platform === 'linux' || platform === 'pc') return 2
      return 3
    }
    return available.sort((a, b) => score(a) - score(b))[0]
  }

  function requireProtocol(selfId, preferred) {
    const pid = pickProtocol(selfId, preferred)
    if (pid == null) throw new Error('当前账号无可用在线协议')
    return pid
  }

  async function sendFriend(selfId, protocolId, userId, text) {
    state.stats.sent++
    return call('send_friend_msg', {
      self_id: Number(selfId), protocol_id: protocolId, user_id: Number(userId),
      message: [{ type: 'text', data: { text: String(text) } }],
    })
  }

  async function sendGroup(selfId, protocolId, groupId, text) {
    state.stats.sent++
    return call('send_group_msg', {
      self_id: Number(selfId), protocol_id: protocolId, group_id: Number(groupId),
      message: [{ type: 'text', data: { text: String(text) } }],
    })
  }

  async function refreshAccounts() {
    if (!state.connected) return
    const [protocolResult, botResult] = await Promise.all([
      call('get_protocol_list', {}, 10000).catch(() => []),
      call('get_bot_list', {}, 15000).catch(() => []),
    ])
    state.protocols = rows(protocolResult, 'protocols')
    const online = new Map()
    const infos = new Map()
    for (const row of rows(botResult, 'bots')) {
      const selfId = accountId(row)
      if (!selfId) continue
      infos.set(String(selfId), { ...infos.get(String(selfId)), ...row })
      const pid = protocolIdOf(row)
      if (pid != null && onlineRow(row)) {
        if (!online.has(String(selfId))) online.set(String(selfId), new Set())
        online.get(String(selfId)).add(pid)
      }
    }
    state.sessions = online
    state.botInfo = infos
  }

  function setProtocol(selfId, protocolId, online, event = {}) {
    const key = String(selfId)
    if (!state.sessions.has(key)) state.sessions.set(key, new Set())
    const set = state.sessions.get(key)
    if (protocolId != null) online ? set.add(protocolId) : set.delete(protocolId)
    if (!set.size) state.sessions.delete(key)
    state.botInfo.set(key, { ...state.botInfo.get(key), ...event, self_id: Number(selfId), protocol_id: protocolId })
  }

  // ---------- 指令 ----------

  function stripPrefix(text) {
    const opts = getOptions()
    const prefixes = opts.commandPrefix.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    for (const p of prefixes) {
      if (text.toLowerCase().startsWith(p.toLowerCase())) return text.slice(p.length).trim()
    }
    return null
  }

  const listKey = ev => (ev.group_id ? `g:${ev.group_id}:${ev.user_id ?? ev.sender?.user_id ?? ''}` : `p:${ev.user_id ?? ev.sender?.user_id ?? ''}`)

  async function handleCommand(ev, command, uid, reply) {
    const opts = getOptions()
    const key = listKey(ev) + '|' + command
    const now = Date.now()
    if (now - (state.cooldown.get(key) || 0) < opts.cooldownSeconds * 1000) return null
    state.cooldown.set(key, now)

    const [sub, ...rest] = command.split(/\s+/)
    const arg = rest.join(' ').trim()
    const name = (sub || 'help').toLowerCase()

    if (['shop', '商城'].includes(name)) return cmdShop(arg)

    const shop = activeShop()
    if (!shop) return '尚未配置商城，请在插件管理后台添加商城地址并保存。'

    try {
      switch (name) {
        case 'help': case '帮助': return await cmdHelp(uid)
        case 'list': case '商品': return await cmdList(shop, opts, ev, Number(arg) || 1)
        case 'search': case '搜索':
          if (!arg) return '用法：/dj search 关键词'
          return await cmdSearch(shop, opts, ev, arg)
        case 'info': case '详情':
          if (!arg) return '用法：/dj info 序号（先 /dj list）'
          return await cmdInfo(shop, ev, arg)
        case 'bind': case '绑定': case '密码': return cmdBind(uid, arg)
        case 'buy': case '下单': return await cmdBuy(shop, ev, uid, arg, reply)
        case 'orders': case '订单': case '我的订单': return await cmdOrders(shop, uid, arg)
        default: return '未知指令，发送 /dj help 查看用法。'
      }
    } catch (e) {
      log.warn(`指令 ${name} 失败：${e?.message || e}`)
      return `处理失败：${e?.message || e}`
    }
  }

  async function cmdHelp(uid) {
    const shops = getShops()
    const options = getOptions()
    const lines = [DEFAULT_MENU]
    if (shops.shops.length) {
      lines.push('')
      lines.push(`当前商城：${shops.shops[shops.activeShop]?.label || '-'}`)
    }
    return lines.join('\n')
  }

  async function cmdList(shop, opts, ev, page) {
    const r = await shopApi.products(shop, { page, pageSize: opts.maxProducts })
    if (!r.items.length) return `【${shop.label}】暂无商品。`
    state.listCache.set(listKey(ev), { items: r.items, at: Date.now() })
    const lines = r.items.map((p, i) => {
      const stock = stockText(p)
      return `${i + 1}. ${pickText(p.title)}  ${money(p.price_amount)}${stock ? '  ' + stock : ''}`
    })
    const pg = r.pagination
    const foot = pg && pg.total_page > 1
      ? `\n第 ${pg.page}/${pg.total_page} 页，共 ${pg.total} 件。翻页 /dj list ${pg.page + 1}`
      : ''
    return `【${shop.label}】商品\n${lines.join('\n')}${foot}\n详情 /dj info 序号`
  }

  async function cmdSearch(shop, opts, ev, keyword) {
    const r = await shopApi.products(shop, { page: 1, pageSize: opts.maxProducts, keyword })
    if (!r.items.length) return `没有找到「${keyword}」相关商品。`
    state.listCache.set(listKey(ev), { items: r.items, at: Date.now() })
    const lines = r.items.map((p, i) => `${i + 1}. ${pickText(p.title)}  ${money(p.price_amount)}`)
    return `【${shop.label}】搜索「${keyword}」\n${lines.join('\n')}\n详情 /dj info 序号`
  }

  function pickFromCache(ev, ref) {
    const c = state.listCache.get(listKey(ev))
    if (!c) return null
    const n = Number(ref)
    if (!Number.isInteger(n) || n < 1 || n > c.items.length) return null
    return c.items[n - 1]
  }

  async function cmdInfo(shop, ev, ref) {
    const cached = pickFromCache(ev, ref)
    // 纯数字且缓存里没有 → 多半是没先 list，直接引导，避免用数字去撞 slug
    if (!cached && /^\d+$/.test(String(ref))) {
      return `序号 ${ref} 未找到，请先发送 /dj list 获取商品列表（列表有效期内序号可用）。`
    }
    const product = cached || await shopApi.product(shop, ref)
    if (!product) return '商品不存在，请先 /dj list 用序号选择。'
    const skus = Array.isArray(product.skus) ? product.skus : []
    const skuLines = skus.slice(0, 6).map((s, i) => {
      const spec = Object.values(s.spec_values || {}).filter(Boolean).join(' ')
      const st = skuStockText(s)
      return `  ${i + 1}. ${spec || s.sku_code || ('规格' + (i + 1))}  ${money(s.price_amount)}${st ? '  ' + st : ''}`
    })
    const desc = stripHtml(pickText(product.description)).slice(0, 200)
    return [
      `【${pickText(product.title)}】`,
      `价格：${money(product.price_amount)}${stockText(product) ? '  库存：' + stockText(product) : ''}`,
      desc ? `说明：${desc}` : '',
      skuLines.length ? `规格：\n${skuLines.join('\n')}` : '',
      '',
      `下单 /dj buy ${cached ? ref : (product.slug || product.id)} [数量]`,
    ].filter(Boolean).join('\n')
  }

  // 下单邮箱固定为 <QQ>@qq.com；查询密码由用户自行设置
  function defaultEmail(uid) { return uid + '@qq.com' }

  function needPassword(uid) {
    return '请先设置查询密码：/dj bind 你的密码\n\n下单邮箱会自动使用 ' + defaultEmail(uid) + '\n密码用于下单与查看卡密，仅加密保存在本机。'
  }

  function cmdBind(uid, arg) {
    const pw = String(arg || '').trim()
    if (!pw) {
      return [
        '设置查询密码：/dj bind 你的密码',
        '',
        '下单邮箱：' + defaultEmail(uid) + '（自动使用）',
        '密码至少 4 位、不含空格，用于之后下单与查看卡密。',
        '仅加密保存在本机，可随时用 /dj bind 新密码 修改。',
      ].join('\n')
    }
    if (/\s/.test(pw)) return '密码不能包含空格。'
    if (pw.length < 4) return '密码至少 4 位。'
    if (pw.length > 64) return '密码不能超过 64 位。'
    const users = getUsers()
    const existed = !!users.users[String(uid)]?.orderPassword
    users.users[String(uid)] = {
      email: defaultEmail(uid),
      orderPassword: pw,
      updatedAt: Date.now(),
    }
    saveUsers(users)
    return [
      existed ? '查询密码已更新' : '查询密码已设置',
      '下单邮箱：' + defaultEmail(uid),
      '',
      '现在可以：/dj list 浏览商品、/dj buy 下单、/dj orders 查看我的订单和卡密。',
    ].join('\n')
  }

  async function cmdBuy(shop, ev, uid, arg, reply) {
    const [ref, qtyRaw] = arg.split(/\s+/)
    if (!ref) return '用法：/dj buy 序号 [数量]'
    const quantity = Math.max(1, Math.min(99, Number(qtyRaw) || 1))

    const binding = getUsers().users[String(uid)]
    if (!binding?.orderPassword) return needPassword(uid)

    const cached = pickFromCache(ev, ref)
    if (!cached && /^\d+$/.test(String(ref))) {
      return '序号 ' + ref + ' 未找到，请先发送 /dj list 获取商品列表后再下单。'
    }
    const product = cached || await shopApi.product(shop, ref)
    if (!product) return '找不到商品，请先 /dj list。'

    const skus = Array.isArray(product.skus) ? product.skus.filter(s => s.is_active !== false) : []
    const sku = skus.find(s => !s.is_sold_out) || skus[0]
    if (!sku) return '该商品暂时没有可售规格。'

    const email = binding.email || defaultEmail(uid)
    const created = await shopApi.createGuestOrder(shop, {
      email,
      orderPassword: binding.orderPassword,
      items: [{ product_id: product.id, sku_id: sku.id, quantity }],
    })
    const orderNo = created?.order_no || ''
    if (!orderNo) return '下单失败：商城未返回订单号。'
    state.stats.orders++

    // 取支付链接
    let payUrl = ''
    let note = ''
    const channels = Array.isArray(created.allowed_payment_channel_ids) ? created.allowed_payment_channel_ids : []
    if (channels.length) {
      try {
        const pay = await shopApi.guestPay(shop, {
          orderNo, channelId: channels[0], email, orderPassword: binding.orderPassword,
        })
        payUrl = pay?.pay_url || ''
        if (!payUrl) note = '（渠道 ' + (pay?.channel_name || channels[0]) + ' 未返回跳转链接）'
      } catch (e) {
        note = '（取支付链接失败：' + (e?.message || e) + '）'
      }
    }

    // 先回复下单信息 + 支付链接，让用户去支付
    const head = [
      '下单成功',
      '订单号：' + orderNo,
      '邮箱：' + email,
      '金额：' + money(created.total_amount),
      payUrl ? '支付链接：\n' + payUrl : '请到商城完成支付 ' + note,
      '',
      '请在 5 分钟内完成支付，我将自动确认结果…',
    ].filter(Boolean).join('\n')
    if (typeof reply === 'function') { await reply(head).catch(() => {}) }

    // 轮询订单状态，最多 5 分钟（间隔/超时可用环境变量覆盖，便于测试）
    const POLL_TIMEOUT_MS = Number(process.env.DJ_POLL_TIMEOUT_MS) || (5 * 60 * 1000)
    const POLL_INTERVAL = Number(process.env.DJ_POLL_INTERVAL_MS) || 3000
    const deadline = Date.now() + POLL_TIMEOUT_MS
    const PAID_STATUSES = new Set(['paid', 'delivering', 'delivered', 'completed'])
    let lastStatus = ''
    while (true) {
      if (Date.now() >= deadline) break
      await sleep(POLL_INTERVAL)
      let order
      try {
        order = await shopApi.guestOrder(shop, {
          orderNo, email, orderPassword: binding.orderPassword,
        })
      } catch (e) {
        // 查询失败不中断，继续等；但记录一下
        lastStatus = '查询失败'
        continue
      }
      if (!order) continue
      const st = String(order.status || '')
      if (st !== lastStatus) {
        lastStatus = st
        if (PAID_STATUSES.has(st)) {
          // 支付成功：返回卡密
          const secrets = extractSecrets(order)
          const items = (order.items || []).map(it => pickText(it.title) + ' x' + it.quantity).join('、')
          return [
            '支付成功，订单已处理',
            '订单号：' + (order.order_no || orderNo),
            items ? '商品：' + items : '',
            order.total_amount != null ? '金额：' + money(order.total_amount) : '',
            secrets.length ? '卡密：\n' + secrets.join('\n') : '',
          ].filter(Boolean).join('\n')
        }
        if (['canceled', 'expired', 'refunded'].includes(st)) {
          return '订单 ' + orderNo + ' ' + (STATUS_TEXT[st] || st) + '，如有疑问请到商城查看。'
        }
      }
    }

    return '支付超时：订单 ' + orderNo + ' 在 5 分钟内未确认支付。可稍后发送 /dj orders 查看订单状态。'
  }

  // 查我的订单：列表接口不含卡密，需逐单拉详情
  async function cmdOrders(shop, uid, arg) {
    const binding = getUsers().users[String(uid)]
    if (!binding?.orderPassword) return needPassword(uid)

    const page = Math.max(1, Number(arg) || 1)
    const r = await shopApi.guestOrders(shop, {
      email: binding.email, orderPassword: binding.orderPassword, page, pageSize: 5,
    })
    if (!r.items.length) return page > 1 ? '没有更多订单了。' : '你还没有订单。'

    const blocks = []
    for (const summary of r.items) {
      const orderNo = summary.order_no
      let detail = null
      let secrets = []
      // 已支付/已完成的订单才值得拉详情取卡密
      const worthDetail = summary.status && !['pending_payment', 'canceled', 'expired'].includes(summary.status)
      if (worthDetail) {
        try {
          detail = await shopApi.guestOrder(shop, {
            orderNo, email: binding.email, orderPassword: binding.orderPassword,
          })
          secrets = extractSecrets(detail)
        } catch { /* 详情失败不影响列表展示 */ }
      }
      const items = (summary.items || []).map(it => pickText(it.title) + ' x' + it.quantity).join('、')
      const lines = [
        '【' + orderNo + '】',
        STATUS_TEXT[summary.status] || summary.status || '',
        items,
        money(summary.total_amount),
      ].filter(Boolean)
      if (secrets.length) {
        lines.push('卡密：')
        secrets.forEach(s => lines.push('  ' + s))
      } else if (summary.status === 'pending_payment') {
        lines.push('卡密：支付后自动发放')
      } else if (worthDetail) {
        lines.push('卡密：暂未发放')
      }
      blocks.push(lines.join('\n'))
    }

    const pg = r.pagination
    const foot = pg && pg.total_page > page ? '\n\n翻页：/dj orders ' + (page + 1) : ''
    return '【' + shop.label + '】我的订单\n\n' + blocks.join('\n\n') + foot
  }


  function cmdShop(arg) {
    const s = getShops()
    if (!arg) {
      if (!s.shops.length) return '尚未配置商城。'
      const lines = s.shops.map((x, i) => `${i === s.activeShop ? '▶' : '·'} ${i + 1}. ${x.label}  ${x.baseUrl}`)
      return `商城列表\n${lines.join('\n')}\n切换 /dj shop 序号`
    }
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > s.shops.length) return '序号无效。'
    s.activeShop = n - 1
    saveShops(s)
    return `已切换到：${s.shops[s.activeShop].label}`
  }

  // ---------- 事件 ----------

  async function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    state.stats.lastEventAt = Date.now()

    // 3.0 事件类别一律读 post_type（文档明确不依赖 event_type）
    const type = String(ev.post_type || '').toLowerCase()

    if (type === 'bot_online') {
      setProtocol(accountId(ev), protocolIdOf(ev), true, ev)
      return
    }
    if (type === 'bot_offline') {
      setProtocol(accountId(ev), protocolIdOf(ev), false, ev)
      return
    }
    if (type === 'system_event') return
    if (type === 'friend_event' || type === 'group_event') return  // 通知类事件不处理

    // 消息类：group_message / friend_message / group_temp_message
    if (!MSG_TYPES.has(type)) return

    // 自己发出的消息不响应（按发送者判定）
    if (Number(ev.sender?.user_id ?? 0) === accountId(ev)) return

    state.stats.received++
    await handleMessage(ev, type)
  }

  async function handleMessage(ev, type) {
    const selfId = accountId(ev)
    const sender = Number(ev.sender?.user_id ?? ev.user_id ?? 0)
    const text = textOf(ev.message)
    if (!selfId || !sender || !text) return

    // 群消息才有 group_id；群临时消息来源群未确认时 group_id 可能缺失，此时按私聊回复
    const isGroup = type === 'group_message'
    const groupId = isGroup ? Number(ev.group_id || 0) : 0
    if (isGroup && !groupId) {
      log.warn(`[${selfId}] group_message 缺少 group_id，已忽略`)
      return
    }

    const opts = getOptions()
    if (!opts.enabled) return

    // 群聊：只响应 @机器人 或带前缀的消息
    if (isGroup) {
      const atMe = Array.isArray(ev.message) && ev.message.some(seg =>
        seg?.type === 'at' && String(seg?.data?.qq) === String(selfId))
      const hasPrefix = stripPrefix(text) !== null
      if (!opts.replyToGroup || (!atMe && !hasPrefix)) return
    }

    const command = stripPrefix(text)
    if (command === null) return

    // protocol_id 必须来自账号实例，0 是有效值
    const evProtocol = protocolIdOf(ev)
    let protocolId
    try {
      protocolId = requireProtocol(selfId, evProtocol)
    } catch (e) {
      log.warn(`[${selfId}] ${e.message}`)
      return
    }

    const reply = text => isGroup
      ? sendGroup(selfId, protocolId, groupId, text)
      : sendFriend(selfId, protocolId, sender, text)

    const out = await handleCommand(ev, command, sender, reply)
    if (!out) return

    // 命令返回文本，由 reply 发送（cmdBuy 已在内部发过"下单+链接"头消息，这里发的是最终结果）
    reply(out).catch(e => log.warn(`[${selfId}] 回复失败：${e.message}`))
  }

  // ---------- 生命周期 ----------

  async function initialize() {
    try {
      await refreshAccounts()
      log.info(`已加载 ${state.sessions.size} 个在线账号、${state.protocols.length} 个协议`)
    } catch (e) {
      log.warn(`初始化失败：${e.message}`)
    }
  }

  return {
    // 供 index.js 调用
    handleEvent,
    setConnected(v) {
      state.connected = !!v && !state.closed
      if (state.connected) initialize()
    },
    get connected() { return state.connected },
    set connected(v) { state.connected = !!v },
    close() {
      state.closed = true
      state.connected = false
    },
    // 供管理端调用
    snapshot: async () => {
      await refreshAccounts().catch(() => {})
      const shops = getShops()
      const users = getUsers()
      return {
        version: VERSION,
        plugin_id: PLUGIN_ID,
        connected: state.connected,
        stats: { ...state.stats },
        options: getOptions(),
        shops: shops.shops.map((s, i) => ({ ...s, active: i === shops.activeShop })),
        activeShop: shops.activeShop,
        boundUsers: Object.keys(users.users).length,
        bots: [...state.botInfo.values()].map(b => ({
          self_id: accountId(b),
          nickname: b.nickname || '',
          platform: b.platform || '',
          online: onlineRow(b),
        })),
      }
    },
    updateOptions: patch => { saveOptions({ ...getOptions(), ...patch }); return getOptions() },
    updateShops: (shops, activeShop) => {
      const next = normalizeShopList({ shops, activeShop })
      saveShops(next)
      return next
    },
    testShop: async baseUrl => shopApi.ping({ baseUrl: normalizeShopUrl(baseUrl) }),
    listProducts: async ({ page = 1, keyword = '' } = {}) => {
      const shop = activeShop()
      if (!shop) throw new Error('尚未配置商城')
      return { shop: shop.label, ...(await shopApi.products(shop, { page, pageSize: 10, keyword })) }
    },
    sendTest: async ({ targetType, targetId, text }) => {
      // 先强制刷新，避免 sessions 尚未初始化
      await refreshAccounts().catch(() => {})
      // 从 botInfo 找在线账号（与 snapshot 展示一致）
      const onlineBots = [...state.botInfo.values()].filter(b => onlineRow(b))
      if (!onlineBots.length) throw new Error('没有在线账号，无法发送测试消息')
      const bot = onlineBots[0]
      const selfId = accountId(bot)
      const protocolId = protocolIdOf(bot) ?? pickProtocol(selfId)
      if (protocolId == null) throw new Error('在线账号缺少可用协议')
      const body = String(text || '独角数卡商城助手测试消息')
      if (targetType === 'group') await sendGroup(selfId, protocolId, targetId, body)
      else await sendFriend(selfId, protocolId, targetId, body)
      return true
    },
    getShops,
  }
}

function stockText(p) {
  if (p?.is_sold_out) return '缺货'
  if (p?.stock_quantity_hidden) return ''
  const n = Number(p?.auto_stock_available ?? p?.stock_quantity ?? 0)
  return n > 0 ? String(n) : ''
}
function skuStockText(s) {
  if (s?.is_sold_out) return '缺货'
  const n = Number(s?.auto_stock_available ?? 0)
  return n > 0 ? String(n) : ''
}
