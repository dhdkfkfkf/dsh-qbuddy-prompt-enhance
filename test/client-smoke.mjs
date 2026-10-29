/**
 * Client 半冒烟：client.js 是浏览器脚本（window.__ModuleLoader__ + 注入的 require），
 * 这里用最小 React 垫片把它跑起来，驱动组件函数本身，覆盖：
 *   - 空草稿整个按钮不渲染；split button：左段增强、右段菜单；
 *   - 菜单上半部切预设（只列内置 + 已创建的自定义档）；
 *   - 菜单下半部快速切插件自己用的模型（/providers + /models 候选）；
 *   - 选中档位 -> PUT settings -> 立即写进配置；下一次增强带新档；
 *   - 并发保护：草稿没变直接写回；中途改字进入「应用」态；清空则丢弃；
 *   - 失败不覆盖草稿，title 给出本地化原因；
 *   - 标签宽度按实测值过渡（transition: width）；
 *   - 详情页配置卡片：provider/model/超时 + 任意多个自定义预设的增删改，
 *     保存后广播 qbuddy:settings-changed，输入框菜单自动刷新。
 *
 * 不装 jsdom、不渲染 DOM：只验证「点击 -> 公开 action / 请求」这条链。
 */
import { readFileSync } from 'node:fs'
import { PRESETS } from '../presets.js'

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

const SETTINGS_ROUTE = '/prompt-enhance-v2/settings'
const ENHANCE_ROUTE = '/prompt-enhance-v2/enhance'
const PROVIDERS_ROUTE = '/prompt-enhance-v2/providers'
const MODELS_ROUTE = '/prompt-enhance-v2/models'
const MODEL_INFO_ROUTE = '/prompt-enhance-v2/model-info'
const PKG_NAME = 'dsh-qbuddy-prompt-enhance'
const SETTINGS_EVENT = 'qbuddy:settings-changed'

/* ---------------- 环境垫片 ---------------- */
let loaded = null
const styleEls = []
const documentListeners = new Map()
const fakeDocument = {
  documentElement: { lang: 'en' },
  createElement() {
    const el = { textContent: '', removed: false, setAttribute() {}, remove() { el.removed = true } }
    styleEls.push(el)
    return el
  },
  head: { appendChild() {} },
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    const set = documentListeners.get(type)
    if (set) set.delete(fn)
  },
}
function emitDocument(type, event) {
  for (const fn of [...(documentListeners.get(type) || [])]) fn(event)
}

let hookIndex = 0
const hookStates = []
let pendingEffects = []
const depsEqual = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}
const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const node = { type, props: { ...(props || {}), children } }
    // React 会把 ref.current 指到 DOM 节点上；这里用一个假节点模拟：
    // 标签宽度测量读 scrollWidth，按 8px/字符估算。
    if (props && props.ref && typeof props.ref === 'object') {
      const text = children
        .flat(Infinity)
        .filter((child) => typeof child === 'string' || typeof child === 'number')
        .join('')
      props.ref.current = { scrollWidth: text.length * 8, contains: () => false, node }
    }
    return node
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value
    }
    return [hookStates[index], set]
  },
  useEffect(effect, deps) {
    const index = hookIndex++
    const previous = hookStates[index]
    const shouldRun = !previous || !depsEqual(previous.deps, deps)
    if (!shouldRun) return
    if (previous && typeof previous.cleanup === 'function') previous.cleanup()
    const entry = { deps, cleanup: undefined }
    hookStates[index] = entry
    // 真 React 在提交（ref 挂好）之后才跑 effect；垫片统一等组件函数返回再跑。
    pendingEffects.push({ entry, effect })
  },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = { current: initial }
    return hookStates[index]
  },
}
function flushEffects() {
  const queued = pendingEffects
  pendingEffects = []
  for (const { entry, effect } of queued) {
    const cleanup = effect()
    if (typeof cleanup === 'function') entry.cleanup = cleanup
  }
}

const windowListeners = new Map()
const windowEvents = []
const fakeWindow = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    const set = windowListeners.get(type)
    if (set) set.delete(fn)
  },
  dispatchEvent(event) {
    windowEvents.push(event.type)
    for (const fn of [...(windowListeners.get(event.type) || [])]) fn(event)
    return true
  },
}

/* ---------------- 请求路由 ---------------- */
const fetchCalls = []
let settingsFetchCount = 0
let saveCalls = []
let enhanceCalls = []
let settingsImpl = async () => settingsResponse()
let saveImpl = async (init) => jsonResponse({ ok: true, data: settingsFromBody(JSON.parse(init.body)) })
let enhanceImpl = async () => enhanceResponse('增强后的提示词')
let providersImpl = async () => jsonResponse({ ok: true, data: { providers: [] } })
let modelsImpl = async () => jsonResponse({ ok: true, data: { provider: '', models: [] } })
const modelInfoCalls = []
let modelInfoImpl = async () => jsonResponse({ ok: true, data: { provider: '', model: '', reasoning: null } })

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

const builtinPresets = () =>
  PRESETS.map((preset) => ({
    id: preset.id,
    label: { ...preset.label },
    description: { ...preset.description },
  }))

function settingsData(overrides = {}) {
  return {
    current: 'qbuddy',
    presets: builtinPresets(),
    canWrite: true,
    entryId: 'dsh-qbuddy-prompt-enhance',
    config: { provider: '', model: '', timeoutMs: 30000 },
    customPresets: [],
    customDefaults: {
      name: { zh: '自定义', en: 'Custom' },
      system: 'DEFAULT-SYSTEM',
      user: 'DEFAULT {{draft}}',
    },
    ...overrides,
  }
}

/** 宿主 PUT 后回的快照：把自定义预设拼进菜单列表。 */
function settingsFromBody(body) {
  const data = settingsData()
  const current = typeof body.preset === 'string' ? body.preset : 'qbuddy'
  if (Array.isArray(body.presets)) {
    data.customPresets = body.presets
    data.presets = [
      ...data.presets,
      ...body.presets.map((preset) => ({
        id: preset.id,
        label: { zh: preset.name, en: preset.name },
        custom: true,
      })),
    ]
  }
  if (body.config && typeof body.config === 'object') data.config = { ...data.config, ...body.config }
  return { ...data, current }
}

function settingsResponse(data = settingsData()) {
  return jsonResponse({ ok: true, data })
}
const enhanceResponse = (text) => jsonResponse({ ok: true, data: { text } })
const errResponse = (status, code, message) => jsonResponse({ ok: false, error: { code, message } }, status)

async function fetchRouter(url, init = {}) {
  fetchCalls.push({ url, init })
  if (url === SETTINGS_ROUTE && init.method === 'PUT') {
    saveCalls.push(JSON.parse(init.body))
    return saveImpl(init)
  }
  if (url === SETTINGS_ROUTE) {
    settingsFetchCount += 1
    return settingsImpl()
  }
  if (url === ENHANCE_ROUTE) {
    enhanceCalls.push(JSON.parse(init.body))
    return enhanceImpl(init)
  }
  if (url === PROVIDERS_ROUTE) return providersImpl(init)
  if (url.startsWith(MODELS_ROUTE)) return modelsImpl(url)
  if (url.startsWith(MODEL_INFO_ROUTE)) {
    modelInfoCalls.push(url)
    return modelInfoImpl(url)
  }
  throw new Error('unexpected fetch: ' + url)
}

function resetFetch(next = {}) {
  fetchCalls.length = 0
  settingsFetchCount = 0
  saveCalls = []
  enhanceCalls = []
  settingsImpl = async () => settingsResponse()
  saveImpl = async (init) => jsonResponse({ ok: true, data: settingsFromBody(JSON.parse(init.body)) })
  enhanceImpl = async () => enhanceResponse('增强后的提示词')
  providersImpl = next.providers ?? (async () => jsonResponse({ ok: true, data: { providers: [] } }))
  modelsImpl = next.models ?? (async () => jsonResponse({ ok: true, data: { provider: '', models: [] } }))
  modelInfoCalls.length = 0
  modelInfoImpl =
    next.modelInfo ??
    (async () => jsonResponse({ ok: true, data: { provider: '', model: '', reasoning: null } }))
}

/* ---------------- 候选模型垫片 ---------------- */
const fakeProviders = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'other', name: 'Other' },
]
const fakeModels = {
  deepseek: [
    { id: 'flash', name: 'Flash' },
    { id: 'pro', name: 'Pro' },
  ],
  other: [{ id: 'm1', name: 'M1' }],
}
const modelCalls = { providers: 0, models: [] }
function resetModel(next = {}) {
  modelCalls.providers = 0
  modelCalls.models.length = 0
  providersImpl =
    next.providers ??
    (async () => {
      modelCalls.providers += 1
      return jsonResponse({ ok: true, data: { providers: fakeProviders } })
    })
  modelsImpl =
    next.models ??
    (async (url) => {
      const provider = new URL(url, 'http://x').searchParams.get('provider') || ''
      modelCalls.models.push(provider)
      return jsonResponse({ ok: true, data: { provider, models: fakeModels[provider] ?? [] } })
    })
}

