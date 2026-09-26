// filename: js/config.js
/**
 * ============================================================================
 * config.js — 常量、默认值、语言与编码定义
 * ============================================================================
 *
 * 【本次重构】
 *   1. 后缀系统从"预设 + 全局历史"重构为"权威合法集合"：
 *
 *      原模型的问题：
 *        · LANGUAGE_PRESET_EXTENSIONS 只表达"预设候选"，
 *          真正的下拉数据源还要合并 FILE_EXTENSION_HISTORY（全局）；
 *        · FILE_EXTENSION_HISTORY 无语言隔离，
 *          TXT 输入的 py 会污染 HTML / JS / CSS / Java 的下拉；
 *        · 缺少"语言的合法后缀集合"这一权威概念，
 *          导致"Python 下拉出现 bat / html"这类越界。
 *
 *      新模型：
 *        · LANGUAGE_VALID_EXTENSIONS 是唯一权威来源，
 *          显式声明每种语言允许的后缀集合；
 *        · 空数组（当前仅 TXT）= 自由输入模式，
 *          由 file-io.js 的跨语言占用校验兜底；
 *        · 废除 FILE_EXTENSION_HISTORY（仅保留存储键定义用于一次性清理）；
 *        · AUTO_EXTENSION_BY_LANGUAGE 从 LANGUAGE_VALID_EXTENSIONS 派生，
 *          消除两处漂移风险。
 *
 *   2. 删除的常量：
 *      · LANGUAGE_PRESET_EXTENSIONS     —— 被 LANGUAGE_VALID_EXTENSIONS 取代
 *      · LANGUAGE_ALLOW_CUSTOM_EXTENSION —— 由"集合是否为空"代替判断
 *      · LANGUAGE_SHOW_HISTORY_DROPDOWN —— 同上
 *
 *   3. 保留的常量（行为不变）：
 *      · LANGUAGE_EXTENSIONS  —— 下载时的兜底默认后缀
 *      · STORAGE_KEYS.FILE_EXTENSION_HISTORY —— 保留定义，仅供清理
 *      · LANGUAGE_DISPLAY_NAMES / EXTENSION_LANGUAGE_MAP /
 *        VALID_TEXT_FILE_EXTENSION_REGEX 等
 *
 *   4. 其余常量、存储键、编码定义、主题定义完全保持原样。
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
    // 保留常量为兼容性使用；新模型不再限制历史数量，
    // 但设置校验器与旧数据清理仍可能引用此常量。
    FILE_EXTENSION_HISTORY_MAX: 20,

    // ---- 设置导出 / 导入 ----
    SETTINGS_FILE_MAX_SIZE: 5 * 1024 * 1024,
    SETTINGS_RELOAD_DELAY_MS: 1500,
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
    // FILE_EXTENSION_HISTORY 保留键定义：
    //   · 新版后缀系统不再使用此键；
    //   · file-io.js 初始化时将其移除（一次性清理）；
    //   · settings-io.js 不再导出此键，也不再校验。
    FILE_EXTENSION_HISTORY: 'editor-file-extension-history-v8',
    LANGUAGE_EXTENSION_MAP: 'editor-language-extension-map-v9'
});

/**
 * 设置导出 / 导入的键全集。
 *
 * 有意排除的键：
 *   · CODE_CACHE              —— 编辑器代码内容，由自动保存机制独立管理
 *   · DIRTY_FLAG              —— 运行时脏标记，页面重启后即清
 *   · FILE_EXTENSION          —— v8.4.1 历史遗留键，仅在初始化时迁移后清理
 *   · FILE_EXTENSION_HISTORY  —— 新版后缀系统已废弃，仅初始化时清理
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

/**
 * 下载时的兜底默认后缀。
 *
 * 与 AUTO_EXTENSION_BY_LANGUAGE 的差异：
 *   · AUTO_EXTENSION_BY_LANGUAGE 描述"输入框默认显示什么"，
 *     TXT 模式下为空（用户自行输入）；
 *   · LANGUAGE_EXTENSIONS 描述"下载时若输入框为空用什么兜底"，
 *     TXT 模式下用 'txt'。
 */
export const LANGUAGE_EXTENSIONS = Object.freeze({
    js: 'js',
    html: 'html',
    css: 'css',
    python: 'py',
    java: 'java',
    txt: 'txt'
});

/**
 * 每种语言的合法后缀集合（唯一权威来源）。
 *
 * 语义：
 *   · 非空数组 → 受约束模式：输入框 readOnly，下拉仅显示此集合；
 *   · 空数组   → 自由模式：输入框可编辑，但禁止输入被其他语言占用的后缀。
 *
 * 边界情况：
 *   · 集合顺序有意义，第 0 项是切换语言时的默认后缀；
 *   · 'txt' 空集合是当前唯一的自由模式；
 *   · 若未来某语言也需自由模式，将其设为 [] 即可，无需改逻辑。
 *
 * 与 EXTENSION_LANGUAGE_MAP 的区别：
 *   · EXTENSION_LANGUAGE_MAP 解决"导入文件用什么语言高亮"；
 *   · LANGUAGE_VALID_EXTENSIONS 解决"这种语言可以导出为哪些后缀"。
 *   两者不能互相推导，因为存在"高亮借用"（如 .json → js、.md → html）。
 */
export const LANGUAGE_VALID_EXTENSIONS = Object.freeze({
    js: Object.freeze(['js', 'mjs', 'cjs']),
    html: Object.freeze(['html', 'htm']),
    css: Object.freeze(['css']),
    python: Object.freeze(['py', 'pyw']),
    java: Object.freeze(['java']),
    txt: Object.freeze([])
});

/**
 * 每语言切换时的默认后缀（从 LANGUAGE_VALID_EXTENSIONS 派生）。
 *
 * 派生规则：
 *   · 集合非空 → 取第 0 项；
 *   · 集合为空（TXT） → 空字符串（由用户自定义）。
 *
 * 派生而非硬编码，保证"合法集合变了、默认值也同步变"。
 */
export const AUTO_EXTENSION_BY_LANGUAGE = (function deriveAutoExtensionMap() {
    const derivedMap = {};
    const languageKeys = Object.keys(LANGUAGE_VALID_EXTENSIONS);
    for (let index = 0; index < languageKeys.length; index++) {
        const languageKey = languageKeys[index];
        const validList = LANGUAGE_VALID_EXTENSIONS[languageKey];
        derivedMap[languageKey] = validList.length > 0 ? validList[0] : '';
    }
    return Object.freeze(derivedMap);
})();

/**
 * 编码显示名（简短，用于状态栏 / 下拉可见文案）。
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
 * 编码详细描述（长文案，用于下拉 option 的 title 属性）。
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
 * 仅在"当前编码为 auto"时生效，用户显式选择编码时不覆盖。
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
  · 后缀可自由输入（但不能是其他语言的后缀）

Hello, World!`
});

/**
 * 主题循环顺序。
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

/**
 * 扩展名 → 语言（用于导入时的语言识别 / 高亮选择）。
 *
 * 语义说明：
 *   · 本映射用于"导入这个文件用什么语言高亮"，不是"这种语言可以导出为哪些后缀"；
 *   · 存在"高亮借用"（.json → js、.md → html、.bat → txt），
 *     这些后缀不会出现在对应语言的 LANGUAGE_VALID_EXTENSIONS 中；
 *   · 两套数据互不干扰，职责严格分离。
 */
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