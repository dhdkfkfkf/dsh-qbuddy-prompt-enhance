/**
 * Host 半冒烟：用假的 ctx / webServer / llm 挂载真实路由，覆盖：
 *   1. 前缀路由不能带尾部斜杠；
 *   2. 只接受 loopback 同源请求（403）；
 *   3. user 模板只认 {{draft}}，超 8000 字符截断；
 *   4. temperature 0.2，不设 maxTokens（推理模型会把小预算烧光）；
 *   5. 超时可配（默认 30s），到点 504；
 *   6. 输出先清洗再返回；失败只回错误码，绝不回空串；
 *   7. settings 读写、configEditor 落盘、切档不影响在途调用；
 *   8. 任意多个自定义预设的增删改、旧单档字段迁移、模型/超时写入。
 *
 * 不触网：llm 全部是本地假实现。
 */
import { Readable } from 'node:stream'
import { apply, cleanOutput, Config, effectiveConfig, name } from '../index.js'
import { DEFAULT_PRESET_ID, PRESETS } from '../presets.js'

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log('  ok   ' + label)
  } else {
    fail += 1
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}
const eq = (label, actual, expected) => {
  check(label, actual === expected, JSON.stringify({ actual, expected }))
}

const ROUTE_PREFIX = '/prompt-enhance-v2'
const ROUTE_ENHANCE = '/prompt-enhance-v2/enhance'
const ROUTE_SETTINGS = '/prompt-enhance-v2/settings'
const ROUTE_MODEL_INFO = '/prompt-enhance-v2/model-info'
const byId = (id) => PRESETS.find((preset) => preset.id === id)
const QBUDDY = byId('qbuddy')
const CUSTOM_FIELDS = ['customName', 'customSystem', 'customUser']
/** Config 里所有 volatile 字段及其 schema 默认值：edit() 缺键时按它补齐。 */
const VOLATILE_FIELDS = ['preset', 'provider', 'model', 'reasoningEffort', 'timeoutMs', 'customPresets', ...CUSTOM_FIELDS]
const VOLATILE_DEFAULTS = {
  preset: DEFAULT_PRESET_ID,
  provider: '',
  model: '',
  reasoningEffort: '',
  timeoutMs: 30_000,
  customPresets: [],
  customName: '',
  customSystem: '',
  customUser: '',
}

/* ---------------- 假 webServer / ctx ---------------- */
const routes = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}
const logger = { info() {}, warn() {}, error() {} }

function textStream(chunks) {
  return async function* stream() {
    for (const chunk of chunks) yield chunk
  }
}

function volatileRef(initial) {
  let value = initial
  return {
    get: () => value,
    set(next) {
      value = next
    },
  }
}

