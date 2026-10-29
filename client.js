/**
 * QBuddy · Client 半。
 *
 * 两个插槽：
 *   1. `conversation.input.right`：split button。
 *      - 左段图标 + 当前档名：点一下 -> POST /prompt-enhance-v2/enhance
 *        { preset, draft } -> 草稿没变就 setDraft(结果) + persistDraft()；
 *      - 右段 ▾：菜单上半部切预设（四档内置 + 自己建的自定义预设，
 *        没建过就不出现自定义项），下半部是提示词模型与思考强度快速切换；
 *      - 草稿为空：整个按钮不渲染；运行中仍可切档，只影响下一次调用。
 *   2. `plugins.bundle.config`（key = 包名）：插件详情页里的配置面板。
 *      管 provider / model / 超时，以及自定义预设的增删改（想建几个建几个）。
 *
 * 并发保护：发起时记下草稿与 draftRev。结果回来时草稿已变 -> 不写回，
 * 结果暂存成「应用」态，用户点了才覆盖；草稿被清空 -> 丢弃结果。
 *
 * 草稿读写只走公开通道：useInput(s => s.draft) / useInput(s => s.draftRev)
 * / inputActions.setDraft。菜单里的模型快切只写插件自己的 provider / model
 * （宿主 /providers 与 /models 候选路由），既不 require 任何 @deepseek-ai/*
 * 包，也不碰会话正在使用的模型。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qbuddy-prompt-enhance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-enhance-v2'
    const PKG_NAME = 'dsh-qbuddy-prompt-enhance'
    const ENHANCE_ROUTE = '/prompt-enhance-v2/enhance'
    const SETTINGS_ROUTE = '/prompt-enhance-v2/settings'
    const PROVIDERS_ROUTE = '/prompt-enhance-v2/providers'
    const MODELS_ROUTE = '/prompt-enhance-v2/models'
    const MODEL_INFO_ROUTE = '/prompt-enhance-v2/model-info'
    /** 详情页存完配置后通知输入框按钮重新拉一次 settings（同窗口内）。 */
    const SETTINGS_EVENT = 'qbuddy:settings-changed'
    const DRAFT_TOKEN = '{{draft}}'
    const MAX_NAME_CHARS = 40
    const MAX_TEMPLATE_CHARS = 8000
    // 刚发起的一瞬间（手抖 / 双击）再点不算取消，避免刚点就跑的请求被自己掐掉。
    const CANCEL_GRACE_MS = 350
    /**
     * 按钮最小宽度的基准档：默认档（与 presets.js 的 DEFAULT_PRESET_ID 一致）。
     * 计时数字、比它更短的档名都不许把按钮压得更窄——压窄后数字会被裁掉。
     * 客户端拿不到 presets.js 的常量（它只从宿主 /settings 拿预设），这里镜像一份。
     */
    const DEFAULT_PRESET_ID = 'qbuddy'
    const LABEL_MAX_PX = 110

    const DICT = {
      zh: {
        'meta.title': 'dsh-qbuddy-prompt-enhance',
        'meta.description':
          'QBuddy：把输入框草稿一键改写成更清晰、更可执行的提示词。四档内置预设 + 任意多个自定义预设；菜单里还能快速切换插件自己用的模型。',
        'button.title': 'QBuddy 增强提示词',
        'button.titleWithPreset': 'QBuddy 增强提示词（当前：{preset}）',
        'button.cancelTitle': '增强中，再点一次取消',
        'button.elapsed': '{n}s',
        'button.apply': '应用',
        'button.applyTitle': '应用增强结果（会覆盖当前草稿）',
        'button.applyTitleWithPreset': '应用 {preset} 的增强结果（会覆盖当前草稿）',
        'menu.title': '选择预设档位',
        'menu.loading': '正在加载预设…',
        'menu.loadError': '预设加载失败，增强仍会用默认档',
        'menu.retry': '点击重试',
        'menu.readOnly': '当前宿主无法写入配置，预设切换不可用',
        'menu.current': '当前档',
        'menu.model': '提示词模型',
        'menu.modelUnavailable': '列不出可选模型，去插件详情页手动填写',
        'menu.modelLoading': '正在加载模型…',
        'menu.modelsTitle': '选择提示词模型',
        'menu.modelFollow': '跟随默认模型',
        'menu.back': '返回',
        'menu.noModels': '没有可用的模型',
        'menu.modelFailed': '保存提示词模型失败：{message}',
        'menu.modelFailedGeneric': '保存提示词模型失败',
        'menu.effortsTitle': '选择思考强度',
        'menu.effortDefault': '默认',
        'menu.effortLoading': '正在读取可选强度…',
        'menu.effortNone': '这个模型没有可选强度',
        'config.title': 'QBuddy 配置',
        'config.hint': '改完点「保存」，立即生效，不需要重启。',
        'config.modelSection': '模型与超时',
        'config.provider': 'Provider',
        'config.model': 'Model',
        'config.modelHint': '两项都留空 = 跟随当前默认模型；只填一项不会生效。',
        'config.providerFollow': '跟随默认模型',
        'config.modelFollow': '跟随默认模型',
        'config.modelPick': '请选择模型',
        'config.modelRequired': '选了 Provider 还要选 Model，否则会跟随默认模型。',
        'config.providerHint': '候选来自当前 profile 已注册的模型路由。',
        'config.modelLoading': '正在加载模型…',
        'config.reasoningEffort': '思考强度',
        'config.effortDefault': '默认',
        'config.effortLoading': '正在读取…',
        'config.effortHint': '只有支持思考强度的模型才有这一栏；默认 = 用模型自己的默认档。',
        'config.modelManual': '该路由没有自报模型列表，请手动填写。',
        'config.candidatesFailed': '读不到候选列表，已退回手动填写。',
        'config.timeout': '超时（秒）',
        'config.timeoutHint': '允许 0.1–600 秒，默认 30 秒。',
        'config.builtinSection': '内置预案（只读）',
        'config.builtinHint': '内置四档由插件提供，不能改；想换文本就新建自定义预设。',
        'config.customSection': '自定义预设',
        'config.customHint': '想建几个就建几个，保存后会出现在输入框右侧的档位菜单里。',
        'config.empty': '还没有自定义预设。',
        'config.newPreset': '新建自定义预设',
        'config.newPresetName': '自定义 {n}',
        'config.name': '名称',
        'config.namePlaceholder': '例如：我的风格',
        'config.system': 'System 模板',
        'config.user': 'User 模板',
        'config.userHint': '必须包含 {{draft}}，增强时会替换成输入框里的草稿。',
        'config.resetTemplates': '填入起步模板',
        'config.delete': '删除',
        'config.save': '保存',
        'config.saving': '保存中…',
        'config.saved': '已保存',
        'config.loading': '正在加载配置…',
        'config.loadFailed': '配置加载失败',
        'config.retry': '重试',
        'config.readOnly': '当前宿主无法写入配置，只能查看。',
        'config.nameRequired': '名称不能为空',
        'config.nameTooLong': '名称最长 40 字符',
        'config.systemRequired': 'System 模板不能为空',
        'config.draftRequired': 'User 模板必须包含 {{draft}}',
        'config.tooLong': '模板最长 8000 字符',
        'config.timeoutInvalid': '超时请填 0.1–600 秒',
        'config.providerTooLong': 'Provider / Model 最长 200 字符',
        'config.saveFailed': '保存失败：{message}',
        'error.empty': '先写点内容再增强',
        'error.emptyResult': '模型返回了空结果，草稿未改动',
        'error.truncated': '模型输出被截断，草稿未改动，请重试',
        'error.customEmpty': '自定义预设还没配置，先到插件详情页填写模板',
        'error.timeout': '增强超时，请重试',
        'error.network': '增强失败：网络错误',
        'error.disabled': '提示词增强已在插件配置里关闭',
        'error.noModel': '没有可用的模型，请先配置 provider/model',
        'error.noTarget': '无法确定模型，请先设置默认模型',
        'error.unknownPreset': '未知预设',
        'error.template': '预设模板缺少草稿占位符',
        'error.llm': '模型调用失败，草稿未改动',
        'error.unknown': '增强失败，草稿未改动',
        'error.failed': '增强失败：{message}',
        'error.noEditor': '当前宿主无法写入配置，预设切换不可用',
        'error.noEntry': '找不到插件配置条目，预设切换不可用',
        'error.writeFailed': '写入配置失败',
        'error.switchNetwork': '切换失败：网络错误',
        'error.switchFailed': '切换失败：{message}',
        'error.switchFailedGeneric': '切换失败，草稿未受影响',
      },
      en: {
        'meta.title': 'dsh-qbuddy-prompt-enhance',
        'meta.description':
          'QBuddy rewrites the composer draft into a clearer, more executable prompt. Four built-in presets, any number of custom presets, plus a quick switch of the model it uses itself.',
        'button.title': 'QBuddy enhance prompt',
        'button.titleWithPreset': 'QBuddy enhance prompt (current: {preset})',
        'button.cancelTitle': 'Enhancing; click again to cancel',
        'button.elapsed': '{n}s',
        'button.apply': 'Apply',
        'button.applyTitle': 'Apply the enhancement result (overwrites the current draft)',
        'button.applyTitleWithPreset': 'Apply the {preset} result (overwrites the current draft)',
        'menu.title': 'Choose preset',
        'menu.loading': 'Loading presets…',
        'menu.loadError': 'Failed to load presets; enhancement still uses the default',
        'menu.retry': 'click to retry',
        'menu.readOnly': 'This host cannot persist config; preset switching is unavailable',
        'menu.current': 'Current',
        'menu.model': 'Prompt model',
        'menu.modelUnavailable': 'No model list available; set it on the plugin page',
        'menu.modelLoading': 'Loading models…',
        'menu.modelsTitle': 'Choose prompt model',
        'menu.modelFollow': 'Follow the default model',
        'menu.back': 'Back',
        'menu.noModels': 'No models available',
        'menu.modelFailed': 'Saving the prompt model failed: {message}',
        'menu.modelFailedGeneric': 'Saving the prompt model failed',
        'menu.effortsTitle': 'Choose reasoning effort',
        'menu.effortDefault': 'Default',
        'menu.effortLoading': 'Loading reasoning efforts…',
        'menu.effortNone': 'This model has no reasoning effort options',
        'config.title': 'QBuddy settings',
        'config.hint': 'Click Save to apply; no restart needed.',
        'config.modelSection': 'Model & timeout',
        'config.provider': 'Provider',
        'config.model': 'Model',
        'config.modelHint': 'Leave both empty to follow the current default; filling only one has no effect.',
        'config.providerFollow': 'Follow the default model',
        'config.modelFollow': 'Follow the default model',
        'config.modelPick': 'Choose a model',
        'config.modelRequired': 'A provider also needs a model, otherwise the default model is used.',
        'config.providerHint': 'Candidates come from the model routes registered in this profile.',
        'config.modelLoading': 'Loading models…',
        'config.reasoningEffort': 'Reasoning effort',
        'config.effortDefault': 'Default',
        'config.effortLoading': 'Reading…',
        'config.effortHint': 'Only models that support reasoning show this field; Default uses the model’s own default effort.',
        'config.modelManual': 'This route reports no model list; fill it in manually.',
        'config.candidatesFailed': 'Could not read the candidates; manual input is used instead.',
        'config.timeout': 'Timeout (seconds)',
        'config.timeoutHint': '0.1–600 seconds; default 30.',
        'config.builtinSection': 'Built-in presets (read-only)',
        'config.builtinHint': 'The four built-ins are provided by the plugin and cannot be edited; create a custom preset to change the text.',
        'config.customSection': 'Custom presets',
        'config.customHint': 'Create as many as you like; saved presets appear in the composer preset menu.',
        'config.empty': 'No custom presets yet.',
        'config.newPreset': 'New custom preset',
        'config.newPresetName': 'Custom {n}',
        'config.name': 'Name',
        'config.namePlaceholder': 'e.g. My style',
        'config.system': 'System template',
        'config.user': 'User template',
        'config.userHint': 'Must contain {{draft}}; it is replaced with your draft.',
        'config.resetTemplates': 'Fill starter templates',
        'config.delete': 'Delete',
        'config.save': 'Save',
        'config.saving': 'Saving…',
        'config.saved': 'Saved',
        'config.loading': 'Loading settings…',
        'config.loadFailed': 'Failed to load settings',
        'config.retry': 'Retry',
        'config.readOnly': 'This host cannot persist config; values are read-only.',
        'config.nameRequired': 'Name is required',
        'config.nameTooLong': 'Name must be at most 40 characters',
        'config.systemRequired': 'System template cannot be empty',
        'config.draftRequired': 'User template must contain {{draft}}',
        'config.tooLong': 'Templates are limited to 8000 characters',
        'config.timeoutInvalid': 'Timeout must be 0.1–600 seconds',
        'config.providerTooLong': 'Provider / model must be at most 200 characters',
        'config.saveFailed': 'Save failed: {message}',
        'error.empty': 'Write something first',
        'error.emptyResult': 'The model returned nothing; the draft was left untouched',
        'error.truncated': 'The model output was truncated; the draft was left untouched, try again',
        'error.customEmpty': 'The custom preset is not configured yet; fill it in on the plugin page',
        'error.timeout': 'Enhancement timed out, try again',
        'error.network': 'Enhancement failed: network error',
        'error.disabled': 'Prompt enhancement is disabled in the plugin config',
        'error.noModel': 'No model available; configure provider/model first',
        'error.noTarget': 'Could not resolve a model; set a default model first',
        'error.unknownPreset': 'Unknown preset',
        'error.template': 'The preset template is missing the draft placeholder',
        'error.llm': 'The model call failed; the draft was left untouched',
        'error.unknown': 'Enhancement failed; the draft was left untouched',
        'error.failed': 'Enhancement failed: {message}',
        'error.noEditor': 'This host cannot persist config; preset switching is unavailable',
        'error.noEntry': 'The plugin config entry is missing; preset switching is unavailable',
        'error.writeFailed': 'Failed to write config',
        'error.switchNetwork': 'Switch failed: network error',
        'error.switchFailed': 'Switch failed: {message}',
        'error.switchFailedGeneric': 'Switch failed; the draft was not affected',
      },
    }

    const CSS = [
      '.pev2-split{position:relative;display:inline-flex;align-items:center;height:28px;border-radius:999px;',
      'background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary)}',
      '.pev2-main{height:28px;display:inline-flex;align-items:center;gap:6px;padding:0 8px 0 9px;border:none;',
      'background:transparent;color:inherit;cursor:pointer;border-radius:999px 0 0 999px;font-size:12px;',
      'line-height:1;font-family:inherit;transition:background .15s ease}',
      '.pev2-main:disabled{opacity:.45;cursor:default}',
      '.pev2-main svg .pev2-orb{transform-box:fill-box;transform-origin:center}',
      '.pev2-main[data-busy="true"] svg .pev2-orb{animation:pev2-breathe 1.15s ease-in-out infinite}',
      '.pev2-main[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.pev2-main[data-overdue="true"]{color:var(--dsw-alias-state-warning-primary)}',
      '.pev2-main[data-staged="true"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.pev2-label{display:inline-block;flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;transition:width .18s ease}',
      '.pev2-measure{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;',
      'font-size:12px;line-height:1}',
      '.pev2-caret{height:28px;width:22px;display:grid;place-items:center;border:none;border-left:1px solid var(--dsw-alias-border-l2);',
      'background:transparent;color:inherit;cursor:pointer;border-radius:0 999px 999px 0;padding:0;',
      'transition:background .15s ease}',
      '.pev2-main:hover:not(:disabled),.pev2-caret:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pev2-caret:disabled{opacity:.45;cursor:default}',
      '.pev2-menu{position:absolute;bottom:calc(100% + 8px);right:0;width:236px;max-width:calc(100vw - 24px);',
      'box-sizing:border-box;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px rgba(0,0,0,.18);z-index:30}',
      '.pev2-menu-head{padding:4px 8px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pev2-menu-scroll{max-height:248px;overflow:auto;overscroll-behavior:contain}',
      '.pev2-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'padding:7px 8px;border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;',
      'font-size:12px;line-height:1.2;font-family:inherit;text-align:left}',
      '.pev2-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pev2-item:disabled{opacity:.6;cursor:default}',
      '.pev2-item[data-current="true"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.pev2-item-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pev2-item-mark{width:1em;text-align:center;flex:none}',
      '.pev2-divider{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l2)}',
      '.pev2-model-row{width:100%;display:flex;align-items:center;gap:8px;padding:7px 8px;border:none;',
      'border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1.2;',
      'font-family:inherit;text-align:left}',
      '.pev2-model-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pev2-model-row:disabled{opacity:.55;cursor:default}',
      '.pev2-model-row-label{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.pev2-model-row-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
      '.pev2-model-row svg{flex:none;opacity:.7}',
      '.pev2-menu-nav{display:flex;align-items:center;gap:6px;padding:2px 2px 6px}',
      '.pev2-back{display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 6px;border:none;',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font:inherit;font-size:11px}',
      '.pev2-back:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:inherit}',
      '.pev2-menu-nav-title{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pev2-menu-empty{padding:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pev2-menu-error{padding:6px 8px 2px;font-size:11px;color:var(--dsw-alias-state-error-primary)}',
      '@keyframes pev2-breathe{0%,to{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.68}}',
      '@media (prefers-reduced-motion:reduce){.pev2-main[data-busy="true"] svg .pev2-orb{animation:none}',
      '.pev2-label{transition:none}}',
      /* -------- 插件详情页配置面板 -------- */
      '.pev2-cfg{display:flex;flex-direction:column;gap:14px;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.pev2-cfg-head{display:flex;flex-direction:column;gap:4px}',
      '.pev2-cfg-title{margin:0;font-size:13px;font-weight:600}',
      '.pev2-cfg-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pev2-cfg-section{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.pev2-cfg-section-title{font-size:12px;font-weight:600}',
      '.pev2-cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}',
      '.pev2-cfg-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.pev2-cfg-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pev2-cfg .pev2-input,.pev2-cfg .pev2-textarea{width:100%;box-sizing:border-box;padding:6px 8px;',
      'border-radius:7px;font:inherit;font-size:12px;background:var(--dsw-specific-selector);',
      'color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);resize:vertical}',
      '.pev2-cfg .pev2-input:focus,.pev2-cfg .pev2-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary)}',
      '.pev2-cfg .pev2-select{cursor:pointer;text-overflow:ellipsis}',
      '.pev2-cfg .pev2-select:disabled{cursor:default;opacity:.6}',
      '.pev2-cfg-builtins{display:flex;flex-direction:column;gap:6px}',
      '.pev2-cfg-builtin{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:8px;',
      'background:var(--dsw-specific-selector)}',
      '.pev2-cfg-builtin-name{font-size:12px;font-weight:600}',
      '.pev2-cfg-builtin-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}',
      '.pev2-cfg-preset{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;',
      'border:1px dashed var(--dsw-alias-border-l2)}',
      '.pev2-cfg-preset-head{display:flex;align-items:flex-end;gap:8px}',
      '.pev2-cfg-preset-head .pev2-cfg-field{flex:1}',
      '.pev2-cfg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pev2-cfg-btn{height:26px;padding:0 12px;border-radius:999px;font:inherit;font-size:12px;cursor:pointer}',
      '.pev2-cfg-primary{border:none;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.pev2-cfg-primary:disabled{opacity:.45;cursor:default}',
      '.pev2-cfg-secondary{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}',
      '.pev2-cfg-secondary:disabled{opacity:.45;cursor:default}',
      '.pev2-cfg-danger{border:none;background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer;',
      'font:inherit;font-size:11px;padding:0 4px 2px}',
      '.pev2-cfg-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}',
      '.pev2-cfg-ok{font-size:11px;color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    /** 语言包没就绪时的兜底：始终回中文文案，保证 title 可读。 */
    const fallbackText = (key) => DICT.zh[key] ?? key

    /** 服务端错误码 -> 本地化 key；未收录的码退回 error.failed + 原始 message。 */
    const ERROR_KEYS = {
      EMPTY_DRAFT: 'error.empty',
      UNKNOWN_PRESET: 'error.unknownPreset',
      BAD_TEMPLATE: 'error.template',
      DISABLED: 'error.disabled',
      NO_LLM: 'error.noModel',
      NO_TARGET: 'error.noTarget',
      MODEL_UNAVAILABLE: 'error.noModel',
      TIMEOUT: 'error.timeout',
      EMPTY_RESULT: 'error.emptyResult',
      OUTPUT_TRUNCATED: 'error.truncated',
      CUSTOM_EMPTY: 'error.customEmpty',
      LLM_ERROR: 'error.llm',
      NETWORK: 'error.network',
      BAD_RESPONSE: 'error.network',
      FORBIDDEN: 'error.network',
    }

    const SWITCH_ERROR_KEYS = {
      NO_EDITOR: 'error.noEditor',
      NO_ENTRY: 'error.noEntry',
      WRITE_FAILED: 'error.writeFailed',
      UNKNOWN_PRESET: 'error.unknownPreset',
      CUSTOM_EMPTY: 'error.customEmpty',
      NETWORK: 'error.switchNetwork',
      BAD_RESPONSE: 'error.switchNetwork',
    }

    class PluginError extends Error {
      constructor(code, message) {
        super(message || code)
        this.name = 'PluginError'
        this.code = code
      }
    }

    function textOf(t, key) {
      const value = t(key)
      if (typeof value === 'string' && value !== '' && value !== key) return value
      return fallbackText(key)
    }

    function toProblem(error) {
      if (error instanceof PluginError) return { code: error.code, message: error.message }
      return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
    }

    function problemText(t, problem) {
      const key = ERROR_KEYS[problem.code]
      if (key !== undefined) return textOf(t, key)
      const template = textOf(t, 'error.failed')
      return problem.message ? template.replace('{message}', problem.message) : textOf(t, 'error.unknown')
    }

    function switchProblemText(t, problem) {
      const key = SWITCH_ERROR_KEYS[problem.code]
      if (key !== undefined) return textOf(t, key)
      const template = textOf(t, 'error.switchFailed')
      return problem.message ? template.replace('{message}', problem.message) : textOf(t, 'error.switchFailedGeneric')
    }

    function menuProblemText(t, problem) {
      if (problem.code === 'MODEL_UNAVAILABLE') return textOf(t, 'menu.modelUnavailable')
      if (problem.code === 'MODEL_FAILED') {
        const template = textOf(t, 'menu.modelFailed')
        return problem.message ? template.replace('{message}', problem.message) : textOf(t, 'menu.modelFailedGeneric')
      }
      return switchProblemText(t, problem)
    }

    async function requestJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        // 用户点了取消：走单独的码，调用方静默回到 idle，不报错。
        if (error && error.name === 'AbortError') throw new PluginError('CANCELLED', '')
        throw new PluginError('NETWORK', '')
      }

      const raw = await response.text()
      let payload = null
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new PluginError('BAD_RESPONSE', raw.slice(0, 200) || 'HTTP ' + response.status)
      }

      if (!response.ok || !payload || payload.ok === false) {
        const info = payload && payload.error ? payload.error : {}
        const code = typeof info.code === 'string' && info.code !== '' ? info.code : 'HTTP_' + response.status
        const message = typeof info.message === 'string' ? info.message : 'HTTP ' + response.status
        throw new PluginError(code, message)
      }
      return payload.data
    }

    async function fetchSettings() {
      const data = await requestJson(SETTINGS_ROUTE, { headers: { accept: 'application/json' } })
      if (!data || typeof data.current !== 'string' || !Array.isArray(data.presets) || data.presets.length === 0) {
        throw new PluginError('BAD_RESPONSE', 'settings shape')
      }
      return data
    }

    /** 配置页 provider 下拉候选；列不出来就返回空数组，让表单退回手动填写。 */
    async function fetchProviders() {
      const data = await requestJson(PROVIDERS_ROUTE, { headers: { accept: 'application/json' } })
      if (!data || !Array.isArray(data.providers)) return []
      return data.providers
        .filter((item) => item && typeof item.id === 'string' && item.id !== '')
        .map((item) => ({
          id: item.id,
          name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
        }))
    }

    /** 某个 provider 下适配器自报的模型，供 model 下拉候选。 */
    async function fetchModels(provider) {
      const data = await requestJson(MODELS_ROUTE + '?provider=' + encodeURIComponent(provider), {
        headers: { accept: 'application/json' },
      })
      if (!data || !Array.isArray(data.models)) return []
      return data.models
        .filter((item) => item && typeof item.id === 'string' && item.id !== '')
        .map((item) => ({
          id: item.id,
          name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
        }))
    }

    /**
     * 某个 provider/model 的思考强度候选。适配器没报 reasoning 就回 null：
     * 这种模型没有强度可切，配置页直接把这一栏藏起来。
     */
    async function fetchModelInfo(provider, model) {
      const query =
        '?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model)
      const data = await requestJson(MODEL_INFO_ROUTE + query, {
        headers: { accept: 'application/json' },
      })
      const reasoning = data && data.reasoning && typeof data.reasoning === 'object' ? data.reasoning : null
      if (reasoning === null) return null
      const efforts = Array.isArray(reasoning.efforts)
        ? reasoning.efforts
            .filter((item) => item && typeof item.id === 'string' && item.id !== '')
            .map((item) => ({
              id: item.id,
              name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
            }))
        : []
      return {
        efforts,
        defaultEffort: typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '',
      }
    }

    /** PUT settings：切档、存自定义预设、存模型/超时都走这一条。 */
    async function putSettings(body) {
      return requestJson(SETTINGS_ROUTE, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    }

    async function savePreset(presetId) {
      const data = await putSettings({ preset: presetId })
      if (!data || typeof data.current !== 'string') throw new PluginError('BAD_RESPONSE', 'settings shape')
      return data
    }

    /** 预设未知时省略 preset 字段，让宿主按自己的配置取默认档。 */
    async function callEnhance(draft, presetId, signal) {
      const body = { draft }
      if (typeof presetId === 'string' && presetId !== '') body.preset = presetId

      const data = await requestJson(ENHANCE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      })

      const text = data && data.text
      if (typeof text !== 'string' || text.trim() === '') throw new PluginError('EMPTY_RESULT', '')
      return text
    }

    function isEnglishUi() {
      const lang = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : ''
      return typeof lang === 'string' && lang.trim().toLowerCase().startsWith('en')
    }

    function localizedText(value) {
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') {
        const preferred = isEnglishUi() ? value.en : value.zh
        const fallback = isEnglishUi() ? value.zh : value.en
        if (typeof preferred === 'string' && preferred !== '') return preferred
        if (typeof fallback === 'string' && fallback !== '') return fallback
      }
      return ''
    }

    function presetLabel(preset) {
      if (preset === null || typeof preset !== 'object') return ''
      const label = localizedText(preset.label)
      return label !== '' ? label : typeof preset.id === 'string' ? preset.id : ''
    }

    function presetDescription(preset) {
      return preset !== null && typeof preset === 'object' ? localizedText(preset.description) : ''
    }

    function notifySettingsChanged() {
      try {
        if (
          typeof window !== 'undefined' &&
          typeof window.dispatchEvent === 'function' &&
          typeof Event === 'function'
        ) {
          window.dispatchEvent(new Event(SETTINGS_EVENT))
        }
      } catch {
        // 通知只是顺手刷新另一个面板；失败不影响已经保存好的配置。
      }
    }

    /** 新版自定义预设 id：custom-<时间戳><随机>，只含小写字母数字。 */
    function newPresetId() {
      const stamp = Date.now().toString(36)
      const salt = Math.random().toString(36).slice(2, 6)
      return ('custom-' + stamp + salt).slice(0, 39)
    }

    /** 原子轨道标记：两条交叉椭圆 + 中心点；空闲静止，思考时整组呼吸收缩。 */
    function QBuddyIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h(
          'g',
          { className: 'pev2-orb' },
          h('ellipse', { cx: 12, cy: 12, rx: 9.4, ry: 4.1, transform: 'rotate(45 12 12)' }),
          h('ellipse', { cx: 12, cy: 12, rx: 9.4, ry: 4.1, transform: 'rotate(-45 12 12)' }),
          h('circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor', stroke: 'none' }),
        ),
      )
    }

    function CheckIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M5 12.5l4.2 4.2L19 7.2' }),
      )
    }

    function ChevronIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M6 9l6 6 6-6' }),
      )
    }

    function ChevronRightIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M9 6l6 6-6 6' }),
      )
    }

    function ArrowLeftIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M15 6l-6 6 6 6' }),
      )
    }

    /** 强度候选表的 key：用不可见分隔符拼，id 里带斜杠也不会撞车。 */
    function infoKeyOf(provider, model) {
      return String(provider) + '\u0000' + String(model)
    }

    /** provider / model 的可读名：拿不到候选就退回裸 id。 */
    function modelNameOf(provider, model, providers, modelsMap) {
      const providerEntry = Array.isArray(providers)
        ? providers.find((entry) => entry && entry.id === provider)
        : null
      const providerName = providerEntry ? providerEntry.name : provider
      const bucket = modelsMap ? modelsMap[provider] : null
      const models = bucket && Array.isArray(bucket.list) ? bucket.list : []
      const modelEntry = models.find((entry) => entry && entry.id === model)
      const modelName = modelEntry ? modelEntry.name : model
      return modelName === '' ? providerName : providerName + ' / ' + modelName
    }

    /**
     * 菜单里那一行显示什么：插件自己的 provider / model，选了强度就再挂一段。
     * provider 为空表示跟随会话默认模型，此时不显示任何名字。
     */
    function modelSummaryOf(settings, providers, modelsMap, infosMap) {
      if (settings === null || !settings.config) return ''
      const provider = typeof settings.config.provider === 'string' ? settings.config.provider : ''
      const model = typeof settings.config.model === 'string' ? settings.config.model : ''
      if (provider === '') return ''
      const base = modelNameOf(provider, model, providers, modelsMap)
      const effort =
        typeof settings.config.reasoningEffort === 'string' ? settings.config.reasoningEffort : ''
      if (effort === '') return base
      const info = infosMap ? infosMap[infoKeyOf(provider, model)] : null
      const efforts = info && Array.isArray(info.efforts) ? info.efforts : []
      const entry = efforts.find((item) => item && item.id === effort)
      return base + ' · ' + (entry ? entry.name : effort)
    }

    function EnhanceButton(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackText
      const useInput = typeof props.useInput === 'function' ? props.useInput : null
      const inputActions = props.inputActions || null

      // 无条件调用，保证 hooks 顺序稳定。
      const draftState = useInput ? useInput((state) => state.draft) : ''
      const draft = typeof draftState === 'string' ? draftState : ''
      // 宿主没提供 draftRev 时按 null 处理：只用草稿文本判断是否变过。
      const revState = useInput ? useInput((state) => state.draftRev) : undefined
      const draftRev = typeof revState === 'number' && Number.isFinite(revState) ? revState : null

      const [busy, setBusy] = React.useState(false)
      const [problem, setProblem] = React.useState(null)
      const [staged, setStaged] = React.useState(null)
      const [settingsState, setSettingsState] = React.useState({ status: 'loading', data: null, error: null })
      const [reloadToken, setReloadToken] = React.useState(0)
      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState('presets')
      const [savingModel, setSavingModel] = React.useState(false)
      // 菜单模型快切的候选来自插件自己的路由，与会话模型目录无关。
      const [providersState, setProvidersState] = React.useState({ status: 'idle', list: [] })
      const [modelsMap, setModelsMap] = React.useState({})
      // 思考强度候选：key = infoKeyOf(provider, model)，每个组合只拉一次。
      const [infosMap, setInfosMap] = React.useState({})
      const infoSeqRef = React.useRef({})
      // 从模型列表点了带强度的模型：菜单停在这一档，让用户当场选强度。
      const [effortTarget, setEffortTarget] = React.useState(null)
      const [saving, setSaving] = React.useState(null)
      const [menuProblem, setMenuProblem] = React.useState(null)
      const rootRef = React.useRef(null)
      const busyRef = React.useRef(false)
      const reqRef = React.useRef(0)
      const abortRef = React.useRef(null)
      // 每个 provider 一个请求号：并发拉候选时互不失效。
      const modelSeqRef = React.useRef({})
      const startedAtRef = React.useRef(0)
      const [elapsedMs, setElapsedMs] = React.useState(0)
      // 写 profile 要 ~1s：切档先落到界面，落盘串行排队在后台跑，失败再回滚。
      const saveSeqRef = React.useRef(0)
      const saveChainRef = React.useRef(Promise.resolve())
      // 请求回来时用最新一次渲染的草稿/修订号判断「中途有没有改过」。
      const latestRef = React.useRef({ draft, rev: draftRev })
      latestRef.current = { draft, rev: draftRev }
      // 标签宽度：换档名 / 秒数 / 应用时按实测宽度过渡，避免按钮一截一截地跳。
      const labelRef = React.useRef(null)
      const [labelWidth, setLabelWidth] = React.useState(null)
      // 默认档档名的实测宽度 = 按钮最小宽度；hidden 量宽节点按预设 id 存 ref。
      const [labelFloor, setLabelFloor] = React.useState(0)
      const floorRef = React.useRef({})
      const floorRefFor = (id) => {
        const box = floorRef.current
        if (!box[id]) box[id] = { current: null }
        return box[id]
      }
      const useMeasureEffect =
        typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

      // 预设列表来自宿主：加一档只改 presets.js，这里不用动。
      React.useEffect(() => {
        let alive = true
        setSettingsState({ status: 'loading', data: null, error: null })
        fetchSettings()
          .then((data) => {
            if (alive) setSettingsState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (alive) setSettingsState({ status: 'error', data: null, error: toProblem(error) })
          })
        return () => {
          alive = false
        }
      }, [reloadToken])

      // 详情页存完配置后重新拉一次：新预设、新模型立刻出现在菜单里。
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onChanged = () => setReloadToken((value) => value + 1)
        window.addEventListener(SETTINGS_EVENT, onChanged)
        return () => window.removeEventListener(SETTINGS_EVENT, onChanged)
      }, [])

      // 打开菜单时：点外面关、Esc 关。监听只挂在 document 上，关掉就摘。
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          const node = rootRef.current
          if (node && typeof node.contains === 'function' && event && event.target && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (!event || event.key !== 'Escape') return
          setOpen(false)
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // 草稿被清空 -> 暂存结果作废，回到 idle。
      React.useEffect(() => {
        if (staged !== null && draft.trim() === '') {
          setStaged(null)
          setProblem(null)
        }
      }, [draft, staged])

      // 计时只服务显示：每 250ms 刷新已用时间，满 1 秒才把秒数放上按钮。
      React.useEffect(() => {
        if (!busy) return undefined
        const started = Date.now()
        setElapsedMs(0)
        const id = setInterval(() => setElapsedMs(Date.now() - started), 250)
        return () => clearInterval(id)
      }, [busy])

      const canWrite = Boolean(inputActions) && typeof inputActions.setDraft === 'function'
      const empty = draft.trim() === ''
      const ready = settingsState.status === 'ready' && settingsState.data !== null
      const settings = ready ? settingsState.data : null
      const currentPreset =
        settings === null
          ? null
          : settings.presets.find((preset) => preset && preset.id === settings.current) ??
            { id: settings.current, label: settings.current }
      const currentLabel = currentPreset === null ? '' : presetLabel(currentPreset)
      const canSwitch = settings !== null && settings.canWrite === true

      const caretDisabled = settingsState.status === 'loading' || (settings !== null && !canSwitch)
      const caretTitle =
        settingsState.status === 'loading'
          ? t('menu.loading')
          : settingsState.status === 'error'
            ? t('menu.loadError') + ' · ' + t('menu.retry')
            : !canSwitch
              ? t('menu.readOnly')
              : t('menu.title')

      const seconds = Math.floor(elapsedMs / 1000)
      const showSeconds = busy && elapsedMs >= 1000
      // 警告色跟随配置里的超时预算，取 80%（最少 1 秒），不写死 25 秒：
      // 超时可配到 600 秒，写死会让「快超时」和「刚开始」长得一样。
      const budgetMs =
        settings !== null && settings.config && Number.isFinite(settings.config.timeoutMs)
          ? settings.config.timeoutMs
          : 30_000
      const warnAtMs = Math.max(1000, Math.round(budgetMs * 0.8))
      const overdue = busy && elapsedMs >= warnAtMs
      const elapsedLabel = showSeconds ? textOf(t, 'button.elapsed').replace('{n}', String(seconds)) : ''
      const presetItems = settings === null ? [] : settings.presets
      const mainLabel =
        staged !== null ? t('button.apply') : busy && showSeconds ? elapsedLabel : currentLabel

      // 标签宽度按实测值过渡：只改 width，不碰 padding / 字体。
      useMeasureEffect(() => {
        const node = labelRef.current
        if (!node) return
        const width = typeof node.scrollWidth === 'number' ? Math.min(node.scrollWidth, LABEL_MAX_PX) : 0
        if (width > 0) setLabelWidth((previous) => (previous === width ? previous : width))
      }, [mainLabel])

      // 最小宽度：默认档档名的宽度。计时数字、比它更短的档名都不许把按钮压窄，
      // 压窄后数字会被 max-width + overflow:hidden 裁掉。
      useMeasureEffect(() => {
        let widest = 0
        for (const preset of presetItems) {
          if (!preset || preset.id !== DEFAULT_PRESET_ID) continue
          const box = floorRef.current[preset.id]
          const node = box === undefined || box === null ? null : box.current
          if (node === null || typeof node.scrollWidth !== 'number') continue
          const width = Math.min(node.scrollWidth, LABEL_MAX_PX)
          if (width > widest) widest = width
        }
        if (widest > 0) setLabelFloor((previous) => (previous === widest ? previous : widest))
      }, [presetItems.length, settingsState.status])

      // 实际渲染宽度 = max(当前文本实测, 默认档档名宽度)。
      const labelBoxWidth = Math.max(labelWidth === null ? 0 : labelWidth, labelFloor)

      const baseTitle = t('button.title')
      const withPreset = textOf(t, 'button.titleWithPreset')
      const idleTitle = currentLabel !== '' ? withPreset.replace('{preset}', currentLabel) : baseTitle
      const stagedTitle =
        staged === null
          ? ''
          : staged.presetLabel !== ''
            ? textOf(t, 'button.applyTitleWithPreset').replace('{preset}', staged.presetLabel)
            : t('button.applyTitle')
      const mainTitle = busy
        ? textOf(t, 'button.cancelTitle')
        : staged !== null
          ? stagedTitle
          : problem !== null
            ? problemText(t, problem)
            : idleTitle
      // 运行中不禁用：再点一下就是取消。
      const mainDisabled = !canWrite

      // 菜单模型快切：只读写插件自己的 provider / model，不碰会话模型。
      const pluginConfig =
        settings !== null && settings.config ? settings.config : { provider: '', model: '' }
      const pluginProvider = typeof pluginConfig.provider === 'string' ? pluginConfig.provider : ''
      const pluginModel = typeof pluginConfig.model === 'string' ? pluginConfig.model : ''
      const providers = providersState.list
      const modelSummary = modelSummaryOf(settings, providers, modelsMap, infosMap)
      const pluginEffort =
        typeof pluginConfig.reasoningEffort === 'string' ? pluginConfig.reasoningEffort : ''
      const effortInfo =
        effortTarget === null
          ? null
          : infosMap[infoKeyOf(effortTarget.provider, effortTarget.model)] || null
      const effortChoices = effortInfo && effortInfo.status === 'ready' ? effortInfo.efforts : []
      const effortStatus = effortInfo === null ? 'idle' : effortInfo.status
      const effortTargetName =
        effortTarget === null
          ? ''
          : modelNameOf(effortTarget.provider, effortTarget.model, providers, modelsMap)
      const groups = providers.map((provider) => {
        const bucket = modelsMap[provider.id]
        return {
          id: provider.id,
          name: provider.name || provider.id,
          status: bucket && typeof bucket.status === 'string' ? bucket.status : 'idle',
          models: bucket && Array.isArray(bucket.list) ? bucket.list : [],
        }
      })

      const applyStaged = () => {
        if (staged === null || !canWrite) return
        inputActions.setDraft(staged.text)
        if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
        setStaged(null)
        setProblem(null)
      }

      /** 取消：请求号先失效，在途回包与 finally 都不再改状态；再 abort 网络请求。 */
      const cancelEnhance = () => {
        reqRef.current += 1
        busyRef.current = false
        const controller = abortRef.current
        abortRef.current = null
        setBusy(false)
        setElapsedMs(0)
        if (controller) controller.abort()
      }

      const onEnhance = async () => {
        // busyRef 与 busy 同义，但它同步置位：同一帧里连点两下时 state 还没重渲染，
        // 只靠 busy 会放过第二个请求。
        if (busyRef.current) {
          if (Date.now() - startedAtRef.current >= CANCEL_GRACE_MS) cancelEnhance()
          return
        }
        if (!canWrite || empty) return
        if (staged !== null) {
          setOpen(false)
          applyStaged()
          return
        }
        // 快照包含修订号：结果回来时用它判断用户有没有中途改字。
        const snapshot = latestRef.current
        const presetId = currentPreset === null ? undefined : currentPreset.id
        const presetName = currentLabel !== '' ? currentLabel : currentPreset !== null ? currentPreset.id : ''
        const reqId = ++reqRef.current
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        startedAtRef.current = Date.now()
        setOpen(false)
        busyRef.current = true
        setBusy(true)
        setProblem(null)
        try {
          const text = await callEnhance(draft, presetId, controller ? controller.signal : undefined)
          // 取消过或被新请求取代：这份结果已经不属于当前界面。
          if (reqRef.current !== reqId) return
          const latest = latestRef.current
          // 草稿已清空：这次结果作废，不打扰用户。
          if (latest.draft.trim() === '') {
            setStaged(null)
            setProblem(null)
            return
          }
          const sameDraft = latest.draft === snapshot.draft
          const sameRev = snapshot.rev === null || latest.rev === null || latest.rev === snapshot.rev
          if (sameDraft && sameRev) {
            inputActions.setDraft(text)
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
          } else {
            // 中途改过字：先攒着，等用户点「应用」再覆盖。
            setStaged({ text, presetLabel: presetName })
          }
        } catch (error) {
          // 取消已自行回到 idle；过期请求的错误也不该落到界面上。
          if (reqRef.current !== reqId) return
          const next = toProblem(error)
          if (next.code !== 'CANCELLED') setProblem(next)
        } finally {
          if (reqRef.current === reqId) {
            abortRef.current = null
            busyRef.current = false
            setBusy(false)
            setElapsedMs(0)
          }
        }
      }

      const onCaret = () => {
        if (caretDisabled) return
        if (settingsState.status === 'error') {
          setReloadToken((value) => value + 1)
          return
        }
        setMenuProblem(null)
        setPane('presets')
        const nextOpen = !open
        setOpen(nextOpen)
      }

      const onChoose = (preset) => {
        if (preset === null) return undefined
        // 旧配置里没填完的自定义档：现在只能在详情页补，菜单里直接说清楚。
        if (preset.configured === false) {
          setMenuProblem({ code: 'CUSTOM_EMPTY', message: '' })
          return undefined
        }
        if (currentPreset !== null && preset.id === currentPreset.id) {
          setOpen(false)
          setMenuProblem(null)
          return undefined
        }
        setMenuProblem(null)
        setOpen(false)
        // 先落地选择：冻结界面等那 ~1s 的 profile 写入就是「卡」的来源。
        setSettingsState((state) =>
          state.data === null
            ? state
            : { status: 'ready', data: { ...state.data, current: preset.id }, error: null },
        )
        const seq = ++saveSeqRef.current
        setSaving(preset.id)
        const write = saveChainRef.current
          .then(() => savePreset(preset.id))
          .then((data) => {
            // 后点的档位优先：旧写入的回包不许把界面拽回去。
            if (seq !== saveSeqRef.current) return
            setSettingsState((state) =>
              state.data === null
                ? state
                : { status: 'ready', data: { ...state.data, current: data.current }, error: null },
            )
          })
          .catch((error) => {
            if (seq !== saveSeqRef.current) return
            setMenuProblem(toProblem(error))
            setOpen(true)
            // 回包不可信（可能已落盘也可能没有）时以宿主为准重新对齐。
            return fetchSettings()
              .then((data) => {
                if (seq !== saveSeqRef.current) return
                setSettingsState({ status: 'ready', data, error: null })
              })
              .catch(() => {})
          })
          .finally(() => {
            if (seq === saveSeqRef.current) setSaving(null)
          })
        saveChainRef.current = write.catch(() => {})
        return write
      }

      /** 拉 provider 候选：失败就当没有候选，不打断增强主链路。 */
      const loadProviders = () => {
        if (providersState.status === 'loading' || providersState.status === 'ready') return
        setProvidersState((state) => ({ status: 'loading', list: state.list }))
        fetchProviders()
          .then((list) => setProvidersState({ status: 'ready', list }))
          .catch(() => setProvidersState({ status: 'error', list: [] }))
      }

      /** 拉某个 provider 的模型候选；同一个 provider 只拉一次。 */
      const loadModelsFor = (providerId) => {
        if (providerId === '') return
        const bucket = modelsMap[providerId]
        if (bucket && (bucket.status === 'loading' || bucket.status === 'ready')) return
        const seq = (modelSeqRef.current[providerId] ?? 0) + 1
        modelSeqRef.current[providerId] = seq
        setModelsMap((map) => ({ ...map, [providerId]: { status: 'loading', list: [] } }))
        fetchModels(providerId)
          .then((list) => {
            if (modelSeqRef.current[providerId] !== seq) return
            setModelsMap((map) => ({ ...map, [providerId]: { status: 'ready', list } }))
          })
          .catch(() => {
            if (modelSeqRef.current[providerId] !== seq) return
            setModelsMap((map) => ({ ...map, [providerId]: { status: 'error', list: [] } }))
          })
      }

      /** 某个 provider/model 的强度候选。适配器没报 reasoning 就是空表。 */
      const loadInfoFor = (provider, model) => {
        if (provider === '' || model === '') return
        const key = infoKeyOf(provider, model)
        const known = infosMap[key]
        if (known && (known.status === 'loading' || known.status === 'ready')) return
        const seq = (infoSeqRef.current[key] || 0) + 1
        infoSeqRef.current[key] = seq
        setInfosMap((map) => ({ ...map, [key]: { status: 'loading', efforts: [] } }))
        fetchModelInfo(provider, model)
          .then((info) => {
            if (infoSeqRef.current[key] !== seq) return
            setInfosMap((map) => ({
              ...map,
              [key]: { status: 'ready', efforts: info === null ? [] : info.efforts },
            }))
          })
          .catch(() => {
            if (infoSeqRef.current[key] !== seq) return
            setInfosMap((map) => ({ ...map, [key]: { status: 'error', efforts: [] } }))
          })
      }

      // 挂载后就把当前 provider 的候选拉一次：按钮旁边那行要显示模型名而不是裸 id。
      React.useEffect(() => {
        if (pluginProvider === '') return
        loadProviders()
        loadModelsFor(pluginProvider)
      }, [pluginProvider, providersState.status])

      // 打开菜单把 provider 候选拉起来；拿到后再逐个 provider 拉模型。
      React.useEffect(() => {
        if (!open) return
        loadProviders()
      }, [open, providersState.status])

      React.useEffect(() => {
        if (!open || providersState.status !== 'ready') return
        for (const provider of providersState.list) loadModelsFor(provider.id)
      }, [open, providersState.status, providersState.list])

      // 当前选的模型报了强度才拉：按钮那行要显示强度名，菜单也要能进强度面板。
      React.useEffect(() => {
        if (pluginProvider === '' || pluginModel === '') return
        loadInfoFor(pluginProvider, pluginModel)
      }, [pluginProvider, pluginModel, infosMap])

      // 进了强度面板就把那一档的候选拉起来。
      React.useEffect(() => {
        if (effortTarget === null) return
        loadInfoFor(effortTarget.provider, effortTarget.model)
      }, [effortTarget, infosMap])

      /**
       * 写插件自己的模型配置：先落界面，再串行落盘，失败回滚到宿主真值。
       * 走的是 /settings 的 config 字段，与详情页那两个字段同一条路。
       */
      const saveModelConfig = (provider, model, reasoningEffort = '', keepOpen = false) => {
        if (settings === null || !canSwitch) {
          setMenuProblem({ code: 'MODEL_UNAVAILABLE', message: '' })
          return Promise.resolve()
        }
        setMenuProblem(null)
        setSavingModel(true)
        // keepOpen：选完模型还要停在强度面板，此时别把菜单收掉。
        if (!keepOpen) {
          setOpen(false)
          setPane('presets')
        }
        setSettingsState((state) =>
          state.data === null
            ? state
            : {
                status: 'ready',
                data: { ...state.data, config: { ...state.data.config, provider, model, reasoningEffort } },
                error: null,
              },
        )
        const seq = ++saveSeqRef.current
        const write = saveChainRef.current
          .then(() => putSettings({ config: { provider, model, reasoningEffort } }))
          .then((data) => {
            // 后选的优先：旧写入的回包不许把界面拽回去。
            if (seq !== saveSeqRef.current) return
            setSettingsState((state) =>
              state.data === null
                ? state
                : { status: 'ready', data: { ...state.data, config: data.config }, error: null },
            )
            return true
          })
          .catch((error) => {
            if (seq !== saveSeqRef.current) return
            setMenuProblem({
              code: 'MODEL_FAILED',
              message: error instanceof Error ? error.message : String(error),
            })
            // 写盘失败要把菜单重新打开，否则用户只看到菜单闪一下就没了。
            setOpen(true)
            return fetchSettings()
              .then((data) => {
                if (seq !== saveSeqRef.current) return
                setSettingsState({ status: 'ready', data, error: null })
              })
              .catch(() => {})
              .then(() => false)
          })
          .finally(() => {
            if (seq === saveSeqRef.current) setSavingModel(false)
          })
        saveChainRef.current = write.catch(() => {})
        return write
      }

      /**
       * 选模型：先问一句这个模型有没有可选强度。
       * 有 -> 写模型（顺带清空强度）并停在强度面板；没有 -> 写完直接收菜单。
       */
      const onPickPluginModel = async (providerId, modelId) => {
        if (savingModel) return undefined
        const same = providerId === pluginProvider && modelId === pluginModel
        if (same) {
          const known = infosMap[infoKeyOf(providerId, modelId)]
          if (known && known.status === 'ready' && known.efforts.length > 0) {
            setEffortTarget({ provider: providerId, model: modelId })
            setPane('efforts')
            return undefined
          }
          setOpen(false)
          setPane('presets')
          return undefined
        }
        const info = await fetchModelInfo(providerId, modelId).catch(() => null)
        const efforts = info === null ? [] : info.efforts
        const ok = await saveModelConfig(providerId, modelId, '', efforts.length > 0)
        if (ok === true && efforts.length > 0) {
          setEffortTarget({ provider: providerId, model: modelId })
          setPane('efforts')
          setOpen(true)
        }
        return undefined
      }

      /** 跟随默认模型 = 清空 provider / model / 强度三项。 */
      const onFollowDefault = () => {
        if (savingModel) return undefined
        if (pluginProvider === '' && pluginModel === '' && pluginEffort === '') {
          setOpen(false)
          setPane('presets')
          return undefined
        }
        return saveModelConfig('', '', '')
      }

      /** 选强度：只写 reasoningEffort，模型不变。 */
      const onPickEffort = (effortId) => {
        if (savingModel || effortTarget === null) return undefined
        if (effortId === pluginEffort) {
          setEffortTarget(null)
          setOpen(false)
          setPane('presets')
          return undefined
        }
        const target = effortTarget
        return saveModelConfig(target.provider, target.model, effortId).then(() => {
          setEffortTarget(null)
        })
      }

      const menuBusy = savingModel || saving !== null

      // 空草稿时整个按钮不渲染；菜单开着就继续显示。
      // 这一句必须留在所有 hook 之后：一旦放到 hook 中间，草稿从空变非空时
      // 渲染的 hook 数量会变，React 直接抛「Rendered more hooks than during
      // the previous render」，整条输入框工具条会连按钮一起消失。
      if (!busy && empty && !open) return null

      return h(
        'div',
        {
          className: 'pev2-split',
          ref: rootRef,
          'data-menu-open': open ? 'true' : 'false',
        },
        // 默认档档名量一次，作为按钮最小宽度。隐藏渲染，不参与布局。
        presetItems.map((preset) =>
          h(
            'span',
            {
              key: 'measure-' + preset.id,
              className: 'pev2-measure',
              'aria-hidden': 'true',
              ref: floorRefFor(preset.id),
            },
            presetLabel(preset),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'pev2-main',
            title: mainTitle,
            'aria-label': mainTitle,
            'data-busy': busy ? 'true' : 'false',
            'data-error': problem !== null ? 'true' : 'false',
            'data-overdue': overdue ? 'true' : 'false',
            'data-staged': staged !== null ? 'true' : 'false',
            disabled: mainDisabled,
            onClick: onEnhance,
          },
          staged !== null ? h(CheckIcon) : h(QBuddyIcon),
          mainLabel !== ''
            ? h(
                'span',
                {
                  className: 'pev2-label',
                  ref: labelRef,
                  style: labelBoxWidth > 0 ? { width: labelBoxWidth + 'px' } : undefined,
                },
                mainLabel,
              )
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'pev2-caret',
            title: caretTitle,
            'aria-label': caretTitle,
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: caretDisabled,
            onClick: onCaret,
          },
          h(ChevronIcon),
        ),
        open && settings !== null
          ? h(
              'div',
              { className: 'pev2-menu', role: 'menu', 'aria-label': t('menu.title') },
              pane === 'presets'
                ? h(
                    React.Fragment,
                    null,
                    h('div', { className: 'pev2-menu-head' }, t('menu.title')),
                    h(
                      'div',
                      { className: 'pev2-menu-scroll' },
                      presetItems.map((preset) => {
                        const isCurrent = currentPreset !== null && preset && preset.id === currentPreset.id
                        const pending = saving === preset.id
                        return h(
                          'button',
                          {
                            key: preset.id,
                            type: 'button',
                            role: 'menuitemradio',
                            className: 'pev2-item',
                            'aria-checked': isCurrent ? 'true' : 'false',
                            'data-current': isCurrent ? 'true' : 'false',
                            'data-saving': pending ? 'true' : 'false',
                            disabled: pending || (saving !== null && !pending),
                            onClick: () => onChoose(preset),
                          },
                          h('span', { className: 'pev2-item-label' }, presetLabel(preset)),
                          h(
                            'span',
                            { className: 'pev2-item-mark', 'aria-label': isCurrent ? t('menu.current') : '' },
                            isCurrent ? '✓' : pending ? '…' : '',
                          ),
                        )
                      }),
                    ),
                    h('div', { className: 'pev2-divider' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pev2-model-row',
                        title: textOf(t, 'menu.model'),
                        disabled: savingModel,
                        onClick: () => {
                          setMenuProblem(null)
                          setPane('models')
                          loadProviders()
                        },
                      },
                      h('span', { className: 'pev2-model-row-label' }, textOf(t, 'menu.model')),
                      h(
                        'span',
                        { className: 'pev2-model-row-value' },
                        modelSummary !== ''
                          ? modelSummary
                          : providersState.status === 'loading'
                            ? textOf(t, 'menu.modelLoading')
                            : textOf(t, 'menu.modelFollow'),
                      ),
                      h(ChevronRightIcon),
                    ),
                    menuProblem !== null
                      ? h('div', { className: 'pev2-menu-error', role: 'alert' }, menuProblemText(t, menuProblem))
                      : null,
                  )
                : null,
              pane === 'efforts'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'pev2-menu-nav' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pev2-back',
                          onClick: () => {
                            setMenuProblem(null)
                            setPane('models')
                          },
                        },
                        h(ArrowLeftIcon),
                        textOf(t, 'menu.back'),
                      ),
                      h('span', { className: 'pev2-menu-nav-title' }, textOf(t, 'menu.effortsTitle')),
                    ),
                    h(
                      'div',
                      { className: 'pev2-menu-scroll' },
                      effortTargetName !== ''
                        ? h('div', { className: 'pev2-menu-head' }, effortTargetName)
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitemradio',
                          className: 'pev2-item',
                          'aria-checked': pluginEffort === '' ? 'true' : 'false',
                          'data-current': pluginEffort === '' ? 'true' : 'false',
                          disabled: savingModel,
                          onClick: () => onPickEffort(''),
                        },
                        h('span', { className: 'pev2-item-label' }, textOf(t, 'menu.effortDefault')),
                        h('span', { className: 'pev2-item-mark' }, pluginEffort === '' ? '✓' : ''),
                      ),
                      h('div', { className: 'pev2-divider' }),
                      effortStatus === 'loading'
                        ? h('div', { className: 'pev2-menu-empty' }, textOf(t, 'menu.effortLoading'))
                        : effortChoices.length === 0
                          ? h('div', { className: 'pev2-menu-empty' }, textOf(t, 'menu.effortNone'))
                          : effortChoices.map((effort) => {
                              const isCurrent = pluginEffort === effort.id
                              return h(
                                'button',
                                {
                                  key: effort.id,
                                  type: 'button',
                                  role: 'menuitemradio',
                                  className: 'pev2-item',
                                  'aria-checked': isCurrent ? 'true' : 'false',
                                  'data-current': isCurrent ? 'true' : 'false',
                                  disabled: savingModel,
                                  onClick: () => onPickEffort(effort.id),
                                },
                                h('span', { className: 'pev2-item-label' }, effort.name),
                                h('span', { className: 'pev2-item-mark' }, isCurrent ? '✓' : ''),
                              )
                            }),
                    ),
                    menuProblem !== null
                      ? h('div', { className: 'pev2-menu-error', role: 'alert' }, menuProblemText(t, menuProblem))
                      : null,
                  )
                : null,
              pane === 'models'
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'pev2-menu-nav' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pev2-back',
                          onClick: () => {
                            setMenuProblem(null)
                            setPane('presets')
                          },
                        },
                        h(ArrowLeftIcon),
                        textOf(t, 'menu.back'),
                      ),
                      h('span', { className: 'pev2-menu-nav-title' }, textOf(t, 'menu.modelsTitle')),
                    ),
                    h(
                      'div',
                      { className: 'pev2-menu-scroll' },
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitemradio',
                          className: 'pev2-item',
                          'aria-checked': pluginProvider === '' ? 'true' : 'false',
                          'data-current': pluginProvider === '' ? 'true' : 'false',
                          disabled: savingModel,
                          onClick: onFollowDefault,
                        },
                        h('span', { className: 'pev2-item-label' }, textOf(t, 'menu.modelFollow')),
                        h('span', { className: 'pev2-item-mark' }, pluginProvider === '' ? '✓' : ''),
                      ),
                      h('div', { className: 'pev2-divider' }),
                      providersState.status === 'error' && groups.length === 0
                        ? h('div', { className: 'pev2-menu-empty' }, textOf(t, 'menu.modelUnavailable'))
                        : providersState.status === 'loading' && groups.length === 0
                          ? h('div', { className: 'pev2-menu-empty' }, textOf(t, 'menu.modelLoading'))
                          : groups.length === 0
                            ? h('div', { className: 'pev2-menu-empty' }, textOf(t, 'menu.noModels'))
                            : groups.map((group) =>
                                h(
                                  'div',
                                  { key: group.id },
                                  h('div', { className: 'pev2-menu-head' }, group.name || group.id),
                                  group.models.length === 0
                                    ? h(
                                        'div',
                                        { className: 'pev2-menu-empty' },
                                        group.status === 'loading'
                                          ? textOf(t, 'menu.modelLoading')
                                          : textOf(t, 'menu.noModels'),
                                      )
                                    : group.models.map((model) => {
                                        const isCurrent =
                                          pluginProvider === group.id && pluginModel === model.id
                                        return h(
                                          'button',
                                          {
                                            key: group.id + '/' + model.id,
                                            type: 'button',
                                            role: 'menuitemradio',
                                            className: 'pev2-item',
                                            'aria-checked': isCurrent ? 'true' : 'false',
                                            'data-current': isCurrent ? 'true' : 'false',
                                            disabled: savingModel,
                                            onClick: () => onPickPluginModel(group.id, model.id),
                                          },
                                          h('span', { className: 'pev2-item-label' }, model.name || model.id),
                                          h('span', { className: 'pev2-item-mark' }, isCurrent ? '✓' : ''),
                                        )
                                      }),
                                ),
                              ),
                    ),
                    menuProblem !== null
                      ? h('div', { className: 'pev2-menu-error', role: 'alert' }, menuProblemText(t, menuProblem))
                      : null,
                  )
                : null,
            )
          : null,
      )
    }

    /** 详情页卡片：宿主只给一个空 section，标题、卡片和间距都由这里画。 */
    function ConfigCard(props) {
      if (props.view !== 'page') return null
      return h(ConfigCardInner, props)
    }

    function secondsText(timeoutMs) {
      const seconds = Math.round(Number(timeoutMs) / 100) / 10
      return Number.isFinite(seconds) && seconds > 0 ? String(seconds) : '30'
    }

    function formOf(data) {
      const config = data.config && typeof data.config === 'object' ? data.config : {}
      return {
        provider: typeof config.provider === 'string' ? config.provider : '',
        model: typeof config.model === 'string' ? config.model : '',
        reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : '',
        timeoutSec: secondsText(config.timeoutMs),
        presets: Array.isArray(data.customPresets)
          ? data.customPresets.map((preset) => ({
              id: preset.id,
              name: typeof preset.name === 'string' ? preset.name : '',
              system: typeof preset.system === 'string' ? preset.system : '',
              user: typeof preset.user === 'string' ? preset.user : '',
            }))
          : [],
      }
    }

    function presetProblemKey(preset) {
      if (preset.name.trim() === '') return 'config.nameRequired'
      if (preset.name.trim().length > MAX_NAME_CHARS) return 'config.nameTooLong'
      if (preset.system.trim() === '') return 'config.systemRequired'
      if (!preset.user.includes(DRAFT_TOKEN)) return 'config.draftRequired'
      if (preset.system.length > MAX_TEMPLATE_CHARS || preset.user.length > MAX_TEMPLATE_CHARS) return 'config.tooLong'
      return null
    }

    function ConfigCardInner(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackText
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const [form, setForm] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [problem, setProblem] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const [reloadToken, setReloadToken] = React.useState(0)
      const seqRef = React.useRef(0)
      // 候选列表只是输入辅助：拿不到就退回手动填写，不影响主表单。
      const [providers, setProviders] = React.useState({ status: 'loading', list: [] })
      const [models, setModels] = React.useState({ status: 'idle', provider: '', list: [] })
      // 思考强度候选：跟着 provider/model 走；适配器没报 reasoning 的模型没有这一栏。
      const [efforts, setEfforts] = React.useState({
        status: 'idle',
        key: '',
        list: [],
        defaultEffort: '',
      })

      React.useEffect(() => {
        let alive = true
        setState({ status: 'loading', data: null, error: null })
        setSaved(false)
        fetchSettings()
          .then((data) => {
            if (!alive) return
            setState({ status: 'ready', data, error: null })
            setForm(formOf(data))
          })
          .catch((error) => {
            if (!alive) return
            setState({ status: 'error', data: null, error: toProblem(error) })
          })
        setProviders({ status: 'loading', list: [] })
        fetchProviders()
          .then((list) => {
            if (alive) setProviders({ status: 'ready', list })
          })
          .catch(() => {
            if (alive) setProviders({ status: 'ready', list: [] })
          })
        return () => {
          alive = false
        }
      }, [reloadToken])

      // provider 变了就重取模型候选；手动填的 provider 不在已注册列表里时不发请求。
      const providerForModels = form === null ? '' : form.provider.trim()
      const knownProvider =
        providerForModels !== '' && providers.list.some((item) => item.id === providerForModels)
      React.useEffect(() => {
        if (!knownProvider) {
          setModels({ status: 'idle', provider: '', list: [] })
          return undefined
        }
        let alive = true
        setModels({ status: 'loading', provider: providerForModels, list: [] })
        fetchModels(providerForModels)
          .then((list) => {
            if (alive) setModels({ status: 'ready', provider: providerForModels, list })
          })
          .catch(() => {
            if (alive) setModels({ status: 'ready', provider: providerForModels, list: [] })
          })
        return () => {
          alive = false
        }
      }, [providerForModels, knownProvider])

      // 思考强度跟着「已确定的 provider + model」走：手填的组合也查，查不到就当没有。
      const modelForInfo = form === null ? '' : form.model.trim()
      const infoKey =
        knownProvider && modelForInfo !== '' ? providerForModels + '\u0000' + modelForInfo : ''
      React.useEffect(() => {
        if (infoKey === '') {
          setEfforts({ status: 'idle', key: '', list: [], defaultEffort: '' })
          return undefined
        }
        let alive = true
        setEfforts({ status: 'loading', key: infoKey, list: [], defaultEffort: '' })
        fetchModelInfo(providerForModels, modelForInfo)
          .then((info) => {
            if (!alive) return
            setEfforts({
              status: 'ready',
              key: infoKey,
              list: info === null ? [] : info.efforts,
              defaultEffort: info === null ? '' : info.defaultEffort,
            })
          })
          .catch(() => {
            if (alive) setEfforts({ status: 'ready', key: infoKey, list: [], defaultEffort: '' })
          })
        return () => {
          alive = false
        }
      }, [infoKey])

      const data = state.data
      const canWrite = Boolean(data && data.canWrite === true)
      const defaults = data && data.customDefaults && typeof data.customDefaults === 'object' ? data.customDefaults : null
      const savedReadOnly = Boolean(data && data.canWrite !== true)
      const timeoutValue = form === null ? Number.NaN : Number(form.timeoutSec)
      const timeoutValid =
        form !== null &&
        form.timeoutSec.trim() !== '' &&
        Number.isFinite(timeoutValue) &&
        timeoutValue >= 0.1 &&
        timeoutValue <= 600
      const fieldsTooLong =
        form !== null && (form.provider.length > 200 || form.model.length > 200)
      // 有候选就渲染下拉，没有候选就退回手动填写——绝不把用户锁死在空列表里。
      const providerSelectable = providers.list.length > 0
      const providerIds = providers.list.map((item) => item.id)
      const providerValue = form === null ? '' : form.provider
      const providerExtra =
        form !== null && form.provider !== '' && !providerIds.includes(form.provider) ? form.provider : ''
      const modelCandidates = providerValue !== '' && models.provider === providerValue ? models.list : []
      const modelIds = modelCandidates.map((item) => item.id)
      const modelExtra = form !== null && form.model !== '' && !modelIds.includes(form.model) ? form.model : ''
      const modelLoading = models.status === 'loading' && models.provider === providerValue
      const modelManual = providerValue !== '' && !modelLoading && modelCandidates.length === 0
      const effortReady = infoKey !== '' && efforts.key === infoKey
      const effortLoading = effortReady && efforts.status === 'loading'
      const effortChoices = effortReady && efforts.status === 'ready' ? efforts.list : []
      const effortSelectable = effortChoices.length > 0
      const fieldDisabled = !canWrite || saving
      const pairingBroken = form !== null && form.provider.trim() !== '' && form.model.trim() === ''
      const presetProblems = form === null ? [] : form.presets.map((preset) => presetProblemKey(preset))
      const formValid =
        form !== null &&
        timeoutValid &&
        !fieldsTooLong &&
        !pairingBroken &&
        presetProblems.every((key) => key === null)
      const builtins = data !== null && Array.isArray(data.presets)
        ? data.presets.filter((preset) => !preset || preset.custom !== true)
        : []

      const update = (patch) => setForm((current) => (current === null ? current : { ...current, ...patch }))
      const updatePreset = (id, patch) =>
        setForm((current) =>
          current === null
            ? current
            : {
                ...current,
                presets: current.presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
              },
        )

      const addPreset = () => {
        if (form === null) return
        const used = new Set(form.presets.map((preset) => preset.id))
        let id = newPresetId()
        while (used.has(id)) id = newPresetId()
        const name = textOf(t, 'config.newPresetName').replace('{n}', String(form.presets.length + 1))
        setForm({
          ...form,
          presets: [
            ...form.presets,
            {
              id,
              name,
              system: defaults && typeof defaults.system === 'string' ? defaults.system : '',
              user: defaults && typeof defaults.user === 'string' ? defaults.user : '',
            },
          ],
        })
        setSaved(false)
      }

      const removePreset = (id) => {
        if (form === null) return
        setForm({ ...form, presets: form.presets.filter((preset) => preset.id !== id) })
        setSaved(false)
      }

      const resetTemplates = (id) => {
        if (defaults === null) return
        updatePreset(id, {
          system: typeof defaults.system === 'string' ? defaults.system : '',
          user: typeof defaults.user === 'string' ? defaults.user : '',
        })
        setSaved(false)
      }

      const onSave = async () => {
        if (form === null || !formValid || saving || !canWrite) return undefined
        const seq = ++seqRef.current
        setSaving(true)
        setProblem(null)
        setSaved(false)
        try {
          const next = await putSettings({
            config: {
              provider: form.provider.trim(),
              model: form.model.trim(),
              reasoningEffort: form.reasoningEffort.trim(),
              timeoutMs: Math.round(timeoutValue * 1000),
            },
            presets: form.presets.map((preset) => ({
              id: preset.id,
              name: preset.name.trim(),
              system: preset.system,
              user: preset.user,
            })),
          })
          if (seq !== seqRef.current) return undefined
          if (!next || !Array.isArray(next.presets)) throw new PluginError('BAD_RESPONSE', 'settings shape')
          setState({ status: 'ready', data: next, error: null })
          setForm(formOf(next))
          setSaved(true)
          notifySettingsChanged()
          return undefined
        } catch (error) {
          if (seq !== seqRef.current) return undefined
          setProblem(toProblem(error))
          return undefined
        } finally {
          if (seq === seqRef.current) setSaving(false)
        }
      }

      const problemMessage =
        problem === null
          ? null
          : problem.code === 'BAD_CONFIG' || problem.code === 'BAD_PRESETS'
            ? textOf(t, 'config.saveFailed').replace('{message}', problem.message)
            : textOf(t, 'config.saveFailed').replace(
                '{message}',
                problem.message || textOf(t, 'error.switchFailedGeneric'),
              )

      return h(
        'div',
        { className: 'pev2-cfg' },
        h(
          'div',
          { className: 'pev2-cfg-head' },
          h('h3', { className: 'pev2-cfg-title' }, textOf(t, 'config.title')),
          h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.hint')),
        ),
        state.status === 'loading'
          ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.loading'))
          : state.status === 'error'
            ? h(
                'div',
                { className: 'pev2-cfg-actions' },
                h('span', { className: 'pev2-cfg-error', role: 'alert' }, textOf(t, 'config.loadFailed')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pev2-cfg-btn pev2-cfg-secondary',
                    onClick: () => setReloadToken((value) => value + 1),
                  },
                  textOf(t, 'config.retry'),
                ),
              )
            : form === null
              ? null
              : h(
                  React.Fragment,
                  null,
                  savedReadOnly ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.readOnly')) : null,
                  h(
                    'div',
                    { className: 'pev2-cfg-section' },
                    h('div', { className: 'pev2-cfg-section-title' }, textOf(t, 'config.modelSection')),
                    h(
                      'div',
                      { className: 'pev2-cfg-grid' },
                      h(
                        'label',
                        { className: 'pev2-cfg-field' },
                        h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.provider')),
                        providerSelectable
                          ? h(
                              'select',
                              {
                                className: 'pev2-input pev2-select',
                                value: form.provider,
                                disabled: fieldDisabled,
                                onChange: (event) => {
                                  // 换了 provider，旧 model 一定不属于新路由，清空重选。
                                  update({ provider: event.target.value, model: '' })
                                  setSaved(false)
                                },
                              },
                              h('option', { value: '' }, textOf(t, 'config.providerFollow')),
                              providerExtra !== ''
                                ? h('option', { value: providerExtra }, providerExtra)
                                : null,
                              providers.list.map((item) =>
                                h('option', { key: item.id, value: item.id }, item.name),
                              ),
                            )
                          : h('input', {
                              className: 'pev2-input',
                              type: 'text',
                              maxLength: 200,
                              value: form.provider,
                              disabled: fieldDisabled,
                              onChange: (event) => {
                                update({ provider: event.target.value })
                                setSaved(false)
                              },
                            }),
                      ),
                      h(
                        'label',
                        { className: 'pev2-cfg-field' },
                        h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.model')),
                        providerSelectable && providerValue === ''
                          ? h(
                              'select',
                              { className: 'pev2-input pev2-select', value: '', disabled: true },
                              h('option', { value: '' }, textOf(t, 'config.modelFollow')),
                            )
                          : modelLoading
                            ? h(
                                'select',
                                { className: 'pev2-input pev2-select', value: '', disabled: true },
                                h('option', { value: '' }, textOf(t, 'config.modelLoading')),
                              )
                            : modelCandidates.length > 0
                              ? h(
                                  'select',
                                  {
                                    className: 'pev2-input pev2-select',
                                    value: form.model,
                                    disabled: fieldDisabled,
                                    onChange: (event) => {
                                      // 换模型就把强度清掉：上一档的强度未必存在。
                                      update({ model: event.target.value, reasoningEffort: '' })
                                      setSaved(false)
                                    },
                                  },
                                  form.model === '' || modelExtra !== ''
                                    ? h(
                                        'option',
                                        { value: form.model },
                                        form.model === '' ? textOf(t, 'config.modelPick') : modelExtra,
                                      )
                                    : null,
                                  modelCandidates.map((item) =>
                                    h('option', { key: item.id, value: item.id }, item.name),
                                  ),
                                )
                              : h('input', {
                                  className: 'pev2-input',
                                  type: 'text',
                                  maxLength: 200,
                                  value: form.model,
                                  disabled: fieldDisabled,
                                  onChange: (event) => {
                                    update({ model: event.target.value, reasoningEffort: '' })
                                    setSaved(false)
                                  },
                                }),
                      ),
                      effortSelectable || effortLoading
                        ? h(
                            'label',
                            { className: 'pev2-cfg-field' },
                            h(
                              'span',
                              { className: 'pev2-cfg-label' },
                              textOf(t, 'config.reasoningEffort'),
                            ),
                            effortLoading
                              ? h(
                                  'select',
                                  { className: 'pev2-input pev2-select', value: '', disabled: true },
                                  h('option', { value: '' }, textOf(t, 'config.effortLoading')),
                                )
                              : h(
                                  'select',
                                  {
                                    className: 'pev2-input pev2-select',
                                    value: form.reasoningEffort,
                                    disabled: fieldDisabled,
                                    onChange: (event) => {
                                      update({ reasoningEffort: event.target.value })
                                      setSaved(false)
                                    },
                                  },
                                  h('option', { value: '' }, textOf(t, 'config.effortDefault')),
                                  effortChoices.map((item) =>
                                    h('option', { key: item.id, value: item.id }, item.name),
                                  ),
                                ),
                          )
                        : null,
                      h(
                        'label',
                        { className: 'pev2-cfg-field' },
                        h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.timeout')),
                        h('input', {
                          className: 'pev2-input',
                          type: 'number',
                          step: 1,
                          min: 0.1,
                          max: 600,
                          value: form.timeoutSec,
                          disabled: !canWrite || saving,
                          onChange: (event) => {
                            update({ timeoutSec: event.target.value })
                            setSaved(false)
                          },
                        }),
                      ),
                    ),
                    h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.modelHint')),
                    providerSelectable ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.providerHint')) : null,
                    !providerSelectable && providers.status === 'ready'
                      ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.candidatesFailed'))
                      : null,
                    modelManual ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.modelManual')) : null,
                    h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.timeoutHint')),
                    fieldsTooLong ? h('div', { className: 'pev2-cfg-error' }, textOf(t, 'config.providerTooLong')) : null,
                    pairingBroken ? h('div', { className: 'pev2-cfg-error' }, textOf(t, 'config.modelRequired')) : null,
                    !timeoutValid ? h('div', { className: 'pev2-cfg-error' }, textOf(t, 'config.timeoutInvalid')) : null,
                  ),
                  h(
                    'div',
                    { className: 'pev2-cfg-section' },
                    h('div', { className: 'pev2-cfg-section-title' }, textOf(t, 'config.builtinSection')),
                    h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.builtinHint')),
                    h(
                      'div',
                      { className: 'pev2-cfg-builtins' },
                      builtins.map((preset) =>
                        h(
                          'div',
                          { key: preset.id, className: 'pev2-cfg-builtin' },
                          h('div', { className: 'pev2-cfg-builtin-name' }, presetLabel(preset)),
                          h('div', { className: 'pev2-cfg-builtin-desc' }, presetDescription(preset)),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'pev2-cfg-section' },
                    h('div', { className: 'pev2-cfg-section-title' }, textOf(t, 'config.customSection')),
                    h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.customHint')),
                    form.presets.length === 0
                      ? h('div', { className: 'pev2-cfg-hint' }, textOf(t, 'config.empty'))
                      : form.presets.map((preset, index) =>
                          h(
                            'div',
                            { key: preset.id, className: 'pev2-cfg-preset', 'data-preset-id': preset.id },
                            h(
                              'div',
                              { className: 'pev2-cfg-preset-head' },
                              h(
                                'label',
                                { className: 'pev2-cfg-field' },
                                h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.name')),
                                h('input', {
                                  className: 'pev2-input',
                                  type: 'text',
                                  maxLength: MAX_NAME_CHARS,
                                  placeholder: textOf(t, 'config.namePlaceholder'),
                                  value: preset.name,
                                  disabled: !canWrite || saving,
                                  onChange: (event) => {
                                    updatePreset(preset.id, { name: event.target.value })
                                    setSaved(false)
                                  },
                                }),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'pev2-cfg-danger',
                                  disabled: !canWrite || saving,
                                  onClick: () => removePreset(preset.id),
                                },
                                textOf(t, 'config.delete'),
                              ),
                            ),
                            h(
                              'label',
                              { className: 'pev2-cfg-field' },
                              h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.system')),
                              h('textarea', {
                                className: 'pev2-textarea',
                                rows: 4,
                                spellCheck: false,
                                value: preset.system,
                                disabled: !canWrite || saving,
                                onChange: (event) => {
                                  updatePreset(preset.id, { system: event.target.value })
                                  setSaved(false)
                                },
                              }),
                            ),
                            h(
                              'label',
                              { className: 'pev2-cfg-field' },
                              h('span', { className: 'pev2-cfg-label' }, textOf(t, 'config.user')),
                              h('textarea', {
                                className: 'pev2-textarea',
                                rows: 4,
                                spellCheck: false,
                                value: preset.user,
                                disabled: !canWrite || saving,
                                onChange: (event) => {
                                  updatePreset(preset.id, { user: event.target.value })
                                  setSaved(false)
                                },
                              }),
                              h('span', { className: 'pev2-cfg-hint' }, textOf(t, 'config.userHint')),
                            ),
                            h(
                              'div',
                              { className: 'pev2-cfg-actions' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'pev2-cfg-btn pev2-cfg-secondary',
                                  disabled: !canWrite || saving || defaults === null,
                                  onClick: () => resetTemplates(preset.id),
                                },
                                textOf(t, 'config.resetTemplates'),
                              ),
                              presetProblems[index] !== null
                                ? h(
                                    'span',
                                    { className: 'pev2-cfg-error', role: 'alert' },
                                    textOf(t, presetProblems[index]),
                                  )
                                : null,
                            ),
                          ),
                        ),
                    h(
                      'div',
                      { className: 'pev2-cfg-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'pev2-cfg-btn pev2-cfg-secondary',
                          disabled: !canWrite || saving,
                          onClick: addPreset,
                        },
                        textOf(t, 'config.newPreset'),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'pev2-cfg-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pev2-cfg-btn pev2-cfg-primary',
                        disabled: !canWrite || saving || !formValid,
                        onClick: onSave,
                      },
                      saving ? textOf(t, 'config.saving') : textOf(t, 'config.save'),
                    ),
                    saved ? h('span', { className: 'pev2-cfg-ok' }, textOf(t, 'config.saved')) : null,
                    problemMessage !== null
                      ? h('span', { className: 'pev2-cfg-error', role: 'alert' }, problemMessage)
                      : null,
                  ),
                ),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'prompt-enhance-v2: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-prompt-enhance', 'v2')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'prompt-enhance-v2: styles')

      // 插槽声明是异步到位的：用 inject 等它、用 effect 管回收，
      // 插件停用/热重载时按钮会被摘掉。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: NS,
                order: 0,
                locale: NS,
              },
              EnhanceButton,
            ),
          ),
        'prompt-enhance-v2: input button',
      )

      // 插件详情页里的配置卡片：key 必须是包名，宿主按它分发。
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: PKG_NAME,
                locale: NS,
              },
              ConfigCard,
            ),
          ),
        'prompt-enhance-v2: plugin settings card',
      )
    }

    return { inject, apply }
  },
})