/* ---------------- 载入插件脚本 ---------------- */
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'fetch', 'console', source)(
  fakeWindow,
  fakeDocument,
  (url, init) => fetchRouter(url, init),
  console,
)

check('脚本调用了 __ModuleLoader__.load', Boolean(loaded && typeof loaded.factory === 'function'))
eq('模块 id 是包名', loaded.id, PKG_NAME)

/*
 * 0.6.4 的事故回归：空草稿时提前 return null，而新加的 hook 在那之后，
 * 一打字就变成「Rendered more hooks than during the previous render」，整条按钮消失。
 * 这里静态盯住「条件 return 必须排在最后一个 hook 之后」。
 */
{
  const start = source.indexOf('function EnhanceButton')
  const end = source.indexOf('function ConfigCard')
  const body = start >= 0 && end > start ? source.slice(start, end) : ''
  const hookHits = [...body.matchAll(/React\.use[A-Za-z]+/g)].map((hit) => hit.index)
  const earlyHits = [...body.matchAll(/return null/g)].map((hit) => hit.index)
  check('按钮组件可定位', body !== '')
  check('按钮组件里有 hook', hookHits.length > 0, String(hookHits.length))
  check(
    '条件 return 排在所有 hook 之后',
    earlyHits.length === 0 || Math.min(...earlyHits) > Math.max(...hookHits),
    JSON.stringify({ early: earlyHits, lastHook: Math.max(...hookHits) }),
  )
}

const module_ = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
check(
  '导出 inject = slots + locale',
  Array.isArray(module_.inject) && module_.inject.includes('slots') && module_.inject.includes('locale'),
  JSON.stringify(module_.inject),
)
check('导出 apply 函数', typeof module_.apply === 'function')

/* ---------------- 假 ctx ---------------- */
const registrations = []
let dictionary = null
let injectCalls = 0
const ctxTarget = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(names, callback) {
    injectCalls += 1
    return callback({})
  },
  locale: {
    register(namespace, dict) {
      dictionary = { namespace, dict }
    },
    bind() {
      return (key) => {
        const table = dictionary && dictionary.dict && dictionary.dict.en
        return (table && table[key]) || key
      }
    },
  },
  slots: {
    inject(name, callback) {
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
// 真 cordis 的 ctx 是服务解析代理：没 inject 的服务直接读会抛
// `cannot get property "x" without inject`，整个插件 apply 随之失败。
// 垫片照样严格，插件才不会被「读一眼宿主服务」这种写法悄悄写坏。
const fakeCtx = new Proxy(ctxTarget, {
  get(target, prop) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop)
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

let strictThrow = null
try {
  fakeCtx.llm
  strictThrow = 'no throw'
} catch (error) {
  strictThrow = error.message
}
eq('未 inject 的服务直接读会抛（与真宿主一致）', strictThrow, 'cannot get property "llm" without inject')

module_.apply(fakeCtx)
eq('apply 注册了两个插槽', registrations.length, 2)

const registrationOf = (name) => registrations.find((row) => row.options && row.options.name === name) ?? null
const inputRegistration = registrationOf('conversation.input.right')
const configRegistration = registrationOf('plugins.bundle.config')
const inputComponent = inputRegistration && inputRegistration.component
const configComponent = configRegistration && configRegistration.component

check('注册到 conversation.input.right', Boolean(inputRegistration), JSON.stringify(registrations.map((row) => row.options)))
check('注册到 plugins.bundle.config', Boolean(configRegistration), JSON.stringify(registrations.map((row) => row.options)))
eq('输入框插槽 id 与入口一致', inputRegistration?.options.id, 'prompt-enhance-v2')
eq('输入框插槽声明 locale', inputRegistration?.options.locale, 'prompt-enhance-v2')
eq('输入框插槽 order', inputRegistration?.options.order, 0)
eq('详情页卡片 key 是包名', configRegistration?.options.key, PKG_NAME)
eq('插件不再 inject 宿主服务', injectCalls, 0)
check('输入框插槽没有 inject', inputRegistration?.options.inject === undefined)
check(
  '语言包已注册',
  Boolean(dictionary) && dictionary.namespace === 'prompt-enhance-v2' && Boolean(dictionary.dict.zh && dictionary.dict.en),
)
check('注入了样式', styleEls.length === 1 && styleEls[0].textContent.includes('.pev2-split'))
check(
  '样式含菜单 / 模型行 / 配置卡片',
  styleEls[0].textContent.includes('.pev2-menu') &&
    styleEls[0].textContent.includes('.pev2-model-row') &&
    styleEls[0].textContent.includes('.pev2-cfg'),
)

const flatten = (object, prefix = '') =>
  Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' ? flatten(value, prefix + key + '.') : [[prefix + key, value]],
  )
const sortedEntries = (object) =>
  Object.entries(object)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + '=' + value)
    .join('\n')
for (const lang of ['zh', 'en']) {
  const file = JSON.parse(readFileSync(new URL('../locale/' + lang + '.json', import.meta.url), 'utf8'))
  eq('locale/' + lang + '.json 与客户端字典一致', sortedEntries(Object.fromEntries(flatten(file))), sortedEntries(dictionary.dict[lang]))
  eq('显示名是包名（' + lang + '）', dictionary.dict[lang]['meta.title'], PKG_NAME)
}

const css = styleEls[0].textContent
const baseOrbRule = css.match(/\.pev2-main svg \.pev2-orb\{[^}]*\}/)
check('空闲时图标静止', baseOrbRule !== null && !baseOrbRule[0].includes('animation'))
check('思考时收缩', css.includes('[data-busy="true"] svg .pev2-orb{animation:pev2-breathe 1.15s ease-in-out infinite}'))
check('样式含收缩关键帧', css.includes('@keyframes pev2-breathe'))
check(
  '减弱动效时静止',
  css.includes('@media (prefers-reduced-motion:reduce){.pev2-main[data-busy="true"] svg .pev2-orb{animation:none}'),
)
check('标签宽度有过渡', /\.pev2-label\{[^}]*transition:width \.18s ease/.test(css))
check(
  '减弱动效时关掉宽度过渡',
  /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.pev2-label\{transition:none\}/.test(css),
)

const iconSource = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
check('图标显示名是包名', iconSource.includes('aria-label="' + PKG_NAME + '"'))
check('图标是静态文件', !iconSource.includes('animation') && !iconSource.includes('@keyframes'))
check('图标是交叉轨道造型', (iconSource.match(/<ellipse /g) || []).length === 2)
check('图标保留中心点', iconSource.includes('r="4.8"'))
check('客户端图标也是交叉轨道', (source.match(/h\('ellipse'/g) || []).length === 2)

/* ---------------- 渲染驱动 ---------------- */
const store = { draft: '帮我把登录页改成深色', draftRev: 1 }
const calls = { setDraft: [], persistDraft: 0 }
function typeDraft(text) {
  store.draft = text
  store.draftRev += 1
}
function bumpRev() {
  store.draftRev += 1
}
let props = null
function makeProps(overrides = {}) {
  return {
    useInput: (selector) => selector(store),
    inputActions: {
      setDraft(text) {
        calls.setDraft.push(text)
        store.draft = text
        store.draftRev += 1
      },
      persistDraft() {
        calls.persistDraft += 1
      },
    },
    t: fakeCtx.locale.bind(),
    ...overrides,
  }
}

function render(next = props) {
  hookIndex = 0
  pendingEffects = []
  const tree = inputComponent(next)
  flushEffects()
  return tree
}
function renderConfig(next) {
  hookIndex = 0
  pendingEffects = []
  const element = configComponent(next ?? { view: 'page', t: fakeCtx.locale.bind() })
  const tree = element && typeof element === 'object' && typeof element.type === 'function'
    ? element.type(element.props)
    : element
  flushEffects()
  return tree
}
function resetState() {
  for (const entry of hookStates) {
    if (entry && typeof entry === 'object' && typeof entry.cleanup === 'function') entry.cleanup()
  }
  hookStates.length = 0
  hookIndex = 0
}
function resetCalls() {
  calls.setDraft.length = 0
  calls.persistDraft = 0
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
// 一次 render 只跑一遍 effect；候选是链式拉的，要多跑几轮才收敛。
async function pump(times = 4) {
  let tree = render()
  for (let index = 0; index < times; index += 1) {
    await settle()
    tree = render()
  }
  return tree
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  for (const child of list) walk(child, visit)
}
function classList(node) {
  const value = node.props && node.props.className
  return typeof value === 'string' ? value.split(/\s+/) : []
}
function findClass(tree, className) {
  let found = null
  walk(tree, (node) => {
    if (found === null && classList(node).includes(className)) found = node
  })
  return found
}
function findAllClass(tree, className) {
  const found = []
  walk(tree, (node) => {
    if (classList(node).includes(className)) found.push(node)
  })
  return found
}
function textOfNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node.props) return ''
  const children = node.props.children
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.map(textOfNode).join('')
}
function buttonsOf(tree) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'button') found.push(node)
  })
  return found
}
function buttonByText(tree, text) {
  return buttonsOf(tree).find((node) => textOfNode(node).trim() === text) ?? null
}
function optionsOf(node) {
  const children = node && node.props ? node.props.children : null
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter((child) => child && child.type === 'option')
}
const selectsOf = (tree) => findAllClass(tree, 'pev2-select')
const mainButton = (tree) => findClass(tree, 'pev2-main')
const caretButton = (tree) => findClass(tree, 'pev2-caret')
const menuOf = (tree) => findClass(tree, 'pev2-menu')
const itemsOf = (tree) => findAllClass(tree, 'pev2-item')
const modelRowOf = (tree) => findClass(tree, 'pev2-model-row')
const labelOf = (tree) => findClass(tree, 'pev2-label')
const labelWidth = (tree) => {
  const span = labelOf(tree)
  return span && span.props.style ? span.props.style.width : null
}
const itemTexts = (tree) => itemsOf(tree).map((item) => textOfNode(findClass(item, 'pev2-item-label')))
const itemByText = (tree, text) =>
  itemsOf(tree).find((item) => textOfNode(findClass(item, 'pev2-item-label')) === text) ?? null

