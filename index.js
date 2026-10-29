/**
 * QBuddy · Host 半。
 *
 * 在 loopback web 服务器上挂一条前缀路由：
 *   POST /prompt-enhance-v2/enhance   { preset?, draft }
 *   GET  /prompt-enhance-v2/settings   -> 当前档 + 内置四档 + 自定义预设 + 模型/超时 + 能否写配置
 *   PUT  /prompt-enhance-v2/settings   { preset } | { presets } | { config } -> 写进 profile 配置
 *   GET  /prompt-enhance-v2/providers  -> 已注册的模型路由，供配置页下拉候选
 *   GET  /prompt-enhance-v2/models?provider= -> 该路由下适配器自报的模型，供配置页下拉候选
 *
 * 收到草稿后取预设文本，用 `ctx.get("llm")` 发一次独立调用，把清洗后的
 * 改写结果原样返回给 Client 半。增强不进入对话历史——这条链路只碰
 * 输入框草稿，不碰 session / transcript。
 *
 * 切档只改下一次调用用的预设：请求进入时就把预设解析好，之后写配置
 * （即使触发 Loader 热重载）也不会动到已经在跑的那一次。
 *
 * 骨架层（与预设文本无关的固定行为）全部收在这一处：
 *   - user 模板只认 `{{draft}}`；
 *   - 草稿超过 8000 字符截断并加省略号；
 *   - 超时 30 秒（timeoutMs 可配）；
 *   - temperature 0.2，输出预算不设上限（交给适配器）；
 *   - 输出清洗：剥整段围栏 + 循环剥两端成对引号；
 *   - 失败只回错误码，绝不回空串让调用方误写。
 */

import z from '@deepseek-ai/schemastery'
import {
  CUSTOM_DEFAULT_LABEL,
  CUSTOM_DEFAULT_SYSTEM,
  CUSTOM_DEFAULT_USER,
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  DRAFT_TOKEN,
  PRESETS,
  isCustomPresetId,
  presetById,
  renderUserTemplate,
} from './presets.js'

const ROUTE_PREFIX = '/prompt-enhance-v2'
const ROUTE_ENHANCE = ROUTE_PREFIX + '/enhance'
const ROUTE_SETTINGS = ROUTE_PREFIX + '/settings'
const ROUTE_PROVIDERS = ROUTE_PREFIX + '/providers'
const ROUTE_MODELS = ROUTE_PREFIX + '/models'
const ROUTE_MODEL_INFO = ROUTE_PREFIX + '/model-info'
const ROUTE_NAME = 'prompt-enhance-v2'
/** cordis.patch.yml 里的 Loader 条目 id：写配置时按它找条目。与包名、客户端模块 id 一致。 */
const ENTRY_ID = 'dsh-qbuddy-prompt-enhance'

const MAX_BODY_BYTES = 256 * 1024
const MAX_DRAFT_CHARS = 8000
const MAX_CUSTOM_NAME_CHARS = 40
const MAX_TEMPLATE_CHARS = 8000
const MAX_PROVIDER_CHARS = 200
const DEFAULT_TIMEOUT_MS = 30_000
const TEMPERATURE = 0.2

/** 与 cordis.patch.yml 的内置值一致；写配置时与默认值相同的键不落盘。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  preset: DEFAULT_PRESET_ID,
  provider: '',
  model: '',
  reasoningEffort: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  customPresets: Object.freeze([]),
  customName: '',
  customSystem: '',
  customUser: '',
})

/**
 * 可运行时修改的字段全部标成 volatile：切档 / 存自定义预设 / 改模型与超时
 * 时 Loader 只就地提交引用，不停重启整个插件条目；`enabled` 仍是普通字段，
 * 开关插件走完整生命周期。
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  preset: z.string().default(DEFAULT_PRESET_ID).volatile(),
  provider: z.string().default(DEFAULTS.provider).volatile(),
  model: z.string().default(DEFAULTS.model).volatile(),
  // 思考强度：空串 = 用模型自己的默认档；非空时随请求发给适配器。
  reasoningEffort: z.string().default(DEFAULTS.reasoningEffort).volatile(),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs).volatile(),
  customPresets: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        system: z.string(),
        user: z.string(),
      }),
    )
    .default([])
    .volatile(),
  // 0.5.x 的单档自定义字段：只用来迁移到 customPresets，保存后会被清掉。
  customName: z.string().default(DEFAULTS.customName).volatile(),
  customSystem: z.string().default(DEFAULTS.customSystem).volatile(),
  customUser: z.string().default(DEFAULTS.customUser).volatile(),
})

/** 与讨论中的清洗实现逐字符一致：两端都在集合里才剥，不做配对映射。 */
const QUOTES = new Set(['"', "'", '`', '\u201C', '\u201D', '\u2018', '\u2019', '\u300C', '\u300D'])

