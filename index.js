#!/usr/bin/env node
// 独角数卡商城助手 · 萌卡NT 3.0 native-ipc-v1 入口
// 参考 cardlike-assistant 的接入方式：SDK 负责握手与协议校验，业务全在 core.js
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createNativePlugin } from './sdk/native-plugin.js'
import { EVENT_PERMISSIONS } from './sdk/common.js'
import { createAdminServer } from './admin.js'
import { ACTIONS, PLUGIN_ID, VERSION, createAssistant } from './core.js'

// 启动前校验清单：事件必须是 SDK 允许的集合，plugin_id/version/actions 也必须与代码一致，
// 否则框架 start() 会因身份不匹配而拒绝握手。
const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(here, 'mengka-plugin.json'), 'utf8'))
const declaredEvents = manifest?.runtime?.events || []
const illegalEvents = declaredEvents.filter(e => !EVENT_PERMISSIONS.includes(e))
if (illegalEvents.length) {
  throw new Error(`清单声明了不受支持的事件：${illegalEvents.join(', ')}（允许：${EVENT_PERMISSIONS.join(', ')}）`)
}
if (manifest.plugin_id !== PLUGIN_ID) {
  throw new Error(`清单 plugin_id(${manifest.plugin_id}) 与代码 PLUGIN_ID(${PLUGIN_ID}) 不一致`)
}
if (manifest.version !== VERSION) {
  throw new Error(`清单 version(${manifest.version}) 与代码 VERSION(${VERSION}) 不一致`)
}
const declaredActions = manifest?.runtime?.actions || []
const missing = ACTIONS.filter(a => !declaredActions.includes(a))
if (missing.length) {
  throw new Error(`代码会调用但清单未声明的 action：${missing.join(', ')}`)
}

const plugin = createNativePlugin({
  pluginId: PLUGIN_ID,
  version: VERSION,
  actions: ACTIONS,
})

const fallback = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'mengka', PLUGIN_ID, 'data',
)
const dataPath = plugin.dataPath || process.env.MENGKA_PLUGIN_DATA_DIR || fallback
if (!path.isAbsolute(dataPath)) throw new Error('插件数据目录必须是绝对路径')

const core = createAssistant({ api: plugin.api, dataPath, logger: plugin.logger })

plugin.on('event', event => {
  core.handleEvent(event).catch(e => plugin.logger.error(`事件处理失败：${e.message}`))
})
plugin.on('ready', () => core.setConnected(true))
plugin.api.on('disconnected', () => { core.connected = false })

// 管理端（由框架分配端口；未分配则只提供本机兜底端口）
let admin = null
const adminPort = Number(process.env.MENGKA_PLUGIN_ADMIN_PORT || 0)
if (adminPort) {
  admin = createAdminServer({
    core,
    logger: plugin.logger,
    port: adminPort,
    host: process.env.MENGKA_PLUGIN_ADMIN_HOST || '127.0.0.1',
    origin: String(process.env.MENGKA_PLUGIN_ADMIN_ORIGIN || ''),
    tokenFile: process.env.MENGKA_PLUGIN_ADMIN_TOKEN_FILE || '',
  })
  admin.start().catch(e => plugin.logger.error(`管理端启动失败：${e.message}`))
}

const close = () => {
  core.close()
  admin?.stop()
  plugin.close()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)

try {
  await plugin.start()
  plugin.logger.info(`独角数卡商城助手 ${VERSION} 已通过 native-ipc-v1 接入`)
} catch (error) {
  core.close()
  plugin.logger.error(`IPC 启动失败：${error.message}`)
  process.exitCode = 1
}