async function mountReady(settings = null, modelOverrides = undefined, fetchOverrides = undefined) {
  resetState()
  resetFetch(fetchOverrides)
  resetModel(modelOverrides)
  resetCalls()
  props = makeProps()
  if (settings !== null) settingsImpl = settings
  render()
  await settle()
  render()
  return render()
}

async function mountConfig(settings = null, fetchOverrides = undefined) {
  resetState()
  resetFetch(fetchOverrides)
  if (settings !== null) settingsImpl = settings
  renderConfig()
  await settle()
  renderConfig()
  return renderConfig()
}

function openMenu(tree) {
  caretButton(tree).props.onClick()
  return render()
}

/* ---------------- 初始渲染 ---------------- */
console.log('初始渲染')
store.draft = '帮我把登录页改成深色'
let tree = await mountReady()
check('根节点是 split button', tree !== null && tree.props.className === 'pev2-split')
check('左段存在', mainButton(tree) !== null)
check('右段存在', caretButton(tree) !== null)
eq('默认加载 settings', settingsFetchCount, 1)
eq('settings 请求路由', fetchCalls[0].url, SETTINGS_ROUTE)
check('settings 是 GET', fetchCalls[0].init.method === undefined, fetchCalls[0].init.method)
eq('左段显示当前档', textOfNode(labelOf(tree)), 'QBuddy')
eq('左段标题带当前档', mainButton(tree).props.title, 'QBuddy enhance prompt (current: QBuddy)')
eq('右段初始标题', caretButton(tree).props.title, 'Choose preset')
eq('右段可用', caretButton(tree).props.disabled, false)
check('菜单初始关闭', menuOf(tree) === null)
eq('初始不是忙碌态', mainButton(tree).props['data-busy'], 'false')
eq('初始不是错误态', mainButton(tree).props['data-error'], 'false')
check('标签宽度按实测写死', labelWidth(tree) === '48px', labelWidth(tree))
const idleIcon = mainButton(tree).props.children[0]
check('左段用原子轨道图标', idleIcon && idleIcon.type && idleIcon.type.name === 'QBuddyIcon')

store.draft = ''
tree = render()
check('空草稿时整个按钮不渲染', tree === null, JSON.stringify(tree && tree.props))
store.draft = '   \n\t '
tree = render()
check('纯空白也算空草稿', tree === null)
store.draft = '帮我把登录页改成深色'

/* ---------------- 标签宽度过渡 ---------------- */
console.log('标签宽度过渡')
tree = await mountReady()
tree = openMenu(tree)
await itemByText(tree, 'WorkBuddy Expand').props.onClick()
tree = render()
eq('换成长档名立即更新文本', textOfNode(labelOf(tree)), 'WorkBuddy Expand')
tree = render()
eq('长档名按上限收住', labelWidth(tree), '110px')
tree = openMenu(tree)
await itemByText(tree, 'Qoder').props.onClick()
tree = render()
tree = render()
// 最小宽度锚到默认档（QBuddy）档名：换回更短的档名也不再变窄。
eq('换回短档名仍保持最小宽度', labelWidth(tree), '48px')

/* ---------------- 增强成功 ---------------- */
console.log('增强成功')
store.draft = '帮我把登录页改成深色'
tree = await mountReady()
let pending = mainButton(tree).props.onClick()
tree = render()
eq('请求中标题', mainButton(tree).props.title, 'Enhancing; click again to cancel')
eq('请求中忙碌标记', mainButton(tree).props['data-busy'], 'true')
eq('请求中左段可点（取消）', mainButton(tree).props.disabled, false)
eq('请求中右段仍可切档', caretButton(tree).props.disabled, false)
await pending
tree = render()
eq('成功后标题复原', mainButton(tree).props.title, 'QBuddy enhance prompt (current: QBuddy)')
eq('写出结果', calls.setDraft[0], '增强后的提示词')
eq('只写一次', calls.setDraft.length, 1)
eq('持久化草稿', calls.persistDraft, 1)
eq('草稿被替换', store.draft, '增强后的提示词')
eq('一次增强只发一次请求', enhanceCalls.length, 1)
eq('增强请求路由正确', fetchCalls.filter((call) => call.url === ENHANCE_ROUTE).length, 1)
eq('增强请求方法', fetchCalls.find((call) => call.url === ENHANCE_ROUTE).init.method, 'POST')
eq(
  '增强请求 content-type',
  fetchCalls.find((call) => call.url === ENHANCE_ROUTE).init.headers['content-type'],
  'application/json',
)
eq('请求带当前预设 id', enhanceCalls[0].preset, 'qbuddy')
eq('请求带草稿原文', enhanceCalls[0].draft, '帮我把登录页改成深色')

/* ---------------- 增强失败 ---------------- */
console.log('增强失败')
store.draft = '写个脚本'
tree = await mountReady()
enhanceImpl = async () => errResponse(502, 'RATE_LIMITED', '模型炸了')
await mainButton(tree).props.onClick()
tree = render()
eq('未知错误码不覆盖草稿', store.draft, '写个脚本')
eq('未知错误码不写草稿', calls.setDraft.length, 0)
check('未知错误码标题带原因', mainButton(tree).props.title.includes('模型炸了'), mainButton(tree).props.title)
eq('错误态标记', mainButton(tree).props['data-error'], 'true')

enhanceImpl = async () => errResponse(504, 'TIMEOUT', '增强超时')
await mainButton(tree).props.onClick()
tree = render()
eq('超时标题', mainButton(tree).props.title, 'Enhancement timed out, try again')
eq('超时草稿不变', store.draft, '写个脚本')

enhanceImpl = async () => {
  throw new TypeError('Failed to fetch')
}
await mainButton(tree).props.onClick()
tree = render()
eq('网络错误标题', mainButton(tree).props.title, 'Enhancement failed: network error')
eq('网络错误草稿不变', store.draft, '写个脚本')

enhanceImpl = async () => enhanceResponse('   ')
await mainButton(tree).props.onClick()
tree = render()
eq('空结果标题', mainButton(tree).props.title, 'The model returned nothing; the draft was left untouched')
eq('空结果不写草稿', calls.setDraft.length, 0)
eq('空结果保留草稿', store.draft, '写个脚本')

enhanceImpl = async () => errResponse(502, 'OUTPUT_TRUNCATED', '模型输出被截断')
await mainButton(tree).props.onClick()
tree = render()
eq(
  '截断有单独文案',
  mainButton(tree).props.title,
  'The model output was truncated; the draft was left untouched, try again',
)
eq('截断不写草稿', calls.setDraft.length, 0)

enhanceImpl = async () => errResponse(409, 'CUSTOM_EMPTY', '自定义预设还没配置')
await mainButton(tree).props.onClick()
tree = render()
eq(
  '自定义未配置指向详情页',
  mainButton(tree).props.title,
  'The custom preset is not configured yet; fill it in on the plugin page',
)