function mount(config = {}, overrides = {}) {
  routes.length = 0
  const calls = { stream: [], prepare: [], modelInfo: [], defaultSelection: 0, edits: [], entries: 0 }
  const defaultEntry = { options: { id: 'dsh-qbuddy-prompt-enhance' }, config: {} }
  // 真实宿主交给 apply 的 config 里运行时字段都是 volatile 引用；这里同样包一层。
  const live = { ...config }
  for (const field of VOLATILE_FIELDS) {
    if (live[field] !== null && typeof live[field] === 'object' && typeof live[field].get === 'function') continue
    const initial = live[field] === undefined ? VOLATILE_DEFAULTS[field] : live[field]
    live[field] = volatileRef(initial)
  }
  const defaultEditor = {
    entries() {
      calls.entries += 1
      return [defaultEntry]
    },
    async edit(entry, build) {
      const patch = build()
      calls.edits.push({ entry, patch })
      // 模拟 Loader 的 volatile 就地提交：patch 缺键时按 schema 默认值补齐。
      for (const field of VOLATILE_FIELDS) {
        const next = Object.prototype.hasOwnProperty.call(patch, field) ? patch[field] : VOLATILE_DEFAULTS[field]
        live[field].set(next)
      }
    },
  }
  const services = {
    configEditor: defaultEditor,
    webServer: fakeWebServer,
    llm: {
      stream(options) {
        calls.stream.push(options)
        return textStream([
          { type: 'text-delta', index: 0, text: '增强后的' },
          { type: 'text-delta', index: 0, text: '提示词' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])()
      },
    },
    agentDefaultModel: {
      currentSelection() {
        calls.defaultSelection += 1
        return { provider: 'deepseek-account', model: 'deepseek-flash' }
      },
    },
  }
  if (overrides.services) Object.assign(services, overrides.services)
  const scope = {
    webServer: services.webServer,
    logger,
    get(serviceName) {
      return services[serviceName]
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  let injected = null
  const ctx = {
    logger,
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(names, callback) {
      injected = names
      return callback(scope)
    },
  }
  apply(ctx, live)
  return { route: routes[0], handler: routes[0]?.handler, calls, services, injected, config: live }
}

function request(handler, { method = 'GET', url = ROUTE_PREFIX, headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', ...headers }
  return new Promise((resolve, reject) => {
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) {
        status = code
      },
      setHeader() {},
      end(chunk) {
        payload = chunk === undefined ? '' : String(chunk)
        res.writableEnded = true
        resolve({ status, payload, json: () => JSON.parse(payload) })
      },
      on() {},
      writableEnded: false,
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const enhance = (handler, body, headers) =>
  request(handler, { method: 'POST', url: ROUTE_ENHANCE, body: typeof body === 'string' ? body : JSON.stringify(body), headers })

const saveSettings = (handler, body, headers) =>
  request(handler, {
    method: 'PUT',
    url: ROUTE_SETTINGS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  })

const getSettings = (handler, headers) => request(handler, { url: ROUTE_SETTINGS, headers })

const modelInfo = (handler, query, headers) =>
  request(handler, { url: ROUTE_MODEL_INFO + (query || ''), headers })

/* ---------------- 1. 挂载与健康检查 ---------------- */
console.log('挂载')
const first = mount()
check('注入 webServer', Array.isArray(first.injected) && first.injected.includes('webServer'), JSON.stringify(first.injected))
eq('插件 name 导出与路由一致', name, 'prompt-enhance-v2')
check('挂载了一条路由', routes.length === 1, JSON.stringify(routes.map((item) => item.path)))
check(
  '路由是 prefix 且没有尾部斜杠',
  Boolean(first.route) && first.route.kind === 'prefix' && first.route.path === ROUTE_PREFIX,
  first.route && first.route.kind + ' ' + first.route.path,
)
check('路由名与入口 id 一致', first.route?.name === 'prompt-enhance-v2', first.route?.name)
check('能匹配 /prompt-enhance-v2/enhance', first.route.path === ROUTE_PREFIX)

const health = await request(first.handler)
check('GET 前缀是健康检查', health.status === 200 && health.json().data.plugin === 'prompt-enhance-v2', health.payload)
check(
  '健康检查列出 enhance 与 settings',
  health.json().data.routes.includes(ROUTE_ENHANCE) && health.json().data.routes.includes(ROUTE_SETTINGS),
  health.payload,
)
const notFound = await request(first.handler, { url: ROUTE_PREFIX + '/nope' })
check('未知路由返回 404', notFound.status === 404, notFound.status + ' ' + notFound.payload)

/* ---------------- 2. 安全边界 ---------------- */
console.log('安全边界')
const crossSite = await enhance(first.handler, { draft: 'x' }, { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' })
check('非同源 POST 403', crossSite.status === 403 && crossSite.json().error.code === 'FORBIDDEN', crossSite.status + ' ' + crossSite.payload)
const lanHost = await enhance(first.handler, { draft: 'x' }, { host: '192.168.1.5:43120' })
check('非 loopback Host 403', lanHost.status === 403, lanHost.status + ' ' + lanHost.payload)
const originMismatch = await enhance(first.handler, { draft: 'x' }, { origin: 'http://127.0.0.1:9999' })
check('Origin 与 Host 不一致 403', originMismatch.status === 403, originMismatch.status + ' ' + originMismatch.payload)

/* ---------------- 3. 参数校验 ---------------- */
console.log('参数校验')
const badJson = await enhance(first.handler, '{not json')
check('非法 JSON 400', badJson.status === 400 && badJson.json().error.code === 'BAD_REQUEST', badJson.status + ' ' + badJson.payload)
const emptyDraft = await enhance(first.handler, { draft: '   \n\t ' })
check('空草稿 400', emptyDraft.status === 400 && emptyDraft.json().error.code === 'EMPTY_DRAFT', emptyDraft.status + ' ' + emptyDraft.payload)
const missingDraft = await enhance(first.handler, {})
check('缺草稿 400', missingDraft.status === 400 && missingDraft.json().error.code === 'EMPTY_DRAFT', missingDraft.status)
const unknownPreset = await enhance(first.handler, { preset: 'does-not-exist', draft: 'x' })
check('未知预设 400', unknownPreset.status === 400 && unknownPreset.json().error.code === 'UNKNOWN_PRESET', unknownPreset.status + ' ' + unknownPreset.payload)

/* ---------------- 4. 成功路径与骨架参数 ---------------- */
console.log('成功路径')
const ok = await enhance(first.handler, { preset: 'qbuddy', draft: '帮我把登录页改成深色' })
const okBody = ok.json()
check('成功返回 200 与清洗后文本', ok.status === 200 && okBody.ok === true && okBody.data.text === '增强后的提示词', ok.status + ' ' + ok.payload)
eq('返回预设 id', okBody.data.preset, 'qbuddy')
eq('缺省跟随默认 provider', okBody.data.provider, 'deepseek-account')
eq('缺省跟随默认 model', okBody.data.model, 'deepseek-flash')
eq('默认模型只解析一次', first.calls.defaultSelection, 1)
eq('一次请求只调一次模型', first.calls.stream.length, 1)

const options = first.calls.stream[0]
eq('system 取自预设原文', options.system, QBUDDY.system)
check('system 不是 user 模板', options.system !== QBUDDY.user)
const userText = options.messages?.[0]?.content?.[0]?.text ?? ''
eq(
  'user 模板逐字渲染 {{draft}}',
  userText,
  '# Draft prompt\n<draft>\n帮我把登录页改成深色\n</draft>\n\n# Output\nReturn only the rewritten prompt text.',
)
eq('temperature 固定 0.2', options.temperature, 0.2)
check('不设 maxTokens（推理模型会吃光小预算）', !('maxTokens' in options), JSON.stringify(options))
eq('消息只有一条 user', options.messages.length, 1)
eq('消息 role 是 user', options.messages[0].role, 'user')
check('带取消信号', options.signal instanceof AbortSignal)

// 省略 preset 时走配置默认（QBuddy）。
const second = mount()
const defaultPreset = await enhance(second.handler, { draft: 'hi' })
check('省略 preset 用默认档', defaultPreset.status === 200 && defaultPreset.json().data.preset === 'qbuddy', defaultPreset.status + ' ' + defaultPreset.payload)

/* ---------------- 5. 截断 ---------------- */
console.log('截断')
const longDraft = 'x'.repeat(9000)
const long = await enhance(first.handler, { draft: longDraft })
eq('超长草稿仍成功', long.status, 200)
const longOptions = first.calls.stream[first.calls.stream.length - 1]
const longUser = longOptions.messages[0].content[0].text
check('只保留 8000 字符', longUser.includes('x'.repeat(8000) + '...'), String(longUser.length))
check('第 8001 个字符被丢弃', !longUser.includes('x'.repeat(8001)), String(longUser.length))
check('截断草稿也不压输出预算', !('maxTokens' in longOptions), JSON.stringify(longOptions))

/* ---------------- 6. 预设切换与配置持久化 ---------------- */
console.log('预设切换')
const settingsMount = mount()
const initialSettings = await getSettings(settingsMount.handler)
const initialData = initialSettings.json().data
check('GET settings 200', initialSettings.status === 200 && initialSettings.json().ok === true, initialSettings.payload)
eq('默认当前档', initialData.current, 'qbuddy')
eq('没建自定义时只有四档内置', initialData.presets.length, 4)
eq(
  'settings 档位顺序与注册表一致',
  initialData.presets.map((preset) => preset.id).join(','),
  'qoder,workbuddy-polish,qbuddy,workbuddy-expand',
)
check(
  '每档带中英文标签',
  initialData.presets.every((preset) => preset.label && preset.label.zh && preset.label.en),
  JSON.stringify(initialData.presets),
)
check(
  '每档带中英文简介',
  initialData.presets.every((preset) => preset.description && preset.description.zh && preset.description.en),
  JSON.stringify(initialData.presets.map((preset) => preset.description)),
)
eq('简介与注册表逐字一致', initialData.presets[2].description.zh, QBUDDY.description.zh)
check('内置项不带 custom 标记', initialData.presets.every((preset) => preset.custom === undefined))
eq('返回 Loader 条目 id', initialData.entryId, 'dsh-qbuddy-prompt-enhance')
eq('有 configEditor 时可以写', initialData.canWrite, true)
eq('初始 provider 为空', initialData.config.provider, '')
eq('初始 model 为空', initialData.config.model, '')
eq('初始超时 30 秒', initialData.config.timeoutMs, 30_000)
eq('初始没有已存自定义预设', initialData.customPresets.length, 0)
check(
  '返回新建用的起步模板',
  initialData.customDefaults.system.length > 0 && initialData.customDefaults.user.includes('{{draft}}'),
  JSON.stringify(initialData.customDefaults).slice(0, 160),
)
eq('起步模板带默认名称', initialData.customDefaults.name.zh, '自定义')

const switched = await saveSettings(settingsMount.handler, { preset: 'qoder' })
check('PUT settings 200', switched.status === 200 && switched.json().data.current === 'qoder', switched.payload)
eq('写了一次配置', settingsMount.calls.edits.length, 1)
eq('按 Loader 条目 id 找条目', settingsMount.calls.edits[0].entry.options.id, 'dsh-qbuddy-prompt-enhance')
eq('落盘 patch 只带 preset', JSON.stringify(settingsMount.calls.edits[0].patch), JSON.stringify({ preset: 'qoder' }))

const qoderCall = await enhance(settingsMount.handler, { draft: 'hi' })
eq('切档后不传 preset 也用新档', qoderCall.json().data.preset, 'qoder')
eq('切档后 system 是新档', settingsMount.calls.stream.at(-1).system, byId('qoder').system)
const afterSwitchSettings = await getSettings(settingsMount.handler)
eq('GET 立即反映新档', afterSwitchSettings.json().data.current, 'qoder')

/* ---------------- 6.5 volatile 配置 ---------------- */
console.log('volatile 配置')
check('导出 Config schema', typeof Config === 'function' && Boolean(Config.dict))
eq('是 schemastery schema（Loader 判据）', Config?.['~standard']?.vendor, 'schemastery')
check('preset 是 volatile', Config?.dict?.preset?.meta?.volatile === true)
eq('preset 默认档', Config?.dict?.preset?.meta?.default, 'qbuddy')
check(
  'provider / model / timeoutMs 是 volatile',
  ['provider', 'model', 'timeoutMs'].every((key) => Config?.dict?.[key]?.meta?.volatile === true),
  JSON.stringify(['provider', 'model', 'timeoutMs'].map((key) => [key, Config?.dict?.[key]?.meta?.volatile])),
)
check('customPresets 是 volatile', Config?.dict?.customPresets?.meta?.volatile === true)
check('enabled 仍是普通字段', Config?.dict?.enabled?.meta?.volatile !== true)
check(
  '旧单档字段仍是 volatile',
  CUSTOM_FIELDS.every((key) => Config?.dict?.[key]?.meta?.volatile === true),
  JSON.stringify(CUSTOM_FIELDS.map((key) => [key, Config?.dict?.[key]?.meta?.volatile])),
)
eq('timeoutMs 默认 30000', Config?.dict?.timeoutMs?.meta?.default, 30_000)
eq('customPresets 默认空数组', JSON.stringify(Config?.dict?.customPresets?.meta?.default), '[]')
eq('customName 默认空', Config?.dict?.customName?.meta?.default, '')
eq('customSystem 默认空', Config?.dict?.customSystem?.meta?.default, '')
eq('customUser 默认空', Config?.dict?.customUser?.meta?.default, '')

// 改模型 / 超时：写入时同样不能换掉 volatile 引用。
const configRefMount = mount({ provider: 'old-p', model: 'old-m', timeoutMs: 9000 })
const providerRef = configRefMount.config.provider
const modelRef = configRefMount.config.model
const timeoutRef = configRefMount.config.timeoutMs
await saveSettings(configRefMount.handler, { config: { provider: 'new-p', model: 'new-m', timeoutMs: 4000 } })
check(
  '改配置不替换 volatile 引用',
  configRefMount.config.provider === providerRef &&
    configRefMount.config.model === modelRef &&
    configRefMount.config.timeoutMs === timeoutRef,
)
eq('provider 引用已就地更新', providerRef.get(), 'new-p')
eq('model 引用已就地更新', modelRef.get(), 'new-m')
eq('timeoutMs 引用已就地更新', timeoutRef.get(), 4000)
eq('后续增强用新 provider', (await enhance(configRefMount.handler, { draft: 'hi' })).json().data.provider, 'new-p')
eq('后续增强用新 model', configRefMount.calls.stream.at(-1).model, 'new-m')

// 存自定义预设：列表引用就地更新，后续增强读到新模板。
const customRefMount = mount()
const presetsRef = customRefMount.config.customPresets
await saveSettings(customRefMount.handler, {
  presets: [{ id: 'custom-a', name: 'A', system: 'S', user: 'U {{draft}}' }],
})
check('存自定义不替换 volatile 引用', customRefMount.config.customPresets === presetsRef)
eq('预设引用已就地更新', presetsRef.get()[0].id, 'custom-a')
await saveSettings(customRefMount.handler, {
  presets: [{ id: 'custom-a', name: 'B', system: 'S2', user: 'U2 {{draft}}' }],
})
const customRefEnhance = await enhance(customRefMount.handler, { preset: 'custom-a', draft: 'hi' })
eq('后续增强读到新模板', customRefMount.calls.stream.at(-1).system, 'S2')
eq('后续增强渲染新 user 模板', customRefMount.calls.stream.at(-1).messages[0].content[0].text, 'U2 hi')
eq('自定义增强返回 preset=custom-a', customRefEnhance.json().data.preset, 'custom-a')

const refMount = mount({ preset: volatileRef(DEFAULT_PRESET_ID) })
const presetRef = refMount.config.preset
await saveSettings(refMount.handler, { preset: 'qoder' })
check('切档不替换 volatile 引用', refMount.config.preset === presetRef)
eq('引用已就地更新', presetRef.get(), 'qoder')
eq('切档后 GET 走引用', (await getSettings(refMount.handler)).json().data.current, 'qoder')
eq('切档后 enhance 走引用', (await enhance(refMount.handler, { draft: 'hi' })).json().data.preset, 'qoder')
eq('切档后 system 是新档', refMount.calls.stream.at(-1).system, byId('qoder').system)

const backMount = mount()
await saveSettings(backMount.handler, { preset: 'qbuddy' })
eq('切回默认档不落 preset 键', JSON.stringify(backMount.calls.edits[0].patch), '{}')
eq('切回默认后当前档', (await getSettings(backMount.handler)).json().data.current, 'qbuddy')

const keepMount = mount({ provider: 'p', model: 'm', timeoutMs: 5000 })
await saveSettings(keepMount.handler, { preset: 'workbuddy-expand' })
eq('切档保留 provider', keepMount.calls.edits[0].patch.provider, 'p')
eq('切档保留 model', keepMount.calls.edits[0].patch.model, 'm')
eq('切档保留 timeoutMs', keepMount.calls.edits[0].patch.timeoutMs, 5000)
eq('切档写入新 preset', keepMount.calls.edits[0].patch.preset, 'workbuddy-expand')

const badPreset = await saveSettings(settingsMount.handler, { preset: 'nope' })
check('未知档 400 UNKNOWN_PRESET', badPreset.status === 400 && badPreset.json().error.code === 'UNKNOWN_PRESET', badPreset.payload)
eq('未知档不写配置', settingsMount.calls.edits.length, 1)
const missingPreset = await saveSettings(settingsMount.handler, {})
check('缺 preset 400 UNKNOWN_PRESET', missingPreset.status === 400 && missingPreset.json().error.code === 'UNKNOWN_PRESET', missingPreset.payload)
const badBody = await saveSettings(settingsMount.handler, '{not json')
check('切档非法 JSON 400 BAD_REQUEST', badBody.status === 400 && badBody.json().error.code === 'BAD_REQUEST', badBody.payload)
const crossSitePut = await saveSettings(
  settingsMount.handler,
  { preset: 'qoder' },
  { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
)
check('PUT 拒绝非同源 403', crossSitePut.status === 403 && crossSitePut.json().error.code === 'FORBIDDEN', crossSitePut.payload)
const lanGet = await getSettings(settingsMount.handler, { host: '192.168.1.5:43120' })
check('GET 拒绝非 loopback 403', lanGet.status === 403 && lanGet.json().error.code === 'FORBIDDEN', lanGet.payload)

const noEditor = mount({}, { services: { configEditor: undefined } })
eq('无 configEditor 时 canWrite=false', (await getSettings(noEditor.handler)).json().data.canWrite, false)
const noEditorSave = await saveSettings(noEditor.handler, { preset: 'qoder' })
check('无 configEditor 503 NO_EDITOR', noEditorSave.status === 503 && noEditorSave.json().error.code === 'NO_EDITOR', noEditorSave.payload)
eq('写失败不改内存档', (await enhance(noEditor.handler, { draft: 'hi' })).json().data.preset, 'qbuddy')

const missingEntry = mount({}, { services: { configEditor: { entries: () => [], async edit() {} } } })
const missingEntrySave = await saveSettings(missingEntry.handler, { preset: 'qoder' })
check('找不到条目 503 NO_ENTRY', missingEntrySave.status === 503 && missingEntrySave.json().error.code === 'NO_ENTRY', missingEntrySave.payload)

const failingEditor = mount(
  {},
  {
    services: {
      configEditor: {
        entries: () => [{ options: { id: 'dsh-qbuddy-prompt-enhance' } }],
        async edit() {
          throw new Error('磁盘只读')
        },
      },
    },
  },
)
const failingSave = await saveSettings(failingEditor.handler, { preset: 'qoder' })
check('写盘失败 409 WRITE_FAILED', failingSave.status === 409 && failingSave.json().error.code === 'WRITE_FAILED', failingSave.payload)
eq('写盘失败不改内存档', (await enhance(failingEditor.handler, { draft: 'hi' })).json().data.preset, 'qbuddy')

// 切换只影响下一次调用：在途请求的预设与 system 必须保持旧档。
let releaseStream = null
let startedResolve = null
const started = new Promise((resolve) => {
  startedResolve = resolve
})
const gate = new Promise((resolve) => {
  releaseStream = resolve
})
const inflightSystems = []
const inFlight = mount(
  {},
  {
    services: {
      llm: {
        stream(options) {
          inflightSystems.push(options.system)
          startedResolve()
          return (async function* slow() {
            await gate
            yield { type: 'text-delta', index: 0, text: '旧档结果' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    },
  },
)
const pendingEnhance = enhance(inFlight.handler, { draft: 'hi' })
await started
const switchDuring = await saveSettings(inFlight.handler, { preset: 'workbuddy-expand' })
eq('在途时切档成功', switchDuring.json().data.current, 'workbuddy-expand')
releaseStream()
const inflightBody = await pendingEnhance
eq('在途调用仍用旧档', inflightBody.json().data.preset, 'qbuddy')
eq('在途调用的 system 是旧档', inflightSystems[0], QBUDDY.system)
const afterInflight = await enhance(inFlight.handler, { draft: 'hi' })
eq('后续调用用新档', afterInflight.json().data.preset, 'workbuddy-expand')
eq('后续 system 是新档', inflightSystems.at(-1), byId('workbuddy-expand').system)

/* ---------------- 6.6 自定义预设（任意多个） ---------------- */
console.log('自定义预设')
const customMount = mount()
const customInitial = (await getSettings(customMount.handler)).json().data
eq('初始菜单只有内置四档', customInitial.presets.length, 4)
eq('初始没有已存自定义预设', customInitial.customPresets.length, 0)

const created = await saveSettings(customMount.handler, {
  presets: [{ id: 'custom-1', name: '  我的风格  ', system: 'SYS {{draft}}', user: '改写：{{draft}}' }],
})
check('保存自定义预设 200', created.status === 200, created.status + ' ' + created.payload)
const createdData = created.json().data
eq('保存后菜单多出一项', createdData.presets.length, 5)
eq('自定义项 id', createdData.presets.at(-1).id, 'custom-1')
eq('自定义项带 custom 标记', createdData.presets.at(-1).custom, true)
eq('自定义项显示名去掉首尾空白', createdData.presets.at(-1).label.zh, '我的风格')
eq('只存预设不改当前档', createdData.current, 'qbuddy')
eq(
  '落盘 customPresets 一项',
  JSON.stringify(customMount.calls.edits[0].patch.customPresets),
  JSON.stringify([{ id: 'custom-1', name: '我的风格', system: 'SYS {{draft}}', user: '改写：{{draft}}' }]),
)
check(
  '落盘不再带旧单档字段',
  CUSTOM_FIELDS.every((field) => !(field in customMount.calls.edits[0].patch)),
  JSON.stringify(customMount.calls.edits[0].patch),
)

const switchedCustom = await saveSettings(customMount.handler, { preset: 'custom-1' })
check(
  '切到自定义档 200',
  switchedCustom.status === 200 && switchedCustom.json().data.current === 'custom-1',
  switchedCustom.status + ' ' + switchedCustom.payload,
)
eq('切档落盘 preset', customMount.calls.edits.at(-1).patch.preset, 'custom-1')
const customEnhance = await enhance(customMount.handler, { preset: 'custom-1', draft: 'hi' })
eq('自定义档增强成功', customEnhance.status, 200)
eq('自定义 system 生效', customMount.calls.stream.at(-1).system, 'SYS {{draft}}')
eq('自定义 user 模板渲染草稿', customMount.calls.stream.at(-1).messages[0].content[0].text, '改写：hi')
eq('自定义增强返回 id', customEnhance.json().data.preset, 'custom-1')

// 多个自定义预设：想建几个建几个，顺序按提交顺序。
const multi = await saveSettings(customMount.handler, {
  presets: [
    { id: 'custom-1', name: '一', system: 'S1', user: 'U1 {{draft}}' },
    { id: 'custom-2', name: '二', system: 'S2', user: 'U2 {{draft}}' },
  ],
})
eq('可以存多个自定义预设', multi.json().data.presets.length, 6)
eq(
  '自定义预设按提交顺序排列',
  multi.json().data.presets.slice(4).map((preset) => preset.id).join(','),
  'custom-1,custom-2',
)
eq('多预设时当前档保持', multi.json().data.current, 'custom-1')

// 删掉当前档：回默认档，不留悬空引用。
const deleted = await saveSettings(customMount.handler, {
  presets: [{ id: 'custom-2', name: '二', system: 'S2', user: 'U2 {{draft}}' }],
})
eq('删除当前自定义档后回默认档', deleted.json().data.current, 'qbuddy')
eq(
  '删除后菜单只剩内置 + 另一项',
  deleted.json().data.presets.map((preset) => preset.id).join(','),
  'qoder,workbuddy-polish,qbuddy,workbuddy-expand,custom-2',
)
const deletedEnhance = await enhance(customMount.handler, { preset: 'custom-1', draft: 'hi' })
check(
  '已删除的预设 id 400 UNKNOWN_PRESET',
  deletedEnhance.status === 400 && deletedEnhance.json().error.code === 'UNKNOWN_PRESET',
  deletedEnhance.status + ' ' + deletedEnhance.payload,
)
const emptyList = await saveSettings(customMount.handler, { presets: [] })
eq('可以删光自定义预设', emptyList.json().data.presets.length, 4)
eq('删光后 current 仍是默认档', emptyList.json().data.current, 'qbuddy')

// 校验：形状 / id 约定 / 去重 / 必填 / 占位符 / 长度。
console.log('自定义预设校验')
const badMount = mount()
const badPresets = [
  ['presets 不是数组', 'nope'],
  ['条目不是对象', [null]],
  ['id 不符合约定', [{ id: 'my-style', name: 'x', system: 'S', user: '{{draft}}' }]],
  [
    'id 重复',
    [
      { id: 'custom-1', name: 'a', system: 'S', user: '{{draft}}' },
      { id: 'custom-1', name: 'b', system: 'S', user: '{{draft}}' },
    ],
  ],
  ['名称为空', [{ id: 'custom-1', name: '   ', system: 'S', user: '{{draft}}' }]],
  ['名称超长', [{ id: 'custom-1', name: 'x'.repeat(41), system: 'S', user: '{{draft}}' }]],
  ['system 为空', [{ id: 'custom-1', name: 'a', system: '  ', user: '{{draft}}' }]],
  ['user 缺占位符', [{ id: 'custom-1', name: 'a', system: 'S', user: '没有占位符' }]],
  ['模板超长', [{ id: 'custom-1', name: 'a', system: 'S', user: '{{draft}}' + 'y'.repeat(8000) }]],
]
for (const [label, presets] of badPresets) {
  const res = await saveSettings(badMount.handler, { presets })
  check(
    label + ' 400 BAD_PRESETS',
    res.status === 400 && res.json().error.code === 'BAD_PRESETS',
    res.status + ' ' + res.payload,
  )
}
eq('校验失败不写配置', badMount.calls.edits.length, 0)

/* ---------------- 6.7 旧单档字段迁移 ---------------- */
console.log('旧单档字段迁移')
const legacy = mount({ customName: '旧档', customSystem: 'OLD-SYS', customUser: '旧：{{draft}}' })
const legacyData = (await getSettings(legacy.handler)).json().data
eq('旧字段迁移成一个预设', legacyData.presets.length, 5)
eq('迁移预设 id 固定 custom', legacyData.presets.at(-1).id, 'custom')
eq('迁移预设带 custom 标记', legacyData.presets.at(-1).custom, true)
eq('迁移预设显示名', legacyData.presets.at(-1).label.zh, '旧档')
eq('customPresets 快照也含迁移项', legacyData.customPresets[0].id, 'custom')
const legacyEnhance = await enhance(legacy.handler, { preset: 'custom', draft: 'x' })
eq('迁移预设可直接增强', legacyEnhance.status, 200)
eq('迁移 system 生效', legacy.calls.stream.at(-1).system, 'OLD-SYS')
const legacySaved = await saveSettings(legacy.handler, {
  presets: [{ id: 'custom', name: '新', system: 'NEW {{draft}}', user: '{{draft}}' }],
})
check(
  '保存后旧单档字段从 patch 里消失',
  CUSTOM_FIELDS.every((field) => !(field in legacy.calls.edits.at(-1).patch)),
  JSON.stringify(legacy.calls.edits.at(-1).patch),
)
eq('保存后用列表里的新模板', legacySaved.json().data.customPresets[0].system, 'NEW {{draft}}')

const brokenLegacy = mount({ customName: '坏', customSystem: 'S', customUser: '无占位符' })
const brokenEnhance = await enhance(brokenLegacy.handler, { preset: 'custom', draft: 'hi' })
check(
  '旧字段里的坏模板 409 CUSTOM_EMPTY',
  brokenEnhance.status === 409 && brokenEnhance.json().error.code === 'CUSTOM_EMPTY',
  brokenEnhance.status + ' ' + brokenEnhance.payload,
)
eq('未配置时不发模型请求', brokenLegacy.calls.stream.length, 0)
const brokenSwitch = await saveSettings(brokenLegacy.handler, { preset: 'custom' })
check(
  '不能切到未配置的旧档',
  brokenSwitch.status === 409 && brokenSwitch.json().error.code === 'CUSTOM_EMPTY',
  brokenSwitch.status + ' ' + brokenSwitch.payload,
)
eq('未配置切档不写配置', brokenLegacy.calls.edits.length, 0)

// 手改 YAML 写坏的列表：运行时只保留可用条目。
const dirty = mount({
  customPresets: [
    { id: 'bad id', name: 'x', system: 'S', user: '{{draft}}' },
    { id: 'custom-ok', name: '', system: 'S', user: '{{draft}}' },
    null,
  ],
})
const dirtyData = (await getSettings(dirty.handler)).json().data
eq('坏条目被丢弃', dirtyData.customPresets.length, 1)
eq('空名称回落默认显示名', dirtyData.presets.at(-1).label.zh, '自定义')

/* ---------------- 6.8 详情页配置：provider / model / 超时 ---------------- */
console.log('详情页配置')
const pageMount = mount()
const pageSaved = await saveSettings(pageMount.handler, {
  config: { provider: '  vendor-a  ', model: 'model-b', timeoutMs: 5000 },
})
check(
  'PUT config 200',
  pageSaved.status === 200 && pageSaved.json().data.saved === true,
  pageSaved.status + ' ' + pageSaved.payload,
)
eq('返回新 provider（去首尾空白）', pageSaved.json().data.config.provider, 'vendor-a')
eq('返回新 model', pageSaved.json().data.config.model, 'model-b')
eq('返回新超时', pageSaved.json().data.config.timeoutMs, 5000)
eq(
  '落盘只带这三项',
  JSON.stringify(pageMount.calls.edits[0].patch),
  JSON.stringify({ provider: 'vendor-a', model: 'model-b', timeoutMs: 5000 }),
)
const pageEnhance = await enhance(pageMount.handler, { draft: 'hi' })
eq('增强用新 provider', pageEnhance.json().data.provider, 'vendor-a')
eq('增强用新 model', pageEnhance.json().data.model, 'model-b')
eq('配置齐全时不查默认模型', pageMount.calls.defaultSelection, 0)
eq('超时透传到计时器', pageMount.calls.stream.length, 1)

const pageDefault = await saveSettings(pageMount.handler, {
  config: { provider: '', model: '', timeoutMs: 30_000 },
})
check('改回默认值 200', pageDefault.status === 200, pageDefault.payload)
eq('改回默认值等于删掉键', JSON.stringify(pageMount.calls.edits.at(-1).patch), '{}')
eq(
  '改回默认后跟随默认模型',
  (await enhance(pageMount.handler, { draft: 'hi' })).json().data.provider,
  'deepseek-account',
)

const pageBad = [
  ['超时过小', { timeoutMs: 50 }],
  ['超时过大', { timeoutMs: 700_000 }],
  ['超时不是数字', { timeoutMs: 'soon' }],
  ['provider 超长', { provider: 'x'.repeat(201) }],
  ['model 不是字符串', { model: 42 }],
  ['config 不是对象', ['nope']],
]
for (const [label, config] of pageBad) {
  const res = await saveSettings(pageMount.handler, { config })
  check(
    label + ' 400 BAD_CONFIG',
    res.status === 400 && res.json().error.code === 'BAD_CONFIG',
    res.status + ' ' + res.payload,
  )
}
eq('配置校验失败不写盘', pageMount.calls.edits.length, 2)

// 同一次 PUT 里改配置 + 切档：两边都生效。
const comboMount = mount()
const combo = await saveSettings(comboMount.handler, {
  preset: 'qoder',
  config: { provider: 'combo-p', model: 'combo-m' },
})
check('配置 + 切档一次写成功', combo.status === 200 && combo.json().data.current === 'qoder', combo.payload)
eq('落盘同时带 preset 与 provider', comboMount.calls.edits[0].patch.preset, 'qoder')
eq('落盘同时带 model', comboMount.calls.edits[0].patch.model, 'combo-m')

/* ---------------- 6.9 思考强度（model-info + 随请求下发） ---------------- */
console.log('思考强度')

// 适配器报了两档 + 默认档：model-info 原样透出。
const effortMount = mount({}, {
  services: {
    llm: {
      stream(options) {
        effortMount.calls.stream.push(options)
        return textStream([
          { type: 'text-delta', index: 0, text: 'ok' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])()
      },
      async resolveModelInfo(provider, model) {
        effortMount.calls.modelInfo.push({ provider, model })
        return {
          id: model,
          provider,
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: '', name: '坏档' },
              { id: 'high' },
              null,
            ],
            defaultEffort: 'low',
          },
        }
      },
    },
  },
})
const infoOk = await modelInfo(effortMount.handler, '?provider=vendor-a&model=model-b')
check('model-info 200', infoOk.status === 200 && infoOk.json().ok === true, infoOk.status + ' ' + infoOk.payload)
eq('model-info 透传 provider', infoOk.json().data.provider, 'vendor-a')
eq('model-info 透传 model', infoOk.json().data.model, 'model-b')
eq('model-info 过滤空 id', infoOk.json().data.reasoning.efforts.length, 2)
eq('model-info 缺 name 用 id', infoOk.json().data.reasoning.efforts[1].name, 'high')
eq('model-info 带默认档', infoOk.json().data.reasoning.defaultEffort, 'low')
eq('model-info 把 provider/model 交给适配器', JSON.stringify(effortMount.calls.modelInfo[0]), '{"provider":"vendor-a","model":"model-b"}')

const infoNoReasoning = mount({}, {
  services: { llm: { async resolveModelInfo() { return { id: 'x', provider: 'p' } } } },
})
const infoNone = await modelInfo(infoNoReasoning.handler, '?provider=p&model=x')
check('没有 reasoning 时 200', infoNone.status === 200, infoNone.payload)
check('没有 reasoning 时 reasoning 为 null', infoNone.json().data.reasoning === null, infoNone.payload)

const infoNoService = mount()
const infoMissing = await modelInfo(infoNoService.handler, '?provider=p&model=x')
check('没有 resolveModelInfo 仍 200', infoMissing.status === 200, infoMissing.payload)
check('没有 resolveModelInfo 时 reasoning 为 null', infoMissing.json().data.reasoning === null, infoMissing.payload)
check('没有 resolveModelInfo 时给 note', typeof infoMissing.json().data.note === 'string', infoMissing.payload)

const infoThrows = mount({}, {
  services: { llm: { async resolveModelInfo() { throw new Error('适配器炸了') } } },
})
const infoError = await modelInfo(infoThrows.handler, '?provider=p&model=x')
check('适配器抛错仍 200', infoError.status === 200, infoError.payload)
check('适配器抛错时 reasoning 为 null', infoError.json().data.reasoning === null, infoError.payload)
check('适配器抛错时 note 带原因', String(infoError.json().data.note).includes('适配器炸了'), infoError.payload)

const infoMissingParams = await modelInfo(effortMount.handler, '?provider=p')
check('缺 model 时 400 NO_TARGET', infoMissingParams.status === 400 && infoMissingParams.json().error.code === 'NO_TARGET', infoMissingParams.payload)
const infoBadParams = await modelInfo(effortMount.handler, '?provider=p%0Ax&model=m')
check('provider 带换行 400 BAD_TARGET', infoBadParams.status === 400 && infoBadParams.json().error.code === 'BAD_TARGET', infoBadParams.payload)

// 选了强度：prepareCall 收到 reasoningEffort，prepared 配置继续带着它。
const effortPrepared = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall(request) {
        effortPrepared.calls.prepare.push(request)
        return {
          config: { ...request },
          stream(options) {
            effortPrepared.calls.stream.push(options)
            return textStream([
              { type: 'text-delta', index: 0, text: 'high ok' },
              { type: 'finish', reason: { kind: 'stop' } },
            ])()
          },
        }
      },
    },
  },
})
await saveSettings(effortPrepared.handler, {
  config: { provider: 'vendor-a', model: 'model-b', reasoningEffort: 'high' },
})
await enhance(effortPrepared.handler, { draft: 'hi' })
eq('强度随 prepareCall 下发', effortPrepared.calls.prepare[0].reasoningEffort, 'high')
eq('prepared 配置保留强度', effortPrepared.calls.stream[0].reasoningEffort, 'high')

// 空强度：请求里干脆不出现这个字段，交给适配器默认档。
const effortEmpty = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall(request) {
        effortEmpty.calls.prepare.push(request)
        return { config: { ...request }, stream: () => textStream([
          { type: 'text-delta', index: 0, text: 'default ok' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])() }
      },
    },
  },
})
await enhance(effortEmpty.handler, { draft: 'hi' })
check('空强度不下发字段', !('reasoningEffort' in effortEmpty.calls.prepare[0]), JSON.stringify(effortEmpty.calls.prepare[0]))

// 配的强度被模型撤了：丢掉强度重试一次，别让可选旋钮打死整条链。
const effortFallback = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall(request) {
        effortFallback.calls.prepare.push(request)
        if ('reasoningEffort' in request) throw new Error('unknown reasoning effort')
        return { config: { ...request }, stream: () => textStream([
          { type: 'text-delta', index: 0, text: 'fallback ok' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])() }
      },
    },
  },
})
await saveSettings(effortFallback.handler, {
  config: { provider: 'vendor-a', model: 'model-b', reasoningEffort: 'gone' },
})
const fallbackBody = await enhance(effortFallback.handler, { draft: 'hi' })
eq('强度不可用时重试一次', effortFallback.calls.prepare.length, 2)
check('重试时不再带强度', !('reasoningEffort' in effortFallback.calls.prepare[1]), JSON.stringify(effortFallback.calls.prepare[1]))
eq('强度不可用仍返回结果', fallbackBody.json().data.text, 'fallback ok')

// 两次都失败才报错。
const effortDead = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall() {
        throw new Error('模型没上线')
      },
    },
  },
})
await saveSettings(effortDead.handler, {
  config: { provider: 'vendor-a', model: 'model-b', reasoningEffort: 'gone' },
})
const deadBody = await enhance(effortDead.handler, { draft: 'hi' })
check('重试也失败时 503 MODEL_UNAVAILABLE', deadBody.status === 503 && deadBody.json().error.code === 'MODEL_UNAVAILABLE', deadBody.payload)

