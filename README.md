# 独角数卡商城助手（dujiao-shop）

把 [独角数卡](https://github.com/)（Dujiao-Next）商城接入 QQ 的萌卡 NT 插件。用户直接在 QQ 里逛商城、下单、支付、查卡密，无需打开网页。

- **插件 ID**：`dujiao-shop`
- **框架要求**：萌卡 NT ≥ 3.0.0（native-ipc-v1 插件）；Windows 版需 ≥ 3.0.7
- **运行形态**：原生 IPC 插件，自带 Node 运行时，不依赖宿主机 Node.js
- **支持平台**：Windows amd64 / Linux amd64 / Linux arm64
  - Windows：框架直接运行 PE 可执行文件，无需 Docker
  - Linux：框架使用 **Docker 容器** 运行，需先在「插件服务 → IPC 导入」检测并准备 Docker 环境

## 功能

| 指令 | 说明 |
| --- | --- |
| `/dj list [页码]` | 浏览商品（价格、库存） |
| `/dj search 关键词` | 搜索商品 |
| `/dj info 序号` | 商品详情（含 SKU 规格） |
| `/dj bind 密码` | 设置查询密码（下单邮箱自动用 QQ 号） |
| `/dj buy 序号 [数量]` | 下单 → 返回支付链接 → 自动轮询确认支付 → 返回卡密 |
| `/dj orders [页码]` | 查看本人订单与卡密 |
| `/dj shop [序号]` | 查看 / 切换商城 |
| `/dj help` | 帮助菜单 |

> 指令前缀默认 `/dj` 和 `独角`，可在管理后台修改。

## 下单与支付流程

1. 用户发送 `/dj buy 1`；
2. 插件立即返回订单号、金额、支付链接；
3. 插件在后台轮询订单状态（每 3 秒一次，最长 5 分钟）；
4. **支付成功**：自动返回订单结果和卡密；
5. **超时**：返回「支付超时」提示，用户可稍后用 `/dj orders` 查看。

轮询参数可用环境变量覆盖：

- `DJ_POLL_INTERVAL_MS`：轮询间隔（毫秒，默认 3000）
- `DJ_POLL_TIMEOUT_MS`：轮询总时长（毫秒，默认 5 分钟）

## 目录结构

```text
源码/
├── index.js                入口（握手、生命周期、启动自检、管理端）
├── core.js                 业务（事件派发、协议选择、指令、商城 API、轮询）
├── admin.js                管理端 HTTP 服务
├── build.js                打包脚本
├── mengka-plugin.json      插件清单
├── web/index.html          管理后台页面
├── sdk/                    官方 Node.js SDK（native-plugin / common / contracts）
└── bin/node-win-x64.exe    Node 运行时（打包时复制进 zip）
```

## 打包

先把对应平台的 Node 运行时放到 `bin/` 下：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows amd64 | `bin/node-win-x64.exe` | PE 可执行文件 |
| Linux amd64 | `bin/node-linux-x64` | ELF x86-64 |
| Linux arm64 | `bin/node-linux-arm64` | ELF AArch64 |

然后执行：

```bash
node build.js                # 打全部三平台
node build.js win            # 只打 Windows
node build.js linux-amd64    # 只打 Linux amd64
node build.js linux-arm64    # 只打 Linux arm64
```

输出到上一级目录：

- `独角数卡商城助手-<版本>-windows-amd64.zip`
- `独角数卡商城助手-<版本>-linux-amd64.zip`
- `独角数卡商城助手-<版本>-linux-arm64.zip`

每个包只包含本平台的可执行文件，清单里的 `runtime.entry` 会自动指向对应文件；Linux 入口写入 0755 权限位。

打包会排除 `.git`、`data`（运行数据）、`build.js`、`.gitignore`、`README.md` 和测试文件。

> 注意：更新包版本号必须高于已安装版本，否则框架会拒绝导入。

## 安装到萌卡 NT

1. 萌卡控制台 → 插件 → 上传插件；
2. 选择打包生成的 zip；
3. 勾选「来源可信」→ 导入 → 启动；
4. 打开插件「管理后台」：
   - 在「商城配置」填写商城根地址（如 `http://127.0.0.1:8080`，不要带 `/api/v1`）；
   - 点「测试」确认连通（会显示商品数）；
   - 点「保存商城」；
5. 在 QQ 里给机器人发 `/dj help` 验证。

## 首次使用（用户侧）

1. 先设置查询密码：`/dj bind 你的密码`（下单邮箱自动用 `QQ号@qq.com`）；
2. 浏览：`/dj list`；
3. 下单：`/dj buy 序号`；
4. 支付完成后，插件自动返回卡密；也可随时 `/dj orders` 查看。

## 数据与安全

- 商城地址、用户查询密码使用 AES-256-GCM 加密存储在插件自己的数据目录（`data/`），不入库、不推送；
- 不读取框架账号缓存、数据库或授权文件；
- 群聊默认只响应 @机器人 或带指令前缀的消息；
- 机器人自己发出的消息不会触发回复。

## 开发说明

- 事件按官方规范走 `post_type` 字段（`group_message` / `friend_message` / `group_temp_message` 等）；
- 发送消息用 `self_id + protocol_id` 定位账号，`protocol_id` 取自框架返回的账号实例；
- 启动时会校验清单与代码的 `plugin_id` / `version` / `actions` / `events` 一致性，不一致会直接报错。

## 版本历史

- **2.2.0**：下单后自动轮询订单状态（最长 5 分钟），支付成功返回卡密，超时提示。
- **2.1.4**：修复商城地址为空时保存被静默忽略的问题。
- **2.1.3**：修复 `commandPrefix` 类型错误、发送测试消息取不到在线账号。
- **2.1.2**：按官方 Node.js SDK 文档对齐，更新官方 SDK，修复版本号不一致导致握手失败。
- **2.1.1**：移除非法事件 `message_sent`。
- **2.1.0**：下单邮箱自动用 QQ 号，移除按订单号查询，改为 `/dj orders` 查看订单与卡密。
- **2.0.0**：参考 cardlike-assistant 重写，事件按 `post_type` 派发。

## License

本项目为个人自用插件，随源码分发，不含任何授权凭据。
