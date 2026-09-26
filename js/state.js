// filename: js/state.js
/**
 * ============================================================================
 * state.js — 全局状态对象
 * ============================================================================
 *
 * 【本次重构】
 *   新增字段 txtExtensionHistory：
 *     · 用途：TXT 自由模式下的后缀历史列表；
 *     · 结构：string[]（按 MRU 顺序，最近加入的在最前）；
 *     · 生命周期：
 *         - 由 file-io.js 的 loadTxtExtensionHistory 从 localStorage 恢复；
 *         - 用户提交新后缀时由 addTxtExtensionHistoryItem 更新；
 *         - 用户点击 × 删除时由 removeTxtExtensionHistoryItem 更新；
 *     · 与 languageExtensionMap.txt 的关系：
 *         - languageExtensionMap.txt 是"当前值"（用户此刻用哪个）；
 *         - txtExtensionHistory 是"曾用值列表"（供快速选择）；
 *         - 两者独立但通过 commitFileExtensionValue 保持同步更新。
 *
 *   其余字段完全保持原样。
 * ============================================================================
 */

export const EditorState = {
    // ---- 语言 / 内容 ----
    currentLanguage: 'js',
    codeModified: false,
    originalCode: '',

    // ---- 搜索 ----
    searchMatchIndex: -1,
    lastSearchMatches: [],

    // ---- 编辑器外观 ----
    currentFontSize: 14,
    wordWrapEnabled: false,
    indentSize: 4,
    indentCharacter: ' ',
    theme: 'dark',
    highlightEnabled: true,
    userForcedHighlight: false,

    // ---- 大文件 ----
    largeFileThreshold: 300 * 1024,
    absoluteFileSizeLimit: 2 * 1024 * 1024,
    maxPasteSize: 1.5 * 1024 * 1024,
    largeFileActive: false,

    // ---- 定时器 ----
    autoSaveTimer: null,
    updateTimer: null,
    toastTimer: null,
    copyRestoreTimer: null,

    // ---- 普通键盘输入的历史快照防抖定时器 ----
    typingHistoryDebounceTimer: null,

    // ---- 拖拽（查找替换弹窗）----
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    isResizing: false,
    resizeDirection: null,
    resizeStartX: 0,
    resizeStartY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,

    // ---- 焦点 ----
    lastFocusedElement: null,

    // ---- 数据库 ----
    autoSaveDB: null,

    // ---- Worker（查找替换搜索）----
    highlightWorker: null,
    highlightShadowRoot: null,
    highlightPreElement: null,
    workerMessageIdCounter: 0,
    workerCallbacksMap: new Map(),

    // ---- 折叠 ----
    foldedRanges: [],
    foldedRangesVersion: 0,

    // ---- Java 运行 ----
    isRunning: false,
    outputPanelOpen: false,
    outputPanelHeight: 200,
    runAbortController: null,

    // ---- 编码 ----
    currentEncoding: 'auto',
    currentFileEncoding: 'auto',

    // ---- 文件名 ----
    currentFileName: '在线代码编辑器',

    // ---- Java 版本 ----
    javaVersion: '21.0.2',

    // ---- 每语言独立后缀 ----
    // 结构：{ js: 'js', html: 'html', css: 'css', python: 'py', java: 'java', txt: '' }
    // 初始化时从 localStorage 恢复，切换语言时读写，修改后整体持久化。
    languageExtensionMap: {},

    // ---- TXT 自由模式下的后缀历史（本次新增）----
    // 结构：string[]，按 MRU 顺序（最近加入的在最前）。
    // 用途：TXT 模式点击后缀输入框时下拉显示历史，供快速选择。
    // 生命周期：
    //   · 初始化：file-io.js 的 loadTxtExtensionHistory 从 localStorage 恢复；
    //   · 添加：commitFileExtensionValue 校验通过时 addTxtExtensionHistoryItem；
    //   · 删除：下拉项 × 按钮触发 removeTxtExtensionHistoryItem；
    //   · 持久化：每次变更后写入 STORAGE_KEYS.TXT_EXTENSION_HISTORY。
    txtExtensionHistory: [],

    // ---- 内部编辑器更新标志 ----
    internalEditorUpdate: false,

    // ---- 设置导入后跳过 beforeunload 未保存检查 ----
    skipBeforeUnload: false,
    skipBeforeUnloadExpiresAt: 0
};