// 强度也进 config 校验与 GET 回显。
const effortBadType = await saveSettings(effortMount.handler, { config: { reasoningEffort: 42 } })
check('强度不是字符串 400 BAD_CONFIG', effortBadType.status === 400 && effortBadType.json().error.code === 'BAD_CONFIG', effortBadType.payload)
const effortSaved = await saveSettings(effortMount.handler, { config: { reasoningEffort: '  high  ' } })
eq('强度去首尾空白', effortSaved.json().data.config.reasoningEffort, 'high')
eq('强度落盘', effortMount.calls.edits.at(-1).patch.reasoningEffort, 'high')
eq('GET 回显强度', (await getSettings(effortMount.handler)).json().data.config.reasoningEffort, 'high')
const effortReset = await saveSettings(effortMount.handler, { config: { reasoningEffort: '' } })
eq('强度改回空串等于删键', JSON.stringify(effortMount.calls.edits.at(-1).patch), '{}')

/* ---------------- 7. 输出清洗 ---------------- */
console.log('输出清洗')
const fenced = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([
          { type: 'text-delta', index: 0, text: '```text\nFix the bug in auth.ts\n```' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])()
      },
    },
  },
})
const fencedResult = await enhance(fenced.handler, { draft: '修一下' })
eq('围栏在宿主侧剥掉', fencedResult.json().data.text, 'Fix the bug in auth.ts')

