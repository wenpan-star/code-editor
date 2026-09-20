// filename: js/config.js
/**
 * ============================================================================
 * config.js — 常量、默认值、语言与编码定义
 * ============================================================================
 *
 * 集中管理应用常量与默认值，无 DOM 依赖、无副作用。
 *
 * 【本次更新】
 *   移除 THEME_ICONS 常量。
 *
 *   原 THEME_ICONS 将四个主题映射到 Emoji（☀️ / 🌙 / 🌊 / 🧁），
 *   由 ui.js 的 setTheme 通过 DOM.btnTheme.textContent = THEME_ICONS[theme]
 *   更新主题按钮。
 *
 *   本次 UI 美化将主题按钮从 Emoji 文本升级为 4 个内联 SVG：
 *     · 太阳（dark）
 *     · 月亮（light）
 *     · 波浪（ink）
 *     · 蛋糕（cream）
 *   由 CSS 通过 html[data-theme="..."] 属性选择器控制显示哪一个。
 *   JS 只需切换 documentElement 上的 data-theme 属性，无需操作图标内容。
 *
 *   ui.js 已同步移除对 THEME_ICONS 的 import；
 *   本文件移除该常量定义，保持配置模块与运行时无死代码引用。
 *
 * 【保留】
 *   · THEME_SEQUENCE —— 主题循环顺序（ui.js 的 cycleTheme 仍在使用）
 *   · 其余常量不变
 * ============================================================================
 */

export const CONFIG = Object.freeze({
    APP_VERSION: '8.7.2',

    // ---- 大文件阈值 ----
    LARGE_FILE_THRESHOLD: 300 * 1024,
    ABSOLUTE_FILE_SIZE_LIMIT: 2 * 1024 * 1024,
    MAX_PASTE_SIZE: 1.5 * 1024 * 1024,

    // ---- 历史记录 ----
    MAX_HISTORY: 200,
    LARGE_FILE_MAX_HISTORY: 30,

    // ---- 自动保存延迟 ----
    AUTOSAVE_DELAY_NORMAL: 800,
    AUTOSAVE_DELAY_LARGE_FILE: 2000,
    AUTOSAVE_LOCAL_STORAGE_MAX_LENGTH: 500000,

    // ---- 搜索 ----
    SEARCH_TIMEOUT_MS: 200,
    SEARCH_TIMEOUT_GRACE_MS: 100,

    // ---- 匹配计数防抖 ----
    MATCH_COUNT_DEBOUNCE_MS: 150,

    // ---- Java 运行 ----
    JAVA_RUN_TIMEOUT_MS: 30000,

    // ---- Toast ----
    TOAST_DURATION_MS: 2500,

    // ---- 自定义文件后缀 ----
    FILE_EXTENSION_MAX_LENGTH: 12,
    FILE_EXTENSION_HISTORY_MAX: 20,

    // ---- 设置导出 / 导入 ----
    SETTINGS_FILE_MAX_SIZE: 5 * 1024 * 1024,
    SETTINGS_RELOAD_DELAY_MS: 1500,
    // skipBeforeUnload 标志的有效期（毫秒）。
    // 设置导入成功后由 settings-io.js 同时置位布尔标志与过期时间戳
    // （Date.now() + TTL），ui.js 的 beforeunload 处理器据此判断是否放行。
    // TTL 远大于 SETTINGS_RELOAD_DELAY_MS，保证 location.reload() 有充足
    // 窗口；若 reload() 因某种原因未执行，标志也会在 TTL 后自动失效，
    // 避免永久抑制未保存代码提示。
    SETTINGS_SKIP_BEFOREUNLOAD_TTL_MS: 10000
});

