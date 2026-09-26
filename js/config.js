// filename: js/config.js
/**
 * ============================================================================
 * config.js — 常量、默认值、语言与编码定义
 * ============================================================================
 *
 * 【本次重构】
 *   新增 ENCODING_LONG_DESCRIPTIONS 常量。
 *
 *   背景：
 *     ENCODING_DISPLAY_NAMES 中的 'ansi' 显示名是 "ANSI (系统默认)"。
 *     这是一个来自微软的历史术语，"系统默认"具体指什么编码，
 *     取决于操作系统与区域设置：
 *       · 简体中文 Windows → GBK（代码页 936）
 *       · 繁体中文 Windows → Big5（代码页 950）
 *       · 日文 Windows     → Shift-JIS（代码页 932）
 *       · 西欧 Windows     → Windows-1252
 *       · macOS / Linux    → 通常为 UTF-8
 *
 *     浏览器沙箱无法探测操作系统 ANSI 代码页，本编辑器在实现上
 *     做了务实取舍：优先 GBK，不支持时回退纯 ASCII。这对简体中文
 *     用户完全等价于"系统默认"，但对其他语言环境用户存在语义偏差。
 *
 *   目的：
 *     把上述取舍显式化，让用户在 UI 中随时能看到每种编码的真实含义：
 *       · index.html 中编码下拉 option 的 title 属性；
 *       · encoding.js 中编码切换后 Toast 的详细说明；
 *       · file-io.js 中导入 / 导出时对实际使用编码的提示。
 *
 *   不改变 ENCODING_DISPLAY_NAMES 的现有值（状态栏 / 下拉可见文案
 *   保持简短），仅新增一份详细描述供悬停 / Toast 使用。
 *
 *   其余常量、存储键、语言定义完全保持原样。
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
 * Python 允许在 py / pyw 之间切换，也允许自由输入其他后缀。
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
 * Python 预设 ['py', 'pyw']：
 *   · .py  —— 常规源码
 *   · .pyw —— Windows GUI 程序（用 pythonw.exe 运行，不弹控制台）
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
 * 编码显示名（简短，用于状态栏 / 下拉可见文案）。
 *
 * 6 种编码的语义：
 *   · 'auto'          —— 自动检测（导入时按 BOM / 扩展名 / UTF-8 有效性判定）
 *   · 'utf-8'         —— 现代跨平台首选
 *   · 'utf-8-bom'     —— UTF-8 + 3 字节 BOM（Windows 记事本兼容）
 *   · 'ansi'          —— 系统默认 ANSI：简中 Windows 上即 GBK；
 *                        GBK 不可用时回退 ASCII（保底不崩溃）
 *   · 'gbk'           —— 明确指定 GBK；不支持时硬报错，由调用方提示
 *   · 'ascii'         —— 纯 ASCII：非 ASCII 字符替换为 '?'
 *
 * 注意：'ansi' 显示名保持 "ANSI (系统默认)" 简短形式，
 *       详细语义见下方的 ENCODING_LONG_DESCRIPTIONS。
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
 * 编码详细描述（长文案，用于：
 *   · index.html 编码下拉 option 的 title 属性；
 *   · encoding.js 编码切换后 Toast 的详细说明；
 *   · 将来可能出现的帮助面板 / 悬停提示。
 *
 * 每一句都说明"这个编码在当前环境下的实际行为"，避免用户
 * 把"系统默认"理解成当前系统的真实代码页。
 *
 * 措辞原则：
 *   · 不承诺超出实现能力的语义（例如 ANSI 无法真实探测系统代码页）；
 *   · 明确失败行为（GBK 不支持时硬报错 / ANSI 不支持时回退 ASCII）；
 *   · 说明字符串来源（RFC 标准 / 微软历史术语 / 中国国家标准）。
 */
export const ENCODING_LONG_DESCRIPTIONS = Object.freeze({
    'auto':
        '导入时按 BOM、扩展名、UTF-8 有效性自动检测；' +
        '导出时按文件扩展名推荐（.bat/.cmd 使用 ANSI，其他使用 UTF-8）',
    'utf-8':
        '现代跨平台首选，符合 RFC 3629 标准；' +
        '几乎所有现代编辑器与操作系统默认使用',
    'utf-8-bom':
        'UTF-8 + 3 字节 BOM（EF BB BF），' +
        '兼容 Windows 记事本等要求 BOM 的场景',
    'ansi':
        '微软历史术语，指"操作系统默认代码页"；' +
        '本编辑器实现策略：简体中文 Windows 上等价 GBK；' +
        '浏览器不支持 GBK 时回退纯 ASCII（非 ASCII 字符替换为 ?）',
    'gbk':
        '中国国家标准 GBK（GB2312 的扩展），' +
        '覆盖中日韩汉字与全角标点；' +
        '当前浏览器不支持 GBK 时硬报错，由调用方提示用户改用其他编码',
    'ascii':
        '纯 ASCII（ANSI X3.4 标准），仅支持 0x00-0x7F；' +
        '非 ASCII 字符（中文、全角标点、BMP 外字符）一律替换为 ?'
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