enhanceImpl = async () => ({ ok: true, status: 200, text: async () => 'not json' })
await mainButton(tree).props.onClick()
tree = render()
eq('坏响应按网络错误处理', mainButton(tree).props.title, 'Enhancement failed: network error')

enhanceImpl = async () => enhanceResponse('终于成功')
await mainButton(tree).props.onClick()
tree = render()
eq('成功后清除错误态', mainButton(tree).props['data-error'], 'false')
eq('成功后标题复原', mainButton(tree).props.title, 'QBuddy enhance prompt (current: QBuddy)')
eq('成功后写回', store.draft, '终于成功')

/* ---------------- 忙碌态 ---------------- */
console.log('忙碌态')
store.draft = '再来一次'
tree = await mountReady()
let resolveFetch = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveFetch = resolve
  })
const firstClick = mainButton(tree).props.onClick()
// 同一帧内再点：busy 状态还没重渲染，必须由同步闸门挡住。
const sameTickClick = mainButton(tree).props.onClick()
tree = render()
await sameTickClick
eq('同一帧内双击只发一次请求', enhanceCalls.length, 1)
await mainButton(tree).props.onClick()
eq('刚发起时连点不算取消', mainButton(tree).props['data-busy'], 'true')
eq('忙碌时第二次点击不发请求', enhanceCalls.length, 1)
resolveFetch(enhanceResponse('结果'))
await firstClick
tree = render()
eq('忙碌结束后写回', store.draft, '结果')

/* ---------------- 并发保护 ---------------- */
console.log('并发保护')

// 草稿没变（文本与修订号都没变）-> 直接写回。
store.draft = '原样草稿'
store.draftRev = 10
tree = await mountReady()
enhanceImpl = async () => enhanceResponse('原样结果')
await mainButton(tree).props.onClick()
tree = render()
eq('草稿未变直接写回', store.draft, '原样结果')
eq('草稿未变只写一次', calls.setDraft.length, 1)
eq('草稿未变不进应用态', mainButton(tree).props['data-staged'], 'false')

// 中途改字 -> 不写回，进入「应用」态。
store.draft = '第一版'
store.draftRev = 20
tree = await mountReady()
let resolveChanged = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveChanged = resolve
  })
let slowClick = mainButton(tree).props.onClick()
tree = render()
typeDraft('用户中途改的新内容')
tree = render()
resolveChanged(enhanceResponse('第一版的增强结果'))
await slowClick
tree = render()
eq('中途改字不写回', calls.setDraft.length, 0)
eq('中途改字保留用户输入', store.draft, '用户中途改的新内容')
eq('中途改字进入应用态', mainButton(tree).props['data-staged'], 'true')
eq('应用态按钮文案', textOfNode(labelOf(tree)), 'Apply')
eq('应用态标题带发起时档名', mainButton(tree).props.title, 'Apply the QBuddy result (overwrites the current draft)')
eq('应用态不是错误态', mainButton(tree).props['data-error'], 'false')
tree = render()
eq('应用态也不会窄于最小宽度', labelWidth(tree), '48px')
mainButton(tree).props.onClick()
tree = render()
eq('点应用覆盖草稿', store.draft, '第一版的增强结果')
eq('点应用只写一次', calls.setDraft.length, 1)
eq('点应用持久化', calls.persistDraft, 1)
eq('应用后回到空闲', mainButton(tree).props['data-staged'], 'false')
eq('应用后标签恢复当前档', textOfNode(labelOf(tree)), 'QBuddy')

// 文字没变但修订号变了 -> 同样视为改过，必须等用户确认。
store.draft = '不动的字'
store.draftRev = 30
tree = await mountReady()
let resolveRev = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveRev = resolve
  })
slowClick = mainButton(tree).props.onClick()
tree = render()
bumpRev()
tree = render()
resolveRev(enhanceResponse('修订号变化的结果'))
await slowClick
tree = render()
eq('仅修订号变化也进应用态', mainButton(tree).props['data-staged'], 'true')
eq('仅修订号变化不覆盖', store.draft, '不动的字')

// 草稿被清空 -> 丢弃结果，回到 idle。
store.draft = '会被清空'
store.draftRev = 40
tree = await mountReady()
let resolveCleared = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveCleared = resolve
  })
slowClick = mainButton(tree).props.onClick()
tree = render()
typeDraft('')
tree = render()
eq('清空后请求仍在途', mainButton(tree).props['data-busy'], 'true')
resolveCleared(enhanceResponse('迟到的结果'))
await slowClick
tree = render()
eq('清空后不写回', calls.setDraft.length, 0)
eq('清空后草稿仍为空', store.draft, '')
eq('清空后没有残留按钮', tree, null)
typeDraft('重新写的内容')
tree = render()
eq('重新输入回到空闲', mainButton(tree).props['data-staged'], 'false')
eq('重新输入不复活旧结果', textOfNode(labelOf(tree)), 'QBuddy')

// 「应用」态下切档：已经拿到的结果不丢，标题仍记发起时的档名。
store.draft = '切档前草稿'
store.draftRev = 50
tree = await mountReady()
let resolveSwitch = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveSwitch = resolve
  })
slowClick = mainButton(tree).props.onClick()
tree = render()
typeDraft('用户又改了')
tree = render()
resolveSwitch(enhanceResponse('暂存结果'))
await slowClick
tree = render()
tree = openMenu(tree)
await itemByText(tree, 'Qoder').props.onClick()
tree = render()
eq('切档后仍是应用态', mainButton(tree).props['data-staged'], 'true')
eq('切档后仍显示应用', textOfNode(labelOf(tree)), 'Apply')
eq('应用态标题保留发起时档名', mainButton(tree).props.title, 'Apply the QBuddy result (overwrites the current draft)')
eq('切档已写入配置', saveCalls[0].preset, 'qoder')
mainButton(tree).props.onClick()
tree = render()
eq('切档后应用仍写入暂存结果', store.draft, '暂存结果')