const quoted = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([
          { type: 'text-delta', index: 0, text: '""请解释这段代码""' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])()
      },
    },
  },
})
const quotedResult = await enhance(quoted.handler, { draft: '解释' })
eq('双层引号在宿主侧剥净', quotedResult.json().data.text, '请解释这段代码')

// 路由返回的仍是清洗函数的输出：再清洗一次应保持不变（幂等）。
eq('清洗幂等', cleanOutput(fencedResult.json().data.text), 'Fix the bug in auth.ts')

/* ---------------- 8. 失败与缺服务 ---------------- */
console.log('失败与缺服务')
const emptyResult = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([{ type: 'finish', reason: { kind: 'stop' } }])()
      },
    },
  },
})
const emptyBody = await enhance(emptyResult.handler, { draft: 'hi' })
check('空结果 502 EMPTY_RESULT', emptyBody.status === 502 && emptyBody.json().error.code === 'EMPTY_RESULT', emptyBody.status + ' ' + emptyBody.payload)

// 推理模型把输出预算烧光时 content 为空、finish=max-tokens：单独报截断。
const truncatedEmpty = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([
          {
            type: 'finish',
            reason: { kind: 'max-tokens' },
            usage: { completion_tokens: 2048, reasoning_tokens: 2048 },
          },
        ])()
      },
    },
  },
})
const truncatedEmptyBody = await enhance(truncatedEmpty.handler, { draft: 'hi' })
check(
  '空文本 + max-tokens 502 OUTPUT_TRUNCATED',
  truncatedEmptyBody.status === 502 && truncatedEmptyBody.json().error.code === 'OUTPUT_TRUNCATED',
  truncatedEmptyBody.status + ' ' + truncatedEmptyBody.payload,
)