/**
 * 输出清洗：
 *   1. trim；
 *   2. 整段被一个代码围栏包住时剥掉围栏；
 *   3. 循环剥两端引号，直到两端不再同时是引号字符。
 * 不配对、只有一端是引号、引号在句中都保持原样。
 */
export function cleanOutput(raw) {
  let text = String(raw ?? '').trim()
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/)
  if (fenced) text = fenced[1].trim()
  while (text.length >= 2 && QUOTES.has(text[0]) && QUOTES.has(text[text.length - 1])) {
    text = text.slice(1, -1).trim()
  }
  return text
}

function numberInRange(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/** volatile 字段是稳定引用：每次读快照；普通值原样返回。 */
function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** 把可能残缺的 config 归一成运行时有效配置。 */
export function effectiveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const enabled = readValue(source.enabled)
  const preset = readValue(source.preset)
  const provider = readValue(source.provider)
  const model = readValue(source.model)
  const reasoningEffort = readValue(source.reasoningEffort)
  const timeoutMs = readValue(source.timeoutMs)
  const customPresets = readValue(source.customPresets)
  const customName = readValue(source.customName)
  const customSystem = readValue(source.customSystem)
  const customUser = readValue(source.customUser)
  const saved = sanitizeStoredPresets(customPresets)
  return {
    enabled: enabled !== false,
    preset: typeof preset === 'string' && preset.trim() !== '' ? preset.trim() : DEFAULT_PRESET_ID,
    provider: typeof provider === 'string' ? provider.trim().slice(0, MAX_PROVIDER_CHARS) : '',
    model: typeof model === 'string' ? model.trim().slice(0, MAX_PROVIDER_CHARS) : '',
    // 空串 = 用模型自己的默认档；非空时随请求发给适配器。
    reasoningEffort:
      typeof reasoningEffort === 'string' ? reasoningEffort.trim().slice(0, MAX_PROVIDER_CHARS) : '',
    timeoutMs: numberInRange(timeoutMs, 100, 600_000) ?? DEFAULT_TIMEOUT_MS,
    // 旧字段只在列表为空时兜底迁移，避免两份数据打架。
    customPresets: saved.length > 0 ? saved : legacyPresets(customName, customSystem, customUser),
  }
}

/** 手改 YAML 也可能写坏：运行时只保留形状完整、模板可用的条目。 */
function sanitizeStoredPresets(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const list = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!isCustomPresetId(id) || seen.has(id)) continue
    const system = typeof item.system === 'string' ? item.system.trim() : ''
    const user = typeof item.user === 'string' ? item.user.trim() : ''
    if (system === '' || !user.includes(DRAFT_TOKEN)) continue
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_CUSTOM_NAME_CHARS) : ''
    seen.add(id)
    list.push({
      id,
      name,
      system: system.slice(0, MAX_TEMPLATE_CHARS),
      user: user.slice(0, MAX_TEMPLATE_CHARS),
    })
  }
  return list
}