export const STORAGE_KEYS = Object.freeze({
    CODE_CACHE: 'editor-code-cache-v6',
    THEME: 'editor-theme-v6',
    INDENT: 'editor-indent-v6',
    FONT_SIZE: 'editor-font-size-v6',
    LANGUAGE: 'editor-language-v6',
    WRAP_ENABLED: 'editor-wrap-enabled-v6',
    REPLACE_FIND: 'editor-replace-find-v6',
    REPLACE_WITH: 'editor-replace-with-v6',
    REPLACE_CASE_SENSITIVE: 'editor-replace-case-sensitive-v6',
    REPLACE_WHOLE_WORD: 'editor-replace-whole-word-v6',
    REPLACE_USE_REGEX: 'editor-replace-use-regex-v6',
    REPLACE_MODAL_POSITION: 'editor-replace-modal-position-v6',
    REPLACE_MODAL_SIZE: 'editor-replace-modal-size-v6',
    HIGHLIGHT_ENABLED: 'editor-highlight-enabled-v6',
    DIRTY_FLAG: 'editor-dirty-flag',
    FOLDED_RANGES: 'editor-folded-ranges-v6',
    STDIN_CACHE: 'editor-stdin-cache-v6',
    ENCODING: 'editor-encoding-v7',
    JAVA_VERSION: 'editor-java-version-v7',
    LAST_DOWNLOAD_FILENAME: 'editor-last-download-filename',
    REPLACE_FIND_MANUAL_HEIGHT: 'replace-find-manual-height',
    REPLACE_WITH_MANUAL_HEIGHT: 'replace-with-manual-height',
    FILE_EXTENSION: 'editor-file-extension-v8',
    FILE_EXTENSION_HISTORY: 'editor-file-extension-history-v8',
    LANGUAGE_EXTENSION_MAP: 'editor-language-extension-map-v9'
});

/**
 * 设置导出 / 导入的键全集。
 *
 * 有意排除的键：
 *   · CODE_CACHE     —— 编辑器代码内容，由自动保存机制独立管理
 *   · DIRTY_FLAG     —— 运行时脏标记，页面重启后即清
 *   · FILE_EXTENSION —— v8.4.1 历史遗留键，仅在初始化时迁移后清理
 *
 * 新增持久化键时，请同步追加到本列表，并在 settings-io.js 的
 * SETTINGS_VALUE_VALIDATORS 中补充相应校验规则。
 */
export const SETTINGS_EXPORTABLE_KEYS = Object.freeze([
    STORAGE_KEYS.THEME,
    STORAGE_KEYS.INDENT,
    STORAGE_KEYS.FONT_SIZE,
    STORAGE_KEYS.LANGUAGE,
    STORAGE_KEYS.WRAP_ENABLED,
    STORAGE_KEYS.HIGHLIGHT_ENABLED,
    STORAGE_KEYS.ENCODING,
    STORAGE_KEYS.JAVA_VERSION,
    STORAGE_KEYS.FOLDED_RANGES,
    STORAGE_KEYS.STDIN_CACHE,
    STORAGE_KEYS.REPLACE_FIND,
    STORAGE_KEYS.REPLACE_WITH,
    STORAGE_KEYS.REPLACE_CASE_SENSITIVE,
    STORAGE_KEYS.REPLACE_WHOLE_WORD,
    STORAGE_KEYS.REPLACE_USE_REGEX,
    STORAGE_KEYS.REPLACE_MODAL_POSITION,
    STORAGE_KEYS.REPLACE_MODAL_SIZE,
    STORAGE_KEYS.REPLACE_FIND_MANUAL_HEIGHT,
    STORAGE_KEYS.REPLACE_WITH_MANUAL_HEIGHT,
    STORAGE_KEYS.LAST_DOWNLOAD_FILENAME,
    STORAGE_KEYS.FILE_EXTENSION_HISTORY,
    STORAGE_KEYS.LANGUAGE_EXTENSION_MAP
]);

export const INDEXED_DB = Object.freeze({
    NAME: 'editor-autosave-db',
    STORE_NAME: 'code-store',
    KEY: 'latest-code',
    VERSION: 1
});

export const DIR_HANDLE_DB = Object.freeze({
    NAME: 'code-editor-fs',
    STORE_NAME: 'handles',
    KEY: 'save-directory',
    VERSION: 1
});

export const LANGUAGE_DISPLAY_NAMES = Object.freeze({
    js: 'JavaScript',
    html: 'HTML',
    css: 'CSS',
    python: 'Python',
    java: 'Java',
    txt: 'Plain Text'
});