// 已经有文本时截断照常当成功，不把半截结果也判失败。
const truncatedPartial = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([
          { type: 'text-delta', index: 0, text: '半截结果' },
          { type: 'finish', reason: { kind: 'max-tokens' } },
        ])()
      },
    },
  },
})
const truncatedPartialBody = await enhance(truncatedPartial.handler, { draft: 'hi' })
check(
  '截断但有文本仍返回',
  truncatedPartialBody.status === 200 && truncatedPartialBody.json().data.text === '半截结果',
  truncatedPartialBody.status + ' ' + truncatedPartialBody.payload,
)

const quotedOnly = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([
          { type: 'text-delta', index: 0, text: '""' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])()
      },
    },
  },
})
const quotedOnlyBody = await enhance(quotedOnly.handler, { draft: 'hi' })
check('清洗后只剩空串也算失败', quotedOnlyBody.status === 502 && quotedOnlyBody.json().error.code === 'EMPTY_RESULT', quotedOnlyBody.status + ' ' + quotedOnlyBody.payload)

const llmError = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: '太频繁了' } } }])()
      },
    },
  },
})
const llmErrorBody = await enhance(llmError.handler, { draft: 'hi' })
check(
  '模型报错映射成 502 并保留错误码',
  llmErrorBody.status === 502 && llmErrorBody.json().error.code === 'RATE_LIMITED' && llmErrorBody.json().error.message === '太频繁了',
  llmErrorBody.status + ' ' + llmErrorBody.payload,
)