/** 0.5.x 的单档字段 -> 一个 id 为 `custom` 的预设。 */
function legacyPresets(name, system, user) {
  const systemText = typeof system === 'string' ? system.trim() : ''
  const userText = typeof user === 'string' ? user.trim() : ''
  if (systemText === '' && userText === '') return []
  return [
    {
      id: CUSTOM_PRESET_ID,
      name: typeof name === 'string' ? name.trim().slice(0, MAX_CUSTOM_NAME_CHARS) : '',
      system: systemText,
      user: userText,
    },
  ]
}

/** 配置里的自定义预设 -> 可直接渲染的预设。 */
function customPreset(config, id) {
  const found = config.customPresets.find((entry) => entry.id === id)
  if (found === undefined) return null
  const name = found.name
  return {
    id: found.id,
    label: {
      zh: name !== '' ? name : CUSTOM_DEFAULT_LABEL.zh,
      en: name !== '' ? name : CUSTOM_DEFAULT_LABEL.en,
    },
    system: found.system,
    user: found.user,
    custom: true,
    configured: found.system.trim() !== '' && found.user.includes(DRAFT_TOKEN),
  }
}

/**
 * 空 id 走配置当前档；自定义档从配置实时解析，其余查静态注册表。
 * 显式传了未知 id -> null（路由回 400）；配置里的当前档被删掉 ->
 * 回落到默认档，避免留下悬空引用让按钮整条链路都失败。
 */
export function resolvePreset(config, id) {
  const explicit = typeof id === 'string' && id.trim() !== ''
  const key = explicit ? id.trim() : config.preset
  if (isCustomPresetId(key)) return customPreset(config, key)
  const builtin = presetById(key)
  if (builtin !== null) return builtin
  return explicit ? null : presetById(DEFAULT_PRESET_ID)
}

/** 数组/对象也要按值比较：默认值是空数组，引用永远不相等。 */
function sameValue(value, fallback) {
  if (value === fallback) return true
  if (Array.isArray(value) && Array.isArray(fallback)) {
    return JSON.stringify(value) === JSON.stringify(fallback)
  }
  return false
}

/** 与默认值相同的键不写进 patch，于是「恢复默认」= 删掉该项。 */
function storedConfig(config) {
  const stored = {}
  for (const [field, value] of Object.entries(config)) {
    const fallback = DEFAULTS[field]
    if (!sameValue(value, fallback)) stored[field] = value
  }
  return stored
}