/* ---------------- 切档菜单 ---------------- */
console.log('切档菜单')
store.draft = '切档测试'
// 这一段只测档位：候选留空，免得把模型候选的请求计数搅进后面的用例。
tree = await mountReady(null, {
  providers: async () => jsonResponse({ ok: true, data: { providers: [] } }),
  models: async () => jsonResponse({ ok: true, data: { provider: '', models: [] } }),
})
tree = openMenu(tree)
check('点右段弹出菜单', menuOf(tree) !== null)
eq('没建过自定义时只列四档内置', itemsOf(tree).length, 4)
eq('菜单顺序从保守到激进', itemTexts(tree).join(','), 'Qoder,WorkBuddy Polish,QBuddy,WorkBuddy Expand')
const currentItems = itemsOf(tree).filter((item) => item.props['data-current'] === 'true')
eq('菜单只标一个当前档', currentItems.length, 1)
eq('当前档是 QBuddy', textOfNode(findClass(currentItems[0], 'pev2-item-label')), 'QBuddy')
eq('当前档无障碍标记', currentItems[0].props['aria-checked'], 'true')
eq('菜单标题', textOfNode(findClass(tree, 'pev2-menu-head')), 'Choose preset')
eq('展开状态写到 aria', caretButton(tree).props['aria-expanded'], 'true')
check('菜单里有模型入口', modelRowOf(tree) !== null)
eq('模型入口显示跟随默认', textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')), 'Follow the default model')

const qoderItem = itemsOf(tree)[0]
const saving = qoderItem.props.onClick()
tree = render()
// 写入 profile 要 ~1s：界面必须先落地，不能顶着等。
eq('切档立即关闭菜单', menuOf(tree), null)
eq('切档立即换左段档名', textOfNode(labelOf(tree)), 'Qoder')
eq('切档立即换标题', mainButton(tree).props.title, 'QBuddy enhance prompt (current: Qoder)')
eq('切档期间右段仍可点', caretButton(tree).props.disabled, false)
await saving
tree = render()
eq('PUT 一次配置', saveCalls.length, 1)
eq('PUT 带选中的档位', saveCalls[0].preset, 'qoder')
eq(
  'PUT 路由正确',
  fetchCalls.filter((call) => call.url === SETTINGS_ROUTE && call.init.method === 'PUT').length,
  1,
)
eq('落盘成功后档名不变', textOfNode(labelOf(tree)), 'Qoder')
eq('切档不重新拉 settings', settingsFetchCount, 1)

await mainButton(tree).props.onClick()
eq('下一次增强带新档', enhanceCalls[0].preset, 'qoder')

// 连续切档：写入串行排队，后点的档位不被旧回包拽回去
console.log('连续切档')
let releaseFirst = null
saveImpl = async (init) => {
  const body = JSON.parse(init.body)
  if (body.preset === 'workbuddy-polish') {
    await new Promise((resolve) => {
      releaseFirst = resolve
    })
  }
  return jsonResponse({ ok: true, data: settingsFromBody(body) })
}
tree = openMenu(tree)
const polishWrite = itemByText(tree, 'WorkBuddy Polish').props.onClick()
tree = render()
eq('第一档立即生效', textOfNode(labelOf(tree)), 'WorkBuddy Polish')
await settle()
eq('第一档请求已发出', saveCalls.length, 2)
tree = openMenu(tree)
const expandWrite = itemByText(tree, 'WorkBuddy Expand').props.onClick()
tree = render()
eq('第二档立即覆盖显示', textOfNode(labelOf(tree)), 'WorkBuddy Expand')
eq('第二档等第一档落盘后才发', saveCalls.length, 2)
eq('第二档请求还排在队列里', saveCalls[1].preset, 'workbuddy-polish')
releaseFirst()
await Promise.all([polishWrite, expandWrite])
tree = render()
eq('两档都落盘', saveCalls.map((call) => call.preset).join(','), 'qoder,workbuddy-polish,workbuddy-expand')
eq('旧回包不覆盖新选择', textOfNode(labelOf(tree)), 'WorkBuddy Expand')

// 再打开菜单点当前档：只关闭，不写配置
tree = openMenu(tree)
const qbuddyItem = itemsOf(tree).find((item) => item.props['data-current'] === 'true')
qbuddyItem.props.onClick()
tree = render()
eq('点当前档不发 PUT', saveCalls.length, 3)
eq('点当前档关闭菜单', menuOf(tree), null)

// 点外面关闭
tree = openMenu(tree)
check('再次打开菜单', menuOf(tree) !== null)
emitDocument('mousedown', { target: { outside: true } })
tree = render()
eq('点外面关闭菜单', menuOf(tree), null)

// Esc 关闭
tree = openMenu(tree)
check('Esc 前菜单打开', menuOf(tree) !== null)
emitDocument('keydown', { key: 'Escape' })
tree = render()
eq('Esc 关闭菜单', menuOf(tree), null)

// 切档失败：菜单保持打开并显示原因，当前档不变
console.log('切档失败')
// 同上：这一段不测候选，留空避免请求回包落到下一个用例的挂载上。
tree = await mountReady(null, {
  providers: async () => jsonResponse({ ok: true, data: { providers: [] } }),
  models: async () => jsonResponse({ ok: true, data: { provider: '', models: [] } }),
})
saveImpl = async () => errResponse(503, 'NO_EDITOR', '没有 configEditor')
tree = openMenu(tree)
await itemsOf(tree)[0].props.onClick()
tree = render()
check('失败后菜单保持打开', menuOf(tree) !== null)
eq(
  '失败原因本地化',
  textOfNode(findClass(tree, 'pev2-menu-error')),
  'This host cannot persist config; preset switching is unavailable',
)
eq('失败后当前档不变', textOfNode(labelOf(tree)), 'QBuddy')

/* ---------------- 菜单里的提示词模型快切 ---------------- */
console.log('提示词模型快切')
store.draft = '模型切换'
tree = await mountReady()
eq('挂载时不拉候选', modelCalls.providers, 0)
tree = openMenu(tree)
tree = await pump()
eq('打开菜单会拉 provider 候选', modelCalls.providers, 1)
eq(
  '入口默认显示跟随默认',
  textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')),
  'Follow the default model',
)
modelRowOf(tree).props.onClick()
tree = await pump()
eq('进入模型列表', textOfNode(findClass(tree, 'pev2-menu-nav-title')), 'Choose prompt model')
eq(
  '模型按 provider 分组列出',
  itemTexts(tree).join(','),
  'Follow the default model,Flash,Pro,M1',
)
eq('跟随默认带勾选', itemsOf(tree)[0].props['data-current'], 'true')
eq('分组标题', textOfNode(findClass(tree, 'pev2-menu-head')), 'DeepSeek')
eq('逐个 provider 拉了候选', modelCalls.models.join(','), 'deepseek,other')

// 选模型：只写插件自己的 config，不碰会话正在用的模型。
await itemByText(tree, 'Pro').props.onClick()
tree = render()
eq(
  '选模型写的是插件 config',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: 'deepseek', model: 'pro', reasoningEffort: '' }),
)
eq('选模型不带 preset', 'preset' in saveCalls[saveCalls.length - 1], false)
eq('成功后关闭菜单', menuOf(tree), null)
tree = openMenu(tree)
tree = await pump()
eq(
  '入口显示新模型',
  textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')),
  'DeepSeek / Pro',
)

// 点当前模型：只关菜单，不写配置。
const beforeSame = saveCalls.length
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Pro').props.onClick()
tree = render()
eq('点当前模型不写配置', saveCalls.length, beforeSame)
eq('点当前模型关闭菜单', menuOf(tree), null)

// 回到跟随默认。
tree = openMenu(tree)
tree = await pump()
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Follow the default model').props.onClick()
tree = render()
eq(
  '跟随默认写空串',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: '', model: '', reasoningEffort: '' }),
)
tree = openMenu(tree)
tree = await pump()
eq(
  '跟随默认回到默认文案',
  textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')),
  'Follow the default model',
)

// 保存失败：菜单重新打开、给出原因，配置回到宿主真值。
saveImpl = async () => errResponse(503, 'NO_EDITOR', '没有 configEditor')
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Pro').props.onClick()
tree = await pump()
check('保存失败把菜单重新打开', menuOf(tree) !== null)
eq(
  '保存失败显示原因',
  textOfNode(findClass(tree, 'pev2-menu-error')),
  'Saving the prompt model failed: 没有 configEditor',
)
eq(
  '失败后回到宿主真值',
  textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')),
  'Follow the default model',
)
saveImpl = async (init) => jsonResponse({ ok: true, data: settingsFromBody(JSON.parse(init.body)) })
emitDocument('keydown', { key: 'Escape' })
tree = render()

// 宿主列不出候选：入口照旧能点，进去给一句说明。
tree = await mountReady(null, {
  providers: async () => jsonResponse({ ok: true, data: { providers: [] } }),
  models: async () => jsonResponse({ ok: true, data: { provider: '', models: [] } }),
})
tree = openMenu(tree)
tree = await pump()
modelRowOf(tree).props.onClick()
tree = await pump()
eq('没有候选时给说明', textOfNode(findClass(tree, 'pev2-menu-empty')), 'No models available')
check('没有候选也能返回', findClass(tree, 'pev2-back') !== null)
emitDocument('keydown', { key: 'Escape' })
tree = render()

/* ---------------- 菜单里的思考强度 ---------------- */
console.log('菜单里的思考强度')
store.draft = '思考强度快切'
// 只有 pro 报了强度：flash 与 other/m1 都没有。
const effortInfoImpl = async (url) => {
  const params = new URL(url, 'http://x').searchParams
  const model = params.get('model') || ''
  const provider = params.get('provider') || ''
  if (model === 'pro') {
    return jsonResponse({
      ok: true,
      data: {
        provider,
        model,
        reasoning: {
          defaultEffort: 'medium',
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
      },
    })
  }
  return jsonResponse({ ok: true, data: { provider, model, reasoning: null } })
}
tree = await mountReady(null, undefined, { modelInfo: effortInfoImpl })
tree = openMenu(tree)
tree = await pump()
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Pro').props.onClick()
tree = await pump(6)
eq(
  '选带强度的模型后停在强度面板',
  textOfNode(findClass(tree, 'pev2-menu-nav-title')),
  'Choose reasoning effort',
)
eq('强度面板列出默认与候选', itemTexts(tree).join(','), 'Default,Low,Medium,High')
eq('强度面板标题显示模型名', textOfNode(findClass(tree, 'pev2-menu-head')), 'DeepSeek / Pro')
eq('默认档带勾选', itemsOf(tree)[0].props['data-current'], 'true')
eq(
  '写模型时强度先清空',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: 'deepseek', model: 'pro', reasoningEffort: '' }),
)

// 选强度：只补 reasoningEffort。
await itemByText(tree, 'High').props.onClick()
tree = await pump(6)
eq(
  '选强度写 reasoningEffort',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: 'deepseek', model: 'pro', reasoningEffort: 'high' }),
)
eq('选完强度关闭菜单', menuOf(tree), null)

// 入口行带上强度名。
tree = openMenu(tree)
tree = await pump()
eq(
  '入口行显示模型与强度',
  textOfNode(findClass(modelRowOf(tree), 'pev2-model-row-value')),
  'DeepSeek / Pro · High',
)

