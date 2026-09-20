// filename: js/state.js
/**
 * ============================================================================
 * state.js — 全局状态对象
 * ============================================================================
 *
 * 【本次更新】
 *   恢复被误覆盖的文件内容。
 *   本文件是 22 个 JS 模块的共同底层依赖，一旦损坏会导致
 *   main.js 的 import 解析失败，整个 ES Module 图崩溃，页面白屏。
 *
 * 【字段说明】
 *   · 语言 / 内容：currentLanguage / codeModified / originalCode
 *   · 搜索：searchMatchIndex / lastSearchMatches
 *   · 外观：currentFontSize / wordWrapEnabled / indentSize / indentCharacter /
 *          theme / highlightEnabled / userForcedHighlight
 *   · 大文件阈值：largeFileThreshold / absoluteFileSizeLimit /
 *                maxPasteSize / largeFileActive
 *   · 定时器：autoSaveTimer / updateTimer / toastTimer /
 *            copyRestoreTimer / typingHistoryDebounceTimer
 *   · 拖拽与调整大小：isDragging / dragOffsetX / dragOffsetY /
 *                    isResizing / resizeDirection / resizeStartX /
 *                    resizeStartY / startWidth / startHeight /
 *                    startLeft / startTop
 *   · 焦点：lastFocusedElement
 *   · 数据库：autoSaveDB
 *   · Worker：highlightWorker / highlightShadowRoot /
 *             highlightPreElement / workerMessageIdCounter /
 *             workerCallbacksMap
 *   · 折叠：foldedRanges / foldedRangesVersion
 *   · Java 运行：isRunning / outputPanelOpen / outputPanelHeight /
 *               runAbortController
 *   · 编码：currentEncoding / currentFileEncoding
 *   · 文件名：currentFileName
 *   · Java 版本：javaVersion
 *   · 每语言后缀映射：languageExtensionMap
 *   · 内部标志：internalEditorUpdate
 *   · 设置导入后跳过 beforeunload：skipBeforeUnload /
 *                                  skipBeforeUnloadExpiresAt
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
    // 修复"普通输入无法撤销"：input 事件触发后 250ms 才 pushState，
    // 打字过程中连续按键被合并为一次历史快照，避免每次按键都读
    // textarea.value（O(n)）。
    // Ctrl+Z / 撤销按钮 / 点击撤销前会先 flush 该定时器。
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
    // 折叠范围版本号：foldedRanges 每次变更时自增。
    // folding.js 与 highlight.js 的折叠行集合缓存依赖此版本号判断失效。
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

    // ---- 内部编辑器更新标志 ----
    internalEditorUpdate: false,

    // ---- 设置导入后跳过 beforeunload 未保存检查 ----
    // 双字段模式：
    //   · skipBeforeUnload          —— 布尔标志，表示"本次导航应放行"
    //   · skipBeforeUnloadExpiresAt —— 过期时间戳（Date.now() + TTL，毫秒）
    //
    // 流程：
    //   1. 用户在 settings-io.js 的覆盖确认中明确同意丢弃未保存代码；
    //   2. settings-io.js 写入成功后同时置位布尔标志与过期时间戳：
    //        EditorState.skipBeforeUnload = true;
    //        EditorState.skipBeforeUnloadExpiresAt =
    //            Date.now() + CONFIG.SETTINGS_SKIP_BEFOREUNLOAD_TTL_MS;
    //   3. ui.js 的 beforeunload 处理器读取：
    //        - 若标志为 true 且过期时间戳仍大于当前时间 → 直接放行；
    //        - 若已过期 → 重置双字段，继续走常规"未保存代码"检查路径。
    //
    // 该双字段模式确保即使 location.reload() 因某种原因未执行，
    // 标志也不会永久残留，而是在 TTL 之后自动失效。
    // 页面刷新后两个字段自然重置（不持久化到 localStorage）。
    skipBeforeUnload: false,
    skipBeforeUnloadExpiresAt: 0
};