export const LANGUAGE_EXTENSIONS = Object.freeze({
    js: 'js',
    html: 'html',
    css: 'css',
    python: 'py',
    java: 'java',
    txt: 'txt'
});

export const AUTO_EXTENSION_BY_LANGUAGE = Object.freeze({
    js: 'js',
    html: 'html',
    css: 'css',
    python: 'py',
    java: 'java',
    txt: ''
});

/**
 * 每语言是否允许用户自定义后缀。
 *
 * Python 由 false 改为 true —— 允许在 py / pyw 之间切换，
 * 也允许自由输入其他后缀（例如 .pyt 等个人约定）。
 */
export const LANGUAGE_ALLOW_CUSTOM_EXTENSION = Object.freeze({
    js: false,
    html: true,
    css: false,
    python: true,
    java: false,
    txt: true
});

/**
 * 每语言是否显示历史后缀下拉。
 *
 * Python 由 false 改为 true —— 显示下拉，允许一键切换 py / pyw。
 */
export const LANGUAGE_SHOW_HISTORY_DROPDOWN = Object.freeze({
    js: false,
    html: true,
    css: false,
    python: true,
    java: false,
    txt: true
});

/**
 * 每语言在下拉中「预设」的候选后缀。
 *
 * 下拉渲染时会把预设候选项与历史记录合并（预设优先，去重后展示）。
 * 目的：让用户首次进入某语言时就能看到可选值，无需先手动输入一次。
 *
 * 说明：
 *   · Python 预设 ['py', 'pyw']，两者都是标准 Python 源码后缀：
 *       - .py  —— 常规源码
 *       - .pyw —— Windows GUI 程序（用 pythonw.exe 运行，不弹控制台）
 *   · 其他语言暂不预设（后续如有需要，加到此即可，无需改 file-io.js）
 */
export const LANGUAGE_PRESET_EXTENSIONS = Object.freeze({
    js: [],
    html: [],
    css: [],
    python: ['py', 'pyw'],
    java: [],
    txt: []
});

/**
 * 编码显示名。
 *
 * 6 种编码的语义：
 *   · 'auto'          —— 自动检测（导入时按 BOM / 扩展名 / UTF-8 有效性判定）
 *   · 'utf-8'         —— 现代跨平台首选
 *   · 'utf-8-bom'     —— UTF-8 + 3 字节 BOM（Windows 记事本兼容）
 *   · 'ansi'          —— 系统默认 ANSI：简中 Windows 上即 GBK；
 *                        GBK 不可用时回退 ASCII（保底不崩溃）
 *   · 'gbk'           —— 明确指定 GBK；不支持时硬报错，由调用方提示
 *   · 'ascii'         —— 纯 ASCII：非 ASCII 字符替换为 '?'
 */
export const ENCODING_DISPLAY_NAMES = Object.freeze({
    'auto': '自动检测',
    'utf-8': 'UTF-8',
    'utf-8-bom': 'UTF-8 BOM',
    'ansi': 'ANSI (系统默认)',
    'gbk': 'GBK (中文 ANSI)',
    'ascii': '纯 ASCII'
});

/**
 * 扩展名 → 默认保存编码。
 *
 * 仅在"当前编码为 auto"时生效，用户显式选择编码时不覆盖。
 *
 * 映射依据：
 *   · .py / .spec / .md / .json / .html / .htm —— UTF-8
 *     Python 3 官方推荐 UTF-8；.spec 常为 PyInstaller 配置；
 *     .md / .json / .html 是跨平台 Web / 文档格式，UTF-8 是现代默认。
 *   · .bat / .cmd —— ANSI
 *     Windows 记事本"另存为 ANSI"在简体中文系统即 GBK。
 *     用 UTF-8 保存的 .bat 在 cmd.exe 中执行时中文会乱码。
 *     选择 'ansi' 而非 'gbk' 的语义优势：明确表达"用系统默认"，
 *     在非简中环境下自动回退，符合用户直觉。
 *
 * .pyw 未单独配置，会走 handleDownloadClick 的 || 'utf-8' 兜底，
 * 与 .py 保持一致（UTF-8）。
 */