// 点当前模型：直接进强度面板，不重写模型。
const beforeSameModel = saveCalls.length
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Pro').props.onClick()
tree = await pump(6)
eq(
  '点当前模型直接进强度面板',
  textOfNode(findClass(tree, 'pev2-menu-nav-title')),
  'Choose reasoning effort',
)
eq('点当前模型不重写模型', saveCalls.length, beforeSameModel)
eq('已选强度带勾选', itemByText(tree, 'High').props['data-current'], 'true')

// 返回模型列表，再选一个没有强度的模型：不进强度面板，直接收菜单。
findClass(tree, 'pev2-back').props.onClick()
tree = await pump()
eq('返回回到模型列表', textOfNode(findClass(tree, 'pev2-menu-nav-title')), 'Choose prompt model')
await itemByText(tree, 'Flash').props.onClick()
tree = await pump(6)
eq('选无强度的模型直接收菜单', menuOf(tree), null)
eq(
  '换到无强度的模型清空强度',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: 'deepseek', model: 'flash', reasoningEffort: '' }),
)

// 跟随默认：三项一起清空。
tree = openMenu(tree)
tree = await pump()
modelRowOf(tree).props.onClick()
tree = await pump()
await itemByText(tree, 'Follow the default model').props.onClick()
tree = await pump(6)
eq(
  '跟随默认清空模型与强度',
  JSON.stringify(saveCalls[saveCalls.length - 1].config),
  JSON.stringify({ provider: '', model: '', reasoningEffort: '' }),
)

/* ---------------- 忙碌中切档 ---------------- */
console.log('忙碌中切档')
tree = await mountReady()
let resolveRunning = null
enhanceImpl = () =>
  new Promise((resolve) => {
    resolveRunning = resolve
  })
const runningClick = mainButton(tree).props.onClick()
tree = render()
eq('运行中左段可点（取消）', mainButton(tree).props.disabled, false)
eq('运行中标题提示取消', mainButton(tree).props.title, 'Enhancing; click again to cancel')
eq('运行中右段可点', caretButton(tree).props.disabled, false)
tree = openMenu(tree)
await itemByText(tree, 'Qoder').props.onClick()
tree = render()
eq('运行中切档已落盘', saveCalls[0].preset, 'qoder')
eq('运行中切档后标签更新', textOfNode(labelOf(tree)), 'Qoder')
eq('在途请求仍捕获旧档', enhanceCalls[0].preset, 'qbuddy')
resolveRunning(enhanceResponse('旧档输出'))
await runningClick
tree = render()
eq('在途结果照常写回', calls.setDraft[0], '旧档输出')
enhanceImpl = async () => enhanceResponse('新档输出')
await mainButton(tree).props.onClick()
eq('下一次请求用新档', enhanceCalls[1].preset, 'qoder')

/* ---------------- 运行态计时与取消 ---------------- */
console.log('运行态计时与取消')
const realDateNow = Date.now
let fakeNow = 1_000_000
Date.now = () => fakeNow
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 300))
store.draft = '计时测试'
store.draftRev = 60
tree = await mountReady()
enhanceImpl = (init) =>
  new Promise((resolve, reject) => {
    const signal = init && init.signal
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    }
  })
const timedClick = mainButton(tree).props.onClick()
tree = render()
eq('1 秒内不显示秒数', textOfNode(labelOf(tree)), 'QBuddy')
eq('运行中不报错', mainButton(tree).props['data-error'], 'false')
fakeNow += 1200
await waitTick()
tree = render()
eq('满 1 秒显示秒数', textOfNode(labelOf(tree)), '1s')
eq('计时数字不会把按钮压窄', labelWidth(tree), '48px')
eq('未到预算的 80% 不是警告色', mainButton(tree).props['data-overdue'], 'false')
fakeNow += 24_000
await waitTick()
tree = render()
eq('超过预算的 80% 转警告色', mainButton(tree).props['data-overdue'], 'true')
eq('警告态仍在计时', textOfNode(labelOf(tree)), '25s')
const enhanceCall = fetchCalls.find((call) => call.url === ENHANCE_ROUTE)
check('请求带 abort signal', Boolean(enhanceCall && enhanceCall.init.signal))
mainButton(tree).props.onClick()
tree = render()
eq('再点左段回到空闲', mainButton(tree).props['data-busy'], 'false')
eq('取消后秒数消失', textOfNode(labelOf(tree)), 'QBuddy')
eq('取消不报错', mainButton(tree).props['data-error'], 'false')
check('取消已 abort 请求', enhanceCall.init.signal.aborted === true)
await timedClick
tree = render()
eq('取消后草稿不动', store.draft, '计时测试')
eq('取消不写回', calls.setDraft.length, 0)
eq('取消只发过一次请求', enhanceCalls.length, 1)

/* 警告色跟随配置里的超时，而不是写死 25 秒 */
console.log('警告色跟随超时配置')
store.draft = '长超时测试'
store.draftRev = 61
tree = await mountReady(async () =>
  settingsResponse(settingsData({ config: { provider: '', model: '', timeoutMs: 600_000 } })),
)
enhanceImpl = () => new Promise(() => {})
mainButton(tree).props.onClick()
tree = render()
fakeNow += 30_000
await waitTick()
tree = render()
eq('超时 600 秒时 30 秒还不是警告色', mainButton(tree).props['data-overdue'], 'false')
fakeNow += 450_000
await waitTick()
tree = render()
eq('到预算 80% 才转警告色', mainButton(tree).props['data-overdue'], 'true')
eq('长超时下仍在计时', textOfNode(labelOf(tree)), '480s')
Date.now = realDateNow

/* ---------------- 失败后重发 ---------------- */
console.log('失败后重发')
store.draft = '重发测试'
store.draftRev = 70
tree = await mountReady()
enhanceImpl = async () => errResponse(500, 'LLM_ERROR', 'upstream boom')
await mainButton(tree).props.onClick()
tree = render()
eq('失败文案可读', mainButton(tree).props.title, 'The model call failed; the draft was left untouched')
check('失败不暴露原始错误', !mainButton(tree).props.title.includes('upstream boom'))
eq('失败后草稿不动', store.draft, '重发测试')
enhanceImpl = async () => enhanceResponse('重发成功')
await mainButton(tree).props.onClick()
tree = render()
eq('失败后重发同一份草稿', enhanceCalls[1].draft, enhanceCalls[0].draft)
eq('重发成功写回', store.draft, '重发成功')
eq('重发后错误态清除', mainButton(tree).props['data-error'], 'false')

/* ---------------- 自定义档只来自配置 ---------------- */
console.log('自定义档')
const customSettings = (configured = true) => {
  const name = 'My style'
  return settingsData({
    customPresets: [{ id: 'custom-1', name, system: 'S', user: 'U {{draft}}' }],
    presets: [
      ...builtinPresets(),
      { id: 'custom-1', label: { zh: name, en: name }, custom: true, configured },
    ],
  })
}
store.draft = '自定义测试'
store.draftRev = 80
tree = await mountReady(async () => settingsResponse(customSettings()))
tree = openMenu(tree)
eq('建过自定义后菜单多一项', itemsOf(tree).length, 5)
eq('自定义排在最后并显示名称', itemTexts(tree).at(-1), 'My style')
await itemsOf(tree).at(-1).props.onClick()
tree = render()
eq('切到自定义档写 id', saveCalls.at(-1).preset, 'custom-1')
eq('左段显示自定义名称', textOfNode(labelOf(tree)), 'My style')

// 旧配置里没填完的档：菜单直接指向详情页，不发请求。
tree = await mountReady(async () => settingsResponse(customSettings(false)))
tree = openMenu(tree)
await itemsOf(tree).at(-1).props.onClick()
tree = render()
eq('未配置的自定义档不发 PUT', saveCalls.length, 0)
check('未配置时菜单保持打开', menuOf(tree) !== null)
eq(
  '未配置时提示去详情页',
  textOfNode(findClass(tree, 'pev2-menu-error')),
  'The custom preset is not configured yet; fill it in on the plugin page',
)

/* ---------------- 跨面板刷新 ---------------- */
console.log('跨面板刷新')
store.draft = '刷新测试'
store.draftRev = 90
tree = await mountReady()
eq('初次只拉一次', settingsFetchCount, 1)
fakeWindow.dispatchEvent(new Event(SETTINGS_EVENT))
tree = render()
await settle()
tree = render()
eq('收到其它面板的通知后重拉', settingsFetchCount, 2)
check('重拉后按钮仍在', mainButton(tree) !== null)

/* ---------------- 详情页配置卡片 ---------------- */
console.log('详情页配置卡片')
eq('非 page 视图不渲染', renderConfig({ view: 'list', t: fakeCtx.locale.bind() }), null)