const toolCall = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([{ type: 'finish', reason: { kind: 'tool-calls' } }])()
      },
    },
  },
})
const toolCallBody = await enhance(toolCall.handler, { draft: 'hi' })
check('工具调用当失败', toolCallBody.status === 502 && toolCallBody.json().error.code === 'TOOL_CALLS', toolCallBody.status + ' ' + toolCallBody.payload)

const noFinish = mount({}, {
  services: {
    llm: {
      stream() {
        return textStream([{ type: 'text-delta', index: 0, text: 'half' }])()
      },
    },
  },
})
const noFinishBody = await enhance(noFinish.handler, { draft: 'hi' })
check('缺少结束分片 502 NO_FINISH', noFinishBody.status === 502 && noFinishBody.json().error.code === 'NO_FINISH', noFinishBody.status + ' ' + noFinishBody.payload)

const thrown = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('连接被重置')
      },
    },
  },
})
const thrownBody = await enhance(thrown.handler, { draft: 'hi' })
check('stream 抛错 502 LLM_ERROR', thrownBody.status === 502 && thrownBody.json().error.code === 'LLM_ERROR', thrownBody.status + ' ' + thrownBody.payload)

const noLlm = mount({}, { services: { llm: undefined } })
const noLlmBody = await enhance(noLlm.handler, { draft: 'hi' })
check('没有 llm 服务 503 NO_LLM', noLlmBody.status === 503 && noLlmBody.json().error.code === 'NO_LLM', noLlmBody.status + ' ' + noLlmBody.payload)