export const EXTENSION_DEFAULT_ENCODING = Object.freeze({
    'py': 'utf-8',
    'spec': 'utf-8',
    'md': 'utf-8',
    'json': 'utf-8',
    'html': 'utf-8',
    'htm': 'utf-8',
    'bat': 'ansi',
    'cmd': 'ansi'
});

export const DEFAULT_CODE_BY_LANGUAGE = Object.freeze({
    js: `// 🎉 欢迎使用在线代码编辑器！
function fibonacci(n) {
  if (n <= 1) return n;
  const memo = [0, 1];
  for (let i = 2; i <= n; i++) {
    memo[i] = memo[i - 1] + memo[i - 2];
  }
  return memo[n];
}
console.log('Fibonacci(10) =', fibonacci(10));
console.log('Fibonacci(20) =', fibonacci(20));`,
    python: `# 🐍 Python 示例
def fibonacci(n):
    if n <= 1:
        return n
    memo = [0, 1]
    for i in range(2, n + 1):
        memo.append(memo[i-1] + memo[i-2])
    return memo[n]

print(f"Fibonacci(10) = {fibonacci(10)}")
print(f"Fibonacci(20) = {fibonacci(20)}")`,
    html: `<!-- 🌐 HTML 示例 -->
<!DOCTYPE html>
<html>
<head>
  <title>示例页面</title>
</head>
<body>
  <h1>Hello, World!</h1>
  <p>这是一个 HTML 示例</p>
</body>
</html>`,
    css: `/* 🎨 CSS 示例 */
body {
  font-family: 'Segoe UI', sans-serif;
  background: linear-gradient(135deg, #667eea, #764ba2);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  background: #fff;
  border-radius: 16px;
  padding: 40px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}`,
    java: `// ☕ Java 示例
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, Java!");
        
        int n = 10;
        System.out.println("Fibonacci(" + n + ") = " + fibonacci(n));
        
        int[] numbers = {5, 2, 8, 1, 9};
        java.util.Arrays.sort(numbers);
        System.out.print("排序后: ");
        for (int num : numbers) {
            System.out.print(num + " ");
        }
        System.out.println();
    }
    
    public static long fibonacci(int n) {
        if (n <= 1) return n;
        long[] memo = new long[n + 1];
        memo[0] = 0;
        memo[1] = 1;
        for (int i = 2; i <= n; i++) {
            memo[i] = memo[i - 1] + memo[i - 2];
        }
        return memo[n];
    }
}`,
    txt: `这是一段纯文本示例。

在 TXT 模式下：
  · 无语法高亮
  · 无 Java 运行支持
  · 后缀可自由输入（会出现在下拉历史中）

Hello, World!`
});

/**
 * 主题循环顺序。
 *
 * ui.js 的 cycleTheme 按此顺序切换：
 *   dark → light → ink → cream → dark → ...
 *
 * 主题图标（太阳 / 月亮 / 波浪 / 蛋糕）由 CSS 通过
 * html[data-theme="..."] 属性选择器控制显示，无对应的 JS 常量。
 */
export const THEME_SEQUENCE = Object.freeze(['dark', 'light', 'ink', 'cream']);

export const MIME_TYPES = Object.freeze({
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    py: 'text/x-python',
    java: 'text/x-java-source',
    txt: 'text/plain'
});

export const EXTENSION_LANGUAGE_MAP = Object.freeze({
    js: 'js',
    ts: 'js',
    jsx: 'js',
    html: 'html',
    css: 'css',
    py: 'python',
    pyw: 'python',
    java: 'java',
    json: 'js',
    xml: 'html',
    md: 'html',
    txt: 'txt',
    spec: 'python',
    bat: 'txt',
    cmd: 'txt'
});

export const VALID_TEXT_FILE_EXTENSION_REGEX = /\.(js|ts|jsx|html|css|py|pyw|java|txt|json|md|xml|spec|bat|cmd)$/i;