const configFixture = settingsData({
  config: { provider: 'vendor-a', model: 'model-b', timeoutMs: 5000 },
})
let cfg = await mountConfig(async () => settingsResponse(configFixture))
eq('卡片标题', textOfNode(findClass(cfg, 'pev2-cfg-title')), 'QBuddy settings')
check('卡片根节点', cfg.props.className === 'pev2-cfg')
const cfgInputs = findAllClass(cfg, 'pev2-input')
eq('预填 provider', cfgInputs[0].props.value, 'vendor-a')
eq('预填 model', cfgInputs[1].props.value, 'model-b')
eq('超时按秒显示', cfgInputs[2].props.value, '5')
eq('内置四档都列出', findAllClass(cfg, 'pev2-cfg-builtin').length, 4)
eq(
  '内置档带一句话介绍',
  textOfNode(findAllClass(cfg, 'pev2-cfg-builtin-desc')[3]),
  PRESETS[3].description.en,
)
check('空状态给出新建按钮', buttonByText(cfg, 'New custom preset') !== null)
check('空状态文案', textOfNode(cfg).includes('No custom presets yet.'))

// 超时不合法：行内报错并禁用保存。
const timeoutInput = findAllClass(cfg, 'pev2-input').find((node) => node.props.type === 'number')
timeoutInput.props.onChange({ target: { value: '0' } })
cfg = renderConfig()
check('超时非法时提示', textOfNode(cfg).includes('Timeout must be 0.1–600 seconds'))
eq('超时非法时保存禁用', findClass(cfg, 'pev2-cfg-primary').props.disabled, true)
findAllClass(cfg, 'pev2-input').find((node) => node.props.type === 'number').props.onChange({ target: { value: '5' } })
cfg = renderConfig()

// 想建几个建几个：新建两张卡，自动带起步模板。
buttonByText(cfg, 'New custom preset').props.onClick()
cfg = renderConfig()
buttonByText(cfg, 'New custom preset').props.onClick()
cfg = renderConfig()
const presetCards = () => findAllClass(cfg, 'pev2-cfg-preset')
eq('可以建多个自定义预设', presetCards().length, 2)
const firstCard = () => findAllClass(cfg, 'pev2-cfg-preset')[0]
const firstId = firstCard().props['data-preset-id']
check('新预设 id 符合约定', /^custom-[a-z0-9]+$/.test(firstId), firstId)
eq('新预设默认名称', findAllClass(firstCard(), 'pev2-input')[0].props.value, 'Custom 1')
eq('新预设带起步 system', findAllClass(firstCard(), 'pev2-textarea')[0].props.value, 'DEFAULT-SYSTEM')
eq('新预设带起步 user', findAllClass(firstCard(), 'pev2-textarea')[1].props.value, 'DEFAULT {{draft}}')
eq('第二个预设编号递增', findAllClass(presetCards()[1], 'pev2-input')[0].props.value, 'Custom 2')

// 校验：名称、占位符、长度。
findAllClass(firstCard(), 'pev2-input')[0].props.onChange({ target: { value: '' } })
cfg = renderConfig()
check('名称为空有提示', textOfNode(firstCard()).includes('Name is required'))
eq('名称为空时保存禁用', findClass(cfg, 'pev2-cfg-primary').props.disabled, true)
findAllClass(firstCard(), 'pev2-input')[0].props.onChange({ target: { value: 'My style' } })
cfg = renderConfig()
findAllClass(firstCard(), 'pev2-textarea')[1].props.onChange({ target: { value: '没有占位符' } })
cfg = renderConfig()
check('缺占位符有提示', textOfNode(firstCard()).includes('User template must contain {{draft}}'))
eq('缺占位符时保存禁用', findClass(cfg, 'pev2-cfg-primary').props.disabled, true)

// 起步模板按钮把 user 拉回来。
buttonByText(firstCard(), 'Fill starter templates').props.onClick()
cfg = renderConfig()
eq('重置后占位符回来', findAllClass(firstCard(), 'pev2-textarea')[1].props.value, 'DEFAULT {{draft}}')
eq('校验通过后保存可用', findClass(cfg, 'pev2-cfg-primary').props.disabled, false)

// 删掉第二张卡。
findAllClass(presetCards()[1], 'pev2-cfg-danger')[0].props.onClick()
cfg = renderConfig()
eq('删除后只剩一张卡', findAllClass(cfg, 'pev2-cfg-preset').length, 1)

// 保存：一次 PUT 带走 config + 全部自定义预设。
windowEvents.length = 0
const configSave = findClass(cfg, 'pev2-cfg-primary').props.onClick()
cfg = renderConfig()
eq('保存中按钮文案', textOfNode(findClass(cfg, 'pev2-cfg-primary')), 'Saving…')
await configSave
cfg = renderConfig()
eq('配置只 PUT 一次', saveCalls.length, 1)
eq('保存 provider', saveCalls[0].config.provider, 'vendor-a')
eq('保存 model', saveCalls[0].config.model, 'model-b')
eq('秒数换算成毫秒', saveCalls[0].config.timeoutMs, 5000)
eq('保存自定义预设数量', saveCalls[0].presets.length, 1)
eq('保存预设名称', saveCalls[0].presets[0].name, 'My style')
eq('保存预设沿用 id', saveCalls[0].presets[0].id, firstId)
eq('保存预设 system', saveCalls[0].presets[0].system, 'DEFAULT-SYSTEM')
eq('保存预设 user', saveCalls[0].presets[0].user, 'DEFAULT {{draft}}')
check('保存后给出反馈', textOfNode(cfg).includes('Saved'))
check('保存后广播刷新事件', windowEvents.includes(SETTINGS_EVENT), JSON.stringify(windowEvents))
eq('保存后卡片仍在', findAllClass(cfg, 'pev2-cfg-preset').length, 1)

// 保存失败：错误留在按钮旁，表单不清空。
saveImpl = async () => errResponse(400, 'BAD_PRESETS', 'bad preset shape')
cfg = renderConfig()
await findClass(cfg, 'pev2-cfg-primary').props.onClick()
cfg = renderConfig()
check('保存失败显示宿主原因', textOfNode(cfg).includes('Save failed: bad preset shape'), textOfNode(findClass(cfg, 'pev2-cfg-error')))
eq('保存失败不清空表单', findAllClass(cfg, 'pev2-cfg-preset').length, 1)
saveImpl = async (init) => jsonResponse({ ok: true, data: settingsFromBody(JSON.parse(init.body)) })

// 只读宿主：能看不能改。
cfg = await mountConfig(async () => settingsResponse(settingsData({ canWrite: false })))
check('只读提示', textOfNode(cfg).includes('This host cannot persist config; values are read-only.'))
eq('只读时输入禁用', findAllClass(cfg, 'pev2-input')[0].props.disabled, true)
eq('只读时保存禁用', findClass(cfg, 'pev2-cfg-primary').props.disabled, true)

// 加载失败 + 重试。
let configFail = true
cfg = await mountConfig(async () => {
  if (configFail) throw new TypeError('Failed to fetch')
  return settingsResponse()
})
check('加载失败提示', textOfNode(cfg).includes('Failed to load settings'))
check('加载失败给重试按钮', buttonByText(cfg, 'Retry') !== null)
configFail = false
buttonByText(cfg, 'Retry').props.onClick()
cfg = renderConfig()
await settle()
cfg = renderConfig()
cfg = renderConfig()
eq('重试后卡片回来', textOfNode(findClass(cfg, 'pev2-cfg-title')), 'QBuddy settings')

/* ---------------- 预设加载失败与重试 ---------------- */
console.log('预设加载失败')
let settingsFail = true
store.draft = '加载失败'
tree = await mountReady(async () => {
  if (settingsFail) throw new TypeError('Failed to fetch')
  return settingsResponse()
})
check('加载失败时左段仍可用', mainButton(tree) !== null)
check(
  '加载失败时标题包含重试提示',
  caretButton(tree).props.title.includes('Failed to load presets') &&
    caretButton(tree).props.title.includes('click to retry'),
  caretButton(tree).props.title,
)
eq('加载失败时右段可点击重试', caretButton(tree).props.disabled, false)
check('加载失败时不显示档名', labelOf(tree) === null)
await mainButton(tree).props.onClick()
eq('未知当前档时省略 preset', 'preset' in enhanceCalls[0], false)

settingsFail = false
caretButton(tree).props.onClick()
tree = render()
await settle()
tree = render()
tree = render()
eq('重试后拉到 settings', settingsFetchCount, 2)
eq('重试后显示当前档', textOfNode(labelOf(tree)), 'QBuddy')

/* ---------------- 只读宿主 ---------------- */
console.log('只读宿主')
tree = await mountReady(async () => settingsResponse(settingsData({ canWrite: false })))
eq('canWrite=false 时右段禁用', caretButton(tree).props.disabled, true)
check('只读原因写在 title', caretButton(tree).props.title.includes('cannot persist config'), caretButton(tree).props.title)