const noDefault = mount({}, { services: { agentDefaultModel: undefined } })
const noDefaultBody = await enhance(noDefault.handler, { draft: 'hi' })
check('无默认模型且未配置 503 NO_TARGET', noDefaultBody.status === 503 && noDefaultBody.json().error.code === 'NO_TARGET', noDefaultBody.status + ' ' + noDefaultBody.payload)

const disabled = mount({ enabled: false })
const disabledBody = await enhance(disabled.handler, { draft: 'hi' })
check('关闭时 409 DISABLED', disabledBody.status === 409 && disabledBody.json().error.code === 'DISABLED', disabledBody.status + ' ' + disabledBody.payload)

/* ---------------- 9. 超时 ---------------- */
console.log('超时')
const timeout = mount({ timeoutMs: 100 }, {
  services: {
    llm: {
      stream(options) {
        return (async function* stalled() {
          await new Promise((resolve) => {
            if (options.signal.aborted) return resolve()
            options.signal.addEventListener('abort', resolve, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted' } }
        })()
      },
    },
  },
})
const startedAt = Date.now()
const timeoutBody = await enhance(timeout.handler, { draft: 'hi' })
const elapsed = Date.now() - startedAt
check('超时 504 TIMEOUT', timeoutBody.status === 504 && timeoutBody.json().error.code === 'TIMEOUT', timeoutBody.status + ' ' + timeoutBody.payload)
check('按配置时长中断', elapsed >= 90 && elapsed < 5000, String(elapsed))

/* ---------------- 10. 配置优先 ---------------- */
console.log('配置优先')
const custom = mount({ provider: 'my-provider', model: 'my-model', timeoutMs: 5000 })
const customBody = await enhance(custom.handler, { draft: '写迁移脚本' })
eq('配置 provider 优先', customBody.json().data.provider, 'my-provider')
eq('配置 model 优先', customBody.json().data.model, 'my-model')
eq('显式配置时不查默认模型', custom.calls.defaultSelection, 0)
eq('配置 provider 透传给模型', custom.calls.stream[0].provider, 'my-provider')
eq('配置 model 透传给模型', custom.calls.stream[0].model, 'my-model')

/* ---------------- 11. prepareCall 路径 ---------------- */
console.log('prepareCall')
const prepared = mount({}, {
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall(request) {
        prepared.calls.prepare.push(request)
        return {
          config: { ...request, maxTokens: 999 },
          stream(options) {
            prepared.calls.stream.push(options)
            return textStream([
              { type: 'text-delta', index: 0, text: 'prepared ok' },
              { type: 'finish', reason: { kind: 'stop' } },
            ])()
          },
        }
      },
    },
  },
})
const preparedBody = await enhance(prepared.handler, { draft: 'hello' })
eq('prepareCall 请求带 temperature', prepared.calls.prepare[0].temperature, 0.2)
check('prepareCall 请求不带 maxTokens', !('maxTokens' in prepared.calls.prepare[0]), JSON.stringify(prepared.calls.prepare[0]))
eq('prepareCall 后走 prepared.stream', preparedBody.json().data.text, 'prepared ok')
eq('prepared 配置覆盖请求', prepared.calls.stream[0].maxTokens, 999)
eq('prepared 调用仍带 system', prepared.calls.stream[0].system, QBUDDY.system)
check('prepared 调用仍带取消信号', prepared.calls.stream[0].signal instanceof AbortSignal)

/* ---------------- 12. effectiveConfig ---------------- */
console.log('effectiveConfig')
const defaults = effectiveConfig({})
check('默认启用', defaults.enabled === true)
eq('默认预设', defaults.preset, 'qbuddy')
eq('默认超时 30 秒', defaults.timeoutMs, 30_000)
eq('默认 provider 为空', defaults.provider, '')
check('非法超时回落默认', effectiveConfig({ timeoutMs: 'abc' }).timeoutMs === 30_000)
check('过小超时回落默认', effectiveConfig({ timeoutMs: 10 }).timeoutMs === 30_000)
check('过大的超时回落默认', effectiveConfig({ timeoutMs: 10_000_000 }).timeoutMs === 30_000)
check('合法超时保留', effectiveConfig({ timeoutMs: 5000 }).timeoutMs === 5000)
check('enabled:false 生效', effectiveConfig({ enabled: false }).enabled === false)
eq('解引用 preset', effectiveConfig({ preset: volatileRef('workbuddy-expand') }).preset, 'workbuddy-expand')
eq('解引用 provider', effectiveConfig({ provider: volatileRef('p') }).provider, 'p')
eq('解引用 timeoutMs', effectiveConfig({ timeoutMs: volatileRef(5000) }).timeoutMs, 5000)
check('解引用 enabled', effectiveConfig({ enabled: volatileRef(false) }).enabled === false)
eq('默认没有思考强度', defaults.reasoningEffort, '')
eq('思考强度去首尾空白', effectiveConfig({ reasoningEffort: '  high ' }).reasoningEffort, 'high')
eq('思考强度非字符串回落空串', effectiveConfig({ reasoningEffort: 42 }).reasoningEffort, '')
eq('解引用思考强度', effectiveConfig({ reasoningEffort: volatileRef('low') }).reasoningEffort, 'low')
eq('空引用回落默认档', effectiveConfig({ preset: volatileRef(undefined) }).preset, 'qbuddy')
eq('默认没有自定义预设列表', defaults.customPresets.length, 0)
check(
  'effectiveConfig 只输出迁移后的列表',
  !('customName' in defaults) && !('customSystem' in defaults) && !('customUser' in defaults),
  JSON.stringify(Object.keys(defaults)),
)
eq(
  '旧字段名称超长按 40 截断',
  effectiveConfig({ customName: 'x'.repeat(60), customSystem: 'S', customUser: '{{draft}}' }).customPresets[0].name.length,
  40,
)
eq(
  '旧字段兜底出 id=custom 的预设',
  effectiveConfig({ customName: 'n', customSystem: 'S', customUser: 'U {{draft}}' }).customPresets[0]?.id,
  'custom',
)
eq(
  '列表优先于旧字段',
  effectiveConfig({
    customPresets: [{ id: 'custom-1', name: 'a', system: 'S', user: '{{draft}}' }],
    customName: 'legacy',
    customSystem: 'S',
    customUser: '{{draft}}',
  }).customPresets[0]?.id,
  'custom-1',
)
const dirtyPresets = effectiveConfig({
  customPresets: [
    { id: 'custom-1', name: 'a', system: 'S', user: '{{draft}}' },
    { id: 'custom-1', name: 'dup', system: 'S', user: '{{draft}}' },
    { id: 'nope', name: 'b', system: 'S', user: '{{draft}}' },
    { id: 'custom-2', name: 'c', system: 'S', user: '无占位符' },
    null,
  ],
}).customPresets
eq('脏列表只留一条', dirtyPresets.length, 1)
eq('脏列表保留第一条', dirtyPresets[0].id, 'custom-1')
eq(
  '解引用 customPresets',
  effectiveConfig({ customPresets: volatileRef([{ id: 'custom-x', name: 'x', system: 'S', user: '{{draft}}' }]) })
    .customPresets[0]?.id,
  'custom-x',
)

/* ---------------- 配置页候选：provider / model 下拉 ---------------- */
const catalogLlm = {
  stream() {
    return textStream([{ type: 'finish', reason: { kind: 'stop' } }])()
  },
  async listProviders() {
    return [{ id: 'deepseek-account', name: 'DeepSeek 账号' }, { id: 'magpie', name: '' }, null, { id: '' }]
  },
  async listModels(provider) {
    if (provider === 'boom') throw new Error('适配器炸了')
    return [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', description: '快' },
      { id: 'deepseek-pro' },
      null,
      { id: '' },
    ]
  },
}
const withCatalog = mount({}, { services: { llm: catalogLlm } })
const indexBody = await request(withCatalog.handler, { url: ROUTE_PREFIX })
check(
  '索引路由列出候选两条',
  indexBody.json().data.routes.includes('/prompt-enhance-v2/providers') &&
    indexBody.json().data.routes.includes('/prompt-enhance-v2/models'),
  indexBody.payload,
)

const providersBody = await request(withCatalog.handler, { url: '/prompt-enhance-v2/providers' })
eq('providers 200', providersBody.status, 200)
eq('providers 只留合法 id', providersBody.json().data.providers.length, 2)
eq('providers 缺 name 用 id', providersBody.json().data.providers[1].name, 'magpie')

const modelsBody = await request(withCatalog.handler, {
  url: '/prompt-enhance-v2/models?provider=deepseek-account',
})
eq('models 200', modelsBody.status, 200)
eq('models 回带 provider', modelsBody.json().data.provider, 'deepseek-account')
eq('models 只留合法 id', modelsBody.json().data.models.length, 2)
eq('models 缺 name 用 id', modelsBody.json().data.models[1].name, 'deepseek-pro')

const modelsDefault = await request(withCatalog.handler, { url: '/prompt-enhance-v2/models' })
eq('models 省略 provider 时按生效路由取', modelsDefault.json().data.provider, 'deepseek-account')

const modelsBoom = await request(withCatalog.handler, { url: '/prompt-enhance-v2/models?provider=boom' })
check(
  'models 适配器抛错仍 200 并带 note',
  modelsBoom.status === 200 &&
    modelsBoom.json().data.models.length === 0 &&
    modelsBoom.json().data.note === '适配器炸了',
  modelsBoom.payload,
)

const noProviderHost = mount({}, { services: { agentDefaultModel: { currentSelection: () => undefined } } })
const noProviderBody = await request(noProviderHost.handler, { url: '/prompt-enhance-v2/models' })
check(
  'models 无法推断 provider 400 NO_PROVIDER',
  noProviderBody.status === 400 && noProviderBody.json().error.code === 'NO_PROVIDER',
  noProviderBody.status + ' ' + noProviderBody.payload,
)

const badProviderBody = await request(withCatalog.handler, {
  url: '/prompt-enhance-v2/models?provider=' + encodeURIComponent('a\nb'),
})
check(
  'models provider 带换行 400 BAD_PROVIDER',
  badProviderBody.status === 400 && badProviderBody.json().error.code === 'BAD_PROVIDER',
  badProviderBody.status + ' ' + badProviderBody.payload,
)

const noLister = mount({}, { services: { llm: { stream: catalogLlm.stream } } })
const noListerBody = await request(noLister.handler, { url: '/prompt-enhance-v2/providers' })
check(
  '没有 listProviders 时回空列表 + note',
  noListerBody.status === 200 &&
    noListerBody.json().data.providers.length === 0 &&
    typeof noListerBody.json().data.note === 'string',
  noListerBody.payload,
)

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)