/** 只信任 loopback 同源请求，避免本机其他页面驱动模型调用。 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (!(hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1')) {
    return false
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', rejectPromise)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, status, code, message, extra = {}) {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } })
}

/** 可选服务读取：服务没挂载时返回 undefined，而不是抛错。 */
function peek(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 已注册的模型路由（就是设置页「模型」里那批 provider），供配置页下拉候选。 */
async function providerList(scope) {
  const llm = peek(scope, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') {
    return { error: '当前 profile 没有 llm.listProviders，无法列出 provider' }
  }
  try {
    const list = await llm.listProviders()
    if (!Array.isArray(list)) return { providers: [] }
    const providers = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id : ''
      if (id === '') continue
      providers.push({ id, name: typeof item.name === 'string' && item.name !== '' ? item.name : id })
    }
    return { providers }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 某个 provider 下适配器自报的模型，供配置页 model 下拉候选。 */
async function modelList(scope, provider) {
  const llm = peek(scope, 'llm')
  if (!llm || typeof llm.listModels !== 'function') {
    return { error: '当前 profile 没有 llm.listModels，无法列出候选模型' }
  }
  try {
    const list = await llm.listModels(provider)
    if (!Array.isArray(list)) return { models: [] }
    const models = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id : ''
      if (id === '') continue
      models.push({
        id,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : id,
        description: typeof item.description === 'string' ? item.description : '',
      })
    }
    return { models }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 某个 provider/model 的能力元数据：配置页靠它列出可选的思考强度。 */
async function modelInfoOf(scope, provider, model) {
  const llm = peek(scope, 'llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    return { error: '当前 profile 没有 llm.resolveModelInfo，无法列出思考强度' }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const reasoning = info && info.reasoning ? info.reasoning : null
    if (reasoning === null) return { reasoning: null }
    const efforts = Array.isArray(reasoning.efforts)
      ? reasoning.efforts
          .filter((effort) => effort && typeof effort.id === 'string' && effort.id !== '')
          .map((effort) => ({
            id: effort.id,
            name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
          }))
      : []
    return {
      reasoning: {
        efforts,
        defaultEffort: typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '',
      },
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** provider/model：显式 config 优先，其次跟随 profile 的默认模型。 */
function resolveTarget(scope, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model, source: 'config' }
  }
  const defaults = peek(scope, 'agentDefaultModel')
  const selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
  if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model, source: 'agentDefaultModel' }
  }
  return null
}

/**
 * 把 llm 分片流收成一段纯文本；终止分片决定成功还是失败。
 * 额外记下终止原因与用量：空结果时靠它们区分「模型没吐字」和「输出被截断」。
 */
async function collectText(stream) {
  let text = ''
  let failure = null
  let ended = false
  let finishKind = ''
  let usage = null
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    // 容错：只吃整块 text 的实现也能拿到结果。
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      if (text === '' && typeof chunk.block.text === 'string') text = chunk.block.text
      continue
    }
    if (chunk.type === 'finish') {
      ended = true
      const reason = chunk.reason || {}
      finishKind = typeof reason.kind === 'string' ? reason.kind : ''
      if (chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const f = reason.failure || {}
        failure = { kind: reason.kind, code: f.code || reason.kind.toUpperCase(), message: f.message || reason.kind }
      } else if (reason.kind === 'tool-calls') {
        failure = { kind: 'tool-calls', code: 'TOOL_CALLS', message: '模型返回了工具调用而不是文本' }
      }
      // 'max-tokens' 是「被截断的成功」，照常返回已生成的部分。
      break
    }
  }
  if (!ended && failure === null) failure = { kind: 'error', code: 'NO_FINISH', message: '模型流没有给出结束分片' }
  return { text, failure, finishKind, usage }
}