/* ---------------- 无写入能力 ---------------- */
console.log('无写入能力')
tree = await mountReady()
props = makeProps({ inputActions: {} })
tree = render()
tree = render()
eq('没有 setDraft 时左段禁用', mainButton(tree).props.disabled, true)
await mainButton(tree).props.onClick()
eq('禁用时点击不发增强请求', enhanceCalls.length, 0)
props = makeProps()

/* ---------------- 兜底文案 ---------------- */
console.log('兜底')
store.draft = '兜底'
tree = await mountReady()
props = makeProps({ t: undefined })
tree = render()
tree = render()
check(
  '没有 t 也有可读标题',
  typeof mainButton(tree).props.title === 'string' && mainButton(tree).props.title.includes('增强提示词'),
  mainButton(tree).props.title,
)
props = makeProps()

/* ---------------- 候选下拉（provider / model） ---------------- */
console.log('候选下拉')
const withCandidates = {
  providers: async () =>
    jsonResponse({
      ok: true,
      data: {
        providers: [
          { id: 'vendor-a', name: 'Vendor A' },
          { id: 'vendor-b', name: 'Vendor B' },
        ],
      },
    }),
  models: async (url) => {
    const provider = url.includes('provider=vendor-b') ? 'vendor-b' : 'vendor-a'
    const models =
      provider === 'vendor-b'
        ? [{ id: 'solo', name: 'Solo' }]
        : [
            { id: 'fast', name: 'Fast' },
            { id: 'pro', name: 'Pro' },
          ]
    return jsonResponse({ ok: true, data: { provider, models } })
  },
}

const tt = fakeCtx.locale.bind()
let cfgTree = await mountConfig(null, withCandidates)
eq('有候选时 provider 渲染成下拉', selectsOf(cfgTree).length, 2)
const providerSelect = selectsOf(cfgTree)[0]
eq('provider 首项是跟随默认模型', textOfNode(optionsOf(providerSelect)[0]), tt('config.providerFollow'))
eq('provider 候选逐条列出', optionsOf(providerSelect).length, 3)
eq('provider 候选显示名字', textOfNode(optionsOf(providerSelect)[1]), 'Vendor A')
eq('未选 provider 时 model 下拉禁用', selectsOf(cfgTree)[1].props.disabled, true)

providerSelect.props.onChange({ target: { value: 'vendor-a' } })
cfgTree = renderConfig()
await settle()
cfgTree = renderConfig()
eq(
  '选 provider 后按 provider 取模型',
  fetchCalls.some((call) => call.url === MODELS_ROUTE + '?provider=vendor-a'),
  true,
)
const modelSelect = selectsOf(cfgTree)[1]
eq('model 变成可选下拉', modelSelect.props.disabled, false)
eq('model 首项是提示选择', textOfNode(optionsOf(modelSelect)[0]), tt('config.modelPick'))
eq('model 候选来自该 provider', textOfNode(optionsOf(modelSelect)[1]), 'Fast')
eq('选了 provider 没选 model 时拦住保存', buttonByText(cfgTree, tt('config.save')).props.disabled, true)

modelSelect.props.onChange({ target: { value: 'pro' } })
cfgTree = renderConfig()
eq('选完 model 才能保存', buttonByText(cfgTree, tt('config.save')).props.disabled, false)

/* 换 provider 会清掉旧 model，避免 provider/model 跨路由错配 */
selectsOf(cfgTree)[0].props.onChange({ target: { value: 'vendor-b' } })
cfgTree = renderConfig()
await settle()
cfgTree = renderConfig()
eq('换 provider 后旧 model 被清空', selectsOf(cfgTree)[1].props.value, '')
eq('换 provider 后 model 候选跟着换', textOfNode(optionsOf(selectsOf(cfgTree)[1])[1]), 'Solo')
eq('换 provider 后重新取模型', fetchCalls.some((call) => call.url === MODELS_ROUTE + '?provider=vendor-b'), true)

/* 候选拿不到就退回手动填写，不把用户锁死 */
let cfgFallback = await mountConfig(null, {
  providers: async () => jsonResponse({ ok: true, data: { providers: [] } }),
})
eq('没有候选时退回输入框', selectsOf(cfgFallback).length, 0)
eq('没有候选时说明原因', textOfNode(cfgFallback).includes(tt('config.candidatesFailed')), true)

cfgFallback = await mountConfig(null, {
  providers: async () => errResponse(500, 'BOOM', '炸了'),
})
eq('候选接口失败时也退回输入框', selectsOf(cfgFallback).length, 0)

/* ---------------- 思考强度（配置页） ---------------- */
console.log('思考强度')
const withEfforts = {
  ...withCandidates,
  modelInfo: async (url) => {
    const params = new URL(url, 'http://x').searchParams
    const model = params.get('model')
    if (model !== 'pro') {
      return jsonResponse({
        ok: true,
        data: { provider: params.get('provider'), model, reasoning: null },
      })
    }
    return jsonResponse({
      ok: true,
      data: {
        provider: params.get('provider'),
        model,
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'low',
        },
      },
    })
  },
}

/** 配置页的候选是链式请求：多跑几轮 render + settle 让 effect 收敛。 */
async function settleConfig(times = 3) {
  let tree = renderConfig()
  for (let i = 0; i < times; i += 1) {
    await settle()
    tree = renderConfig()
  }
  return tree
}

let effortTree = await mountConfig(null, withEfforts)
eq('没选模型时不出强度栏', selectsOf(effortTree).length, 2)
selectsOf(effortTree)[0].props.onChange({ target: { value: 'vendor-a' } })
effortTree = await settleConfig()
selectsOf(effortTree)[1].props.onChange({ target: { value: 'pro' } })
effortTree = await settleConfig()
eq('模型报了强度就多一栏', selectsOf(effortTree).length, 3)
eq(
  '按 provider+model 查强度',
  modelInfoCalls.some((url) => url.includes('provider=vendor-a') && url.includes('model=pro')),
  true,
)
const effortSelect = selectsOf(effortTree)[2]
eq('强度首项是默认', textOfNode(optionsOf(effortSelect)[0]), tt('config.effortDefault'))
eq('强度候选逐条列出', optionsOf(effortSelect).length, 3)
eq('强度候选显示名字', textOfNode(optionsOf(effortSelect)[1]), 'Low')
eq('默认不预选强度', effortSelect.props.value, '')

effortSelect.props.onChange({ target: { value: 'high' } })
effortTree = renderConfig()
eq('选完强度回填', selectsOf(effortTree)[2].props.value, 'high')
buttonByText(effortTree, tt('config.save')).props.onClick()
await settle()
eq('保存时带上强度', saveCalls.at(-1).config.reasoningEffort, 'high')
eq('保存时仍带 provider', saveCalls.at(-1).config.provider, 'vendor-a')
eq('保存时仍带 model', saveCalls.at(-1).config.model, 'pro')

/* 换模型会清掉强度：上一档的强度未必存在于新模型 */
effortTree = await mountConfig(async () =>
  settingsResponse(
    settingsData({
      config: { provider: 'vendor-a', model: 'pro', reasoningEffort: 'high', timeoutMs: 30000 },
    }),
  ),
  withEfforts,
)
effortTree = await settleConfig()
eq('已存的强度回填', selectsOf(effortTree)[2].props.value, 'high')
selectsOf(effortTree)[1].props.onChange({ target: { value: 'fast' } })
effortTree = await settleConfig()
eq('换到没有强度的模型后这一栏消失', selectsOf(effortTree).length, 2)
buttonByText(effortTree, tt('config.save')).props.onClick()
await settle()
eq('换模型后强度被清空', saveCalls.at(-1).config.reasoningEffort, '')

/* 查不到强度就当作没有这一档，不挡住保存 */
let effortNone = await mountConfig(async () =>
  settingsResponse(
    settingsData({ config: { provider: 'vendor-a', model: 'pro', timeoutMs: 30000 } }),
  ),
  { ...withCandidates, modelInfo: async () => jsonResponse({ ok: true, data: { reasoning: null } }) },
)
effortNone = await settleConfig()
eq('模型没有强度时不渲染这一栏', selectsOf(effortNone).length, 2)
effortNone = await mountConfig(async () =>
  settingsResponse(
    settingsData({ config: { provider: 'vendor-a', model: 'pro', timeoutMs: 30000 } }),
  ),
  { ...withCandidates, modelInfo: async () => errResponse(500, 'BOOM', '炸了') },
)
effortNone = await settleConfig()
eq('强度接口失败时不渲染这一栏', selectsOf(effortNone).length, 2)
eq('强度接口失败仍能保存', buttonByText(effortNone, tt('config.save')).props.disabled, false)

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