function createRoutes(scope, config) {
  // config 里 preset 等字段是 volatile 引用：每次请求现读，才能拿到 Loader 就地提交的新值。
  const liveConfig = () => effectiveConfig(config)

  function snapshotOf(live) {
    const current = resolvePreset(live, '')
    const editor = peek(scope, 'configEditor')
    const canWrite = Boolean(editor && typeof editor.edit === 'function' && typeof editor.entries === 'function')
    return {
      current: current === null ? DEFAULT_PRESET_ID : current.id,
      presets: [
        ...PRESETS.map((preset) => ({
          id: preset.id,
          label: { ...preset.label },
          description: { ...preset.description },
        })),
        ...live.customPresets.map((entry) => ({
          id: entry.id,
          label: {
            zh: entry.name !== '' ? entry.name : CUSTOM_DEFAULT_LABEL.zh,
            en: entry.name !== '' ? entry.name : CUSTOM_DEFAULT_LABEL.en,
          },
          custom: true,
        })),
      ],
      canWrite,
      entryId: ENTRY_ID,
      config: {
        provider: live.provider,
        model: live.model,
        reasoningEffort: live.reasoningEffort,
        timeoutMs: live.timeoutMs,
      },
      customPresets: live.customPresets.map((entry) => ({ ...entry })),
      // 详情页「新建」时的起步模板：用户改的是自己那份，内置四档不受影响。
      customDefaults: {
        name: { ...CUSTOM_DEFAULT_LABEL },
        system: CUSTOM_DEFAULT_SYSTEM,
        user: CUSTOM_DEFAULT_USER,
      },
    }
  }

  /** 自定义预设列表校验：形状、id 约定、去重、必填、占位符、长度。 */
  function parseCustomPresets(raw) {
    if (!Array.isArray(raw)) return { error: 'customPresets 必须是数组' }
    const seen = new Set()
    const list = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { error: '每个自定义预设必须是对象' }
      }
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (!isCustomPresetId(id)) return { error: '自定义预设 id 必须以 custom 开头' }
      if (seen.has(id)) return { error: '自定义预设 id 重复：' + id }
      seen.add(id)
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      const system = typeof item.system === 'string' ? item.system.trim() : ''
      const user = typeof item.user === 'string' ? item.user.trim() : ''
      if (name === '') return { error: '名称不能为空' }
      if (name.length > MAX_CUSTOM_NAME_CHARS) return { error: '名称最长 ' + MAX_CUSTOM_NAME_CHARS + ' 字符' }
      if (system === '') return { error: 'System 模板不能为空' }
      if (!user.includes(DRAFT_TOKEN)) return { error: 'User 模板必须包含 ' + DRAFT_TOKEN }
      if (system.length > MAX_TEMPLATE_CHARS || user.length > MAX_TEMPLATE_CHARS) {
        return { error: '模板最长 ' + MAX_TEMPLATE_CHARS + ' 字符' }
      }
      list.push({ id, name, system, user })
    }
    return { list }
  }

  /** 详情页的模型 / 超时字段：只接受这三项，其余不动。 */
  function parseSettingsConfig(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'config 必须是对象' }
    const values = {}
    for (const field of ['provider', 'model', 'reasoningEffort']) {
      if (!(field in raw)) continue
      const value = raw[field]
      if (typeof value !== 'string') return { error: field + ' 必须是字符串' }
      const trimmed = value.trim()
      if (trimmed.length > MAX_PROVIDER_CHARS) return { error: field + ' 最长 ' + MAX_PROVIDER_CHARS + ' 字符' }
      values[field] = trimmed
    }
    if ('timeoutMs' in raw) {
      const timeout = numberInRange(raw.timeoutMs, 100, 600_000)
      if (timeout === null) return { error: 'timeoutMs 必须是 100–600000 之间的数字' }
      values.timeoutMs = Math.round(timeout)
    }
    return { values }
  }

  function handleGetSettings(req, res) {
    sendJson(res, 200, { ok: true, data: snapshotOf(liveConfig()) })
  }

  /** 配置页 provider 下拉候选：列不出来不算失败，回空列表 + 原因。 */
  async function handleListProviders(req, res) {
    const result = await providerList(scope)
    if (typeof result.error === 'string') {
      sendJson(res, 200, { ok: true, data: { providers: [], note: result.error } })
      return
    }
    sendJson(res, 200, { ok: true, data: { providers: result.providers } })
  }

  /** 配置页 model 下拉候选：provider 省略时按当前生效路由取。 */
  async function handleListModels(req, res, url) {
    const wanted = (url.searchParams.get('provider') || '').trim()
    const target = wanted !== '' ? { provider: wanted } : resolveTarget(scope, liveConfig())
    const provider = target === null ? '' : target.provider
    if (provider === '') {
      fail(res, 400, 'NO_PROVIDER', '需要一个 provider 才能列出候选模型')
      return
    }
    if (provider.length > MAX_PROVIDER_CHARS || /[\r\n]/.test(provider)) {
      fail(res, 400, 'BAD_PROVIDER', 'provider 不合法')
      return
    }
    const result = await modelList(scope, provider)
    if (typeof result.error === 'string') {
      // 候选只是输入辅助：列不出来不算失败。
      sendJson(res, 200, { ok: true, data: { provider, models: [], note: result.error } })
      return
    }
    sendJson(res, 200, { ok: true, data: { provider, models: result.models } })
  }

  /** 配置页「思考强度」候选：列不出来不算失败，回空列表 + 原因。 */
  async function handleModelInfo(req, res, url) {
    const provider = (url.searchParams.get('provider') || '').trim()
    const model = (url.searchParams.get('model') || '').trim()
    if (provider === '' || model === '') {
      fail(res, 400, 'NO_TARGET', '需要 provider 与 model 才能查思考强度')
      return
    }
    if (
      provider.length > MAX_PROVIDER_CHARS ||
      model.length > MAX_PROVIDER_CHARS ||
      /[\r\n]/.test(provider + model)
    ) {
      fail(res, 400, 'BAD_TARGET', 'provider / model 不合法')
      return
    }
    const result = await modelInfoOf(scope, provider, model)
    if (typeof result.error === 'string') {
      sendJson(res, 200, { ok: true, data: { provider, model, reasoning: null, note: result.error } })
      return
    }
    sendJson(res, 200, { ok: true, data: { provider, model, reasoning: result.reasoning } })
  }

  /**
   * 切档 / 存自定义预设 / 改模型与超时：写进当前 profile 的 patch 层，交给官方
   * configEditor 完成校验、原子写盘和 Loader 协调（保留 YAML 注释，写完热重载）。
   * 随后由 Loader 就地更新 volatile 引用，本次进程内下一次调用立刻用新值。
   */
  async function handleSaveSettings(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      fail(res, 400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      return
    }

    const wantsPresets = body.presets !== undefined
    const wantsConfig = body.config !== undefined
    const requested = typeof body.preset === 'string' ? body.preset.trim() : ''
    if (!wantsPresets && !wantsConfig && requested === '') {
      fail(res, 400, 'UNKNOWN_PRESET', '缺少 preset / presets / config 字段')
      return
    }

    const parsedPresets = wantsPresets ? parseCustomPresets(body.presets) : null
    if (parsedPresets !== null && parsedPresets.error !== undefined) {
      fail(res, 400, 'BAD_PRESETS', parsedPresets.error)
      return
    }
    const parsedConfig = wantsConfig ? parseSettingsConfig(body.config) : null
    if (parsedConfig !== null && parsedConfig.error !== undefined) {
      fail(res, 400, 'BAD_CONFIG', parsedConfig.error)
      return
    }

    // 先在内存里拼出写入后的完整配置，再据此校验目标档位；
    // 同一次 PUT 里存预设 + 切档也能算对。
    const next = { ...liveConfig() }
    if (parsedPresets !== null) {
      next.customPresets = parsedPresets.list
      // 迁移完成：旧单档字段不再落盘。
      next.customName = ''
      next.customSystem = ''
      next.customUser = ''
    }
    if (parsedConfig !== null) Object.assign(next, parsedConfig.values)

    if (requested !== '') {
      const target = resolvePreset(next, requested)
      if (target === null) {
        fail(res, 400, 'UNKNOWN_PRESET', '未知预设：' + requested)
        return
      }
      if (target.configured === false) {
        fail(res, 409, 'CUSTOM_EMPTY', '自定义预设还没配置：先在插件详情页填写 system / user 模板')
        return
      }
      next.preset = target.id
    } else if (isCustomPresetId(next.preset) && customPreset(next, next.preset) === null) {
      // 当前档被删掉：回默认档，不留悬空引用。
      next.preset = DEFAULT_PRESET_ID
    }

    const editor = peek(scope, 'configEditor')
    if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
      fail(res, 503, 'NO_EDITOR', '当前宿主没有 configEditor 服务，无法写入 profile 配置')
      return
    }

    let entry = null
    try {
      entry = editor.entries().find((row) => row?.options?.id === ENTRY_ID) ?? null
    } catch (error) {
      scope.logger?.warn?.('[prompt-enhance-v2] 读取 Loader 条目失败：' + String(error?.message || error))
    }
    if (entry === null) {
      fail(res, 503, 'NO_ENTRY', '找不到 Loader 条目 ' + ENTRY_ID + '，无法写入 profile 配置')
      return
    }

    try {
      await editor.edit(entry, () => storedConfig(next))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      scope.logger?.warn?.('[prompt-enhance-v2] 保存设置失败：' + message)
      fail(res, 409, 'WRITE_FAILED', '写入 profile 配置失败：' + message)
      return
    }

    // 不覆盖 config 上的引用：它们都是 volatile，edit 返回前 Loader 已就地提交；
    // 写成普通值反而会让引用失联，后续读到的还是旧值。
    sendJson(res, 200, { ok: true, data: { ...snapshotOf(next), saved: true } })
  }

  async function handleEnhance(req, res) {
    const live = liveConfig()
    if (!live.enabled) {
      fail(res, 409, 'DISABLED', '提示词增强已在插件配置里关闭')
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      fail(res, 400, 'BAD_REQUEST', error instanceof Error ? error.message : String(error))
      return
    }

    const requested = typeof body.preset === 'string' ? body.preset : ''
    const preset = resolvePreset(live, requested)
    if (preset === null) {
      fail(res, 400, 'UNKNOWN_PRESET', '未知预设：' + (requested !== '' ? requested : live.preset))
      return
    }
    if (preset.configured === false) {
      fail(res, 409, 'CUSTOM_EMPTY', '自定义预设还没配置：先在插件详情页填写 system / user 模板')
      return
    }

    const draft = typeof body.draft === 'string' ? body.draft.trim() : ''
    if (draft === '') {
      fail(res, 400, 'EMPTY_DRAFT', '提示词不能为空')
      return
    }

    const truncated = draft.length > MAX_DRAFT_CHARS ? draft.slice(0, MAX_DRAFT_CHARS) + '...' : draft
    const userPrompt = renderUserTemplate(preset.user, truncated)
    if (userPrompt === null) {
      fail(res, 500, 'BAD_TEMPLATE', '预设的 user 模板缺少 ' + '{{draft}}' + ' 占位符')
      return
    }

    const llm = peek(scope, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      fail(res, 503, 'NO_LLM', '当前 profile 没有挂载 llm 服务，无法增强提示词')
      return
    }

    const target = resolveTarget(scope, live)
    if (target === null) {
      fail(res, 503, 'NO_TARGET', '无法确定模型：请在插件配置里填写 provider/model，或先设置默认模型')
      return
    }

    // 浏览器关掉面板/切走时顺手取消这次模型调用，别让它白跑。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('增强超时')), live.timeoutMs)
    if (res && typeof res.on === 'function') {
      res.on('close', () => {
        if (res.writableEnded !== true) controller.abort(new Error('客户端已断开'))
      })
    }

    try {
      // prepareCall 让适配器把默认值先物化；没有它就直连 stream。
      // 不设 maxTokens：推理模型会先把预算烧在 reasoning 上，
      // 按草稿长度推算的小上限会让 content 直接变成空串。
      const baseRequest = {
        provider: target.provider,
        model: target.model,
        temperature: TEMPERATURE,
      }
      // 思考强度只在显式配置时发；空串 = 用适配器自己的默认档。
      const wantedEffort = live.reasoningEffort !== '' ? live.reasoningEffort : ''
      const request =
        wantedEffort === '' ? baseRequest : { ...baseRequest, reasoningEffort: wantedEffort }
      let prepared = null
      if (typeof llm.prepareCall === 'function') {
        try {
          prepared = await llm.prepareCall(request, controller.signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (controller.signal.aborted) {
            fail(res, 504, 'TIMEOUT', '增强超时，请重试')
            return
          }
          if (wantedEffort === '') {
            scope.logger?.warn?.('[prompt-enhance-v2] prepareCall 失败：' + message)
            fail(res, 503, 'MODEL_UNAVAILABLE', '模型未就绪：' + message)
            return
          }
          // 配的那一档被模型撤了（换模型 / 适配器改版）：丢掉强度重试一次，
          // 别让一个可选旋钮把整条增强链打死。
          scope.logger?.warn?.('[prompt-enhance-v2] 思考强度不可用，退回默认档：' + message)
          try {
            prepared = await llm.prepareCall(baseRequest, controller.signal)
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
            fail(res, 503, 'MODEL_UNAVAILABLE', '模型未就绪：' + retryMessage)
            return
          }
        }
      }

      const options = {
        ...(prepared && prepared.config ? prepared.config : request),
        system: preset.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        signal: controller.signal,
      }

      let result
      try {
        const stream = prepared && typeof prepared.stream === 'function' ? prepared.stream(options) : llm.stream(options)
        result = await collectText(stream)
      } catch (error) {
        result = {
          text: '',
          failure: { kind: 'error', code: 'LLM_ERROR', message: error instanceof Error ? error.message : String(error) },
        }
      }

      if (result.failure !== null) {
        if (controller.signal.aborted) {
          fail(res, 504, 'TIMEOUT', '增强超时，请重试')
          return
        }
        scope.logger?.warn?.('[prompt-enhance-v2] 模型调用失败：' + result.failure.code + ' ' + result.failure.message)
        fail(res, 502, result.failure.code, result.failure.message, {
          provider: target.provider,
          model: target.model,
        })
        return
      }

      const text = cleanOutput(result.text)
      if (text === '') {
        // 截断与真空分开报：前者是输出预算不够（推理吃光了），后者是模型没吐字。
        const truncated = result.finishKind === 'max-tokens'
        scope.logger?.warn?.(
          '[prompt-enhance-v2] 模型没有返回文本：finish=' +
            (result.finishKind || 'none') +
            ' usage=' +
            JSON.stringify(result.usage ?? null),
        )
        fail(res, 502, truncated ? 'OUTPUT_TRUNCATED' : 'EMPTY_RESULT', truncated ? '模型输出被截断，请重试' : '模型返回了空结果', {
          provider: target.provider,
          model: target.model,
        })
        return
      }

      sendJson(res, 200, {
        ok: true,
        data: {
          text,
          preset: preset.id,
          provider: target.provider,
          model: target.model,
        },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  return async function handler(req, res) {
    try {
      if (!isTrustedRequest(req)) {
        fail(res, 403, 'FORBIDDEN', '只接受本机同源请求')
        return
      }
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname
      if (req.method === 'GET' && (pathname === ROUTE_PREFIX || pathname === ROUTE_PREFIX + '/')) {
        sendJson(res, 200, {
          ok: true,
          data: {
            plugin: ROUTE_NAME,
            routes: [ROUTE_ENHANCE, ROUTE_SETTINGS, ROUTE_PROVIDERS, ROUTE_MODELS, ROUTE_MODEL_INFO],
          },
        })
        return
      }
      if (req.method === 'GET' && pathname === ROUTE_SETTINGS) {
        handleGetSettings(req, res)
        return
      }
      if (req.method === 'GET' && pathname === ROUTE_PROVIDERS) {
        await handleListProviders(req, res)
        return
      }
      if (req.method === 'GET' && pathname === ROUTE_MODELS) {
        await handleListModels(req, res, url)
        return
      }
      if (req.method === 'GET' && pathname === ROUTE_MODEL_INFO) {
        await handleModelInfo(req, res, url)
        return
      }
      if (req.method === 'PUT' && pathname === ROUTE_SETTINGS) {
        await handleSaveSettings(req, res)
        return
      }
      if (req.method === 'POST' && pathname === ROUTE_ENHANCE) {
        await handleEnhance(req, res)
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路由 ' + pathname } })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/** 挂载路由并接进 Cordis 生命周期；热重载撞到旧路由时只告警。 */
function mountRoutes(owner, webServer, config) {
  let unregister = null
  try {
    unregister = webServer.register({
      name: ROUTE_NAME,
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createRoutes(owner, config),
    })
  } catch (error) {
    owner.logger?.warn?.('[prompt-enhance-v2] 路由挂载失败：' + String(error?.message || error))
    return () => {}
  }
  const dispose = () => {
    try {
      if (typeof unregister === 'function') unregister()
    } catch (error) {
      owner.logger?.warn?.('[prompt-enhance-v2] 路由卸载失败：' + String(error?.message || error))
    }
  }
  const effect = owner.effect || owner.ctx?.effect
  if (typeof effect === 'function') effect(() => dispose)
  owner.logger?.info?.('[prompt-enhance-v2] routes mounted at ' + ROUTE_PREFIX)
  return dispose
}

export const name = ROUTE_NAME

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      mountRoutes(scope, scope.webServer, config)
    })
    return
  }
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[prompt-enhance-v2] 当前组合没有 webServer，增强路由不会挂载')
    return
  }
  mountRoutes(ctx, webServer, config)
}