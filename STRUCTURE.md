# filename: STRUCTURE.md
# 项目目录结构

    code-editor/
    ├── index.html
    ├── README.md
    ├── STRUCTURE.md
    ├── 完整目录树.txt
    ├── css/
    │   └── styles.css                ← 全站样式（含四主题变量 / 组件 / 响应式）
    └── js/
        ├── main.js                   ← 引导入口（script type="module"）
        ├── config.js                 ← 常量 / 存储键 / 编码映射 / 后缀合法集合 / 设置导出键集
        ├── util.js                   ← 通用工具 / 正则安全（单一事实来源）
        ├── state.js                  ← EditorState 全局状态
        ├── dom.js                    ← DOM 元素引用
        ├── toast.js                  ← Toast 提示
        ├── storage.js                ← localStorage / IndexedDB / 目录句柄底层
        ├── history.js                ← HistoryManager 撤销/重做
        ├── highlight.js              ← 语法高亮 + Shadow DOM
        ├── folding.js                ← 代码折叠 + 折叠范围校验
        ├── line-numbers.js           ← 行号渲染 + 光标 + scrollToCursor
        ├── encoding.js               ← 编码统一入口（UTF-8 / BOM / ANSI / ASCII）
        ├── gbk-codec.js              ← GBK 编解码（独立生命周期：探测/构建/缓存/预热）
        ├── search.js                 ← 查找替换 + 搜索 Worker
        ├── editor-api.js             ← 统一编辑入口（循环依赖解耦）
        ├── editor.js                 ← 编辑器核心（键盘 / 缩进 / 注释 / 粘贴）
        ├── file-io.js                ← 文件内容 I/O（导入 / 下载 / 拖拽 / 后缀约束）
        ├── directory-io.js           ← 目录 / 保存位置管理（更改 / 打开 / Picker 封装）
        ├── output.js                 ← 输出面板
        ├── java-runner.js            ← Java 编译运行（Piston API）
        ├── ui.js                     ← 主 UI 事件 / 快捷键 / 弹窗
        └── settings-io.js            ← 设置导出 / 导入

    （共 22 个 JS 文件）

## 模块职责边界

### 存储与目录分层

    storage.js        底层持久化原语（IndexedDB / localStorage / 目录句柄存储）
        ↑
    directory-io.js   目录选择与生命周期（Picker 封装 / 权限 / startIn 记忆）
        ↑
    file-io.js        文件内容 I/O（读写文本 / 编码转换 / 拖拽 / 后缀约束）

### 编码模块分层

    encoding.js       统一入口 + 静态映射编码（UTF-8 / BOM / ANSI / ASCII）
        ↑ 委托
    gbk-codec.js      GBK 编解码（动态构建映射表 / 支持性探测 / 后台预热）

### 后缀系统分层

    config.js
      └── LANGUAGE_VALID_EXTENSIONS       ← 每语言合法后缀集合（唯一权威来源）
              ↓
    file-io.js
      ├── ALL_RESERVED_EXTENSIONS         ← 所有非空集合的并集（预计算 Set）
      ├── isValidExtensionForLanguage     ← 单语言集合成员判断
      ├── isExtensionUsedByOtherLanguage  ← 跨语言占用判断（O(1)）
      ├── isExtensionAllowedForLanguage   ← 综合判定（区分受约束/自由模式）
      ├── resolveExtensionForLanguage     ← 记忆恢复统一入口（含非法值回退）
      └── commitFileExtensionValue        ← 提交统一入口（含非法值提示）

### 正则安全单一事实来源

    util.js
      └── DANGEROUS_REGEX_PATTERN_SOURCES   ← 19 条危险模式源字符串（唯一权威）
              ├── util.js 内部 → DANGEROUS_REGEX_PATTERNS（主线程检测）
              └── search.js Worker 脚本 → 动态内联 new RegExp(...) 数组

### 数据流依赖（单向无环）

    main.js
      ├── editor-api.js         （统一编辑入口）
      ├── file-io.js            → directory-io.js → storage.js
      ├── settings-io.js        → config.js
      ├── ui.js                 → editor-api.js / search.js
      └── highlight.js          ← main.js（注入调度回调）

## 后缀系统

### 每语言合法后缀集合（LANGUAGE_VALID_EXTENSIONS）

| 语言 | 合法后缀集合 | 模式 |
|---|---|---|
| JavaScript | `['js', 'mjs', 'cjs']` | 受约束 |
| HTML | `['html', 'htm']` | 受约束 |
| CSS | `['css']` | 受约束 |
| Python | `['py', 'pyw']` | 受约束 |
| Java | `['java']` | 受约束 |
| Plain Text | `[]` | 自由输入 |

### 两种模式

| 模式 | 触发条件 | 输入框 | 下拉 | 校验 |
|---|---|---|---|---|
| 受约束模式 | 集合非空 | `readOnly = true` | 显示合法集合 | 严格集合成员判断 |
| 自由模式 | 集合为空（仅 TXT） | `readOnly = false` | 不显示 | 跨语言占用判断 |

### 三概念分离（避免混淆）

| 概念 | 数据源 | 用途 |
|---|---|---|
| **后缀 → 语言** | `EXTENSION_LANGUAGE_MAP` | 导入文件时用什么语言高亮 |
| **语言 → 合法后缀集合** | `LANGUAGE_VALID_EXTENSIONS` | 导出时约束可选后缀 |
| **每语言当前后缀** | `EditorState.languageExtensionMap` | 用户选择记忆 |

**重要**：三者不能互相推导。例如 `.json → js` 只是"高亮借用"，`json` 不会出现在 `LANGUAGE_VALID_EXTENSIONS.js` 中。

### 记忆恢复流程

    updateFileExtensionForLanguage(language)
      ↓
    resolveExtensionForLanguage(language)
      ├── 读 EditorState.languageExtensionMap[language]
      ├── 若合法 → 返回记忆值
      └── 若非法（旧版遗留 / 跨语言）→ 返回 AUTO_EXTENSION_BY_LANGUAGE[language]
      ↓
    DOM.fileExtensionInput.value = 有效值
    DOM.fileExtensionInput.readOnly = (集合长度 > 0)

### 用户输入流程

    受约束模式（readOnly）：
      点击 → 显示下拉 → 点击项 → 写入 map → 隐藏下拉

    自由模式（TXT）：
      input → 净化显示，不写入 map（避免乐观写入非法值）
      change / Enter → commitFileExtensionValue
        ├── 合法 → 写入 map
        └── 非法 → 恢复上次有效值 + Toast 提示

### 导入文件行为

    loadFileIntoEditor(file)
      ↓
    EXTENSION_LANGUAGE_MAP[ext] → switchLanguage(language)
      ↓
    updateFileExtensionForLanguage(language)
      ↓
    resolveExtensionForLanguage(language)
      ↓
    · 导入不更新 languageExtensionMap
    · 理由：导入是"高亮选择"，不是"后缀选择"
    · 用户导入 .spec 时，Python 后缀记忆仍保持原值（如 py）

## 编码支持

| 编码 ID | 显示名 | 说明 |
|---|---|---|
| `auto` | 自动检测 | 导入按 BOM / 扩展名 / UTF-8 有效性判定 |
| `utf-8` | UTF-8 | 现代跨平台首选，符合 RFC 3629 标准 |
| `utf-8-bom` | UTF-8 BOM | 兼容 Windows 记事本等要求 BOM 的场景 |
| `ansi` | ANSI (系统默认) | 微软历史术语。本编辑器实现：简中 Windows 上等价 GBK；GBK 不可用时回退纯 ASCII |
| `gbk` | GBK (中文 ANSI) | 中国国家标准 GBK（GB2312 扩展）；浏览器不支持时硬报错 |
| `ascii` | 纯 ASCII | ANSI X3.4 标准，仅支持 0x00-0x7F；非 ASCII 替换为 `?` |

### 编码透明化

- `config.js` 导出 `ENCODING_LONG_DESCRIPTIONS`，为每种编码提供详细描述文案。
- `index.html` 中编码下拉每个 `<option>` 带 `title` 属性，直接引用上述描述。
- `encoding.js` 的 `bindEncodingSelectEvents` 在切换时通过 `buildEncodingSwitchToastMessage` 输出“当前环境实际使用 GBK / ASCII”等提示。
- `file-io.js` 的 `resolveEncodingDisplayName` 在导入 / 导出提示中显示“ANSI (实际 GBK)”或“ANSI (实际回退 ASCII)”。

### 扩展名 → 默认保存编码（仅当编码为 `auto` 时生效）

| 扩展名 | 默认编码 |
|---|---|
| `.py` / `.spec` / `.md` / `.json` / `.html` / `.htm` | UTF-8 |
| `.bat` / `.cmd` | ANSI（简中 Windows 上 = GBK） |
| 其他 | UTF-8 |

## 存储键清单

### 编辑器状态持久化

| 键 | 说明 |
|---|---|
| `editor-theme-v6` | 主题（dark / light / ink / cream） |
| `editor-indent-v6` | 缩进（size + character） |
| `editor-font-size-v6` | 编辑器字体大小 |
| `editor-language-v6` | 当前语言 |
| `editor-wrap-enabled-v6` | 自动换行开关 |
| `editor-highlight-enabled-v6` | 高亮开关 |
| `editor-encoding-v7` | 当前编码 |
| `editor-java-version-v7` | Java 版本 |
| `editor-folded-ranges-v6` | 折叠范围数组 |
| `editor-stdin-cache-v6` | stdin 缓存 |
| `editor-language-extension-map-v9` | 每语言后缀映射 |
| `editor-last-download-filename` | 上次下载文件名 |
| `editor-code-cache-v6` | 代码缓存（localStorage 兜底） |
| `editor-dirty-flag` | 异常关闭脏标记 |

### 已废弃 / 仅供清理

| 键 | 说明 |
|---|---|
| `editor-file-extension-v8` | v8.4.1 单一后缀键；初始化时迁移到 TXT 后清理 |
| `editor-file-extension-history-v8` | 旧版全局后缀历史；初始化时一次性清理，不再使用 |

### 查找替换

| 键 | 说明 |
|---|---|
| `editor-replace-find-v6` | 查找内容 |
| `editor-replace-with-v6` | 替换内容 |
| `editor-replace-case-sensitive-v6` | 区分大小写 |
| `editor-replace-whole-word-v6` | 全词匹配 |
| `editor-replace-use-regex-v6` | 正则开关 |
| `editor-replace-modal-position-v6` | 弹窗位置 |
| `editor-replace-modal-size-v6` | 弹窗尺寸 |
| `replace-find-manual-height` | 查找 textarea 手工高度 |
| `replace-with-manual-height` | 替换 textarea 手工高度 |

## 折叠校验流程

    main.js 初始化
      ├── loadFromLocalStorage(FOLDED_RANGES, [])
      ├── lines = codeEditor.value.split('\n')
      ├── validateFoldedRanges(lines, rawRanges)
      │     ├── 类型与有限性（number + isFinite）
      │     ├── 非负整数
      │     ├── startLine < endLine
      │     ├── 行号未越界
      │     ├── 去重
      │     ├── findFoldRange 语义复核
      │     └── 起始行一致性
      ├── 存入 EditorState.foldedRanges
      ├── foldedRangesVersion++
      └── 内容恢复后二次校验，失效项回写存储

## 历史栈不变量（HistoryManager）

- `history` 数组存储 `{ code, selectionStart, selectionEnd }`
- `currentIndex` 始终指向“最新入栈的状态”，即 `history.length - 1`
- 容量裁剪时仅 `shift()` 一次，随后无条件重置 `currentIndex = history.length - 1`
- 空栈时 `currentIndex = -1`（canUndo / canRedo 均为 false）
- `pushState` / `endBatch` / `setLargeFileMode` 三条路径使用同一裁剪与索引更新逻辑，避免行为分叉

## 已知的取舍与限制

1. **`ANSI` 无法真实探测操作系统代码页**：浏览器沙箱限制；实现上以“GBK 优先，不支持回退 ASCII”覆盖简中场景。
2. **代码折叠为逻辑折叠**：受 textarea 架构约束，折叠隐藏行仍占据垂直高度，不会像物理折叠那样压缩空间。UI 上以略深背景色提示。
3. **正则安全检测为启发式**：19 条危险模式覆盖绝大多数 ReDoS 攻击形态，但无法做到理论完备。Worker 内也运行同一份检测。
4. **Web Worker 不可用时降级**：某些 CSP / 隐私模式 / 旧浏览器下 `new Worker` 会抛错，此时查找替换自动走主线程同步搜索，功能不中断。
5. **File System Access API 不可用时降级**：Firefox / Safari 部分版本不支持，此时下载自动回退到浏览器原生下载。
6. **导入文件不更新后缀记忆**：导入是“高亮选择”，不是“后缀选择”。用户导入 `.spec` 时 Python 后缀记忆仍保持原值（如 `py`）。这是有意为之，避免“导入行为”污染“用户选择”。
7. **TXT 自由输入拒绝跨语言后缀**：TXT 可以输入任意后缀，但不能使用其他语言已声明的后缀（如 `py` / `html` / `js`）。这是为了避免 TXT 抢占其他语言的语义。若确实需要将 TXT 保存为 `.py`，请在 Python 模式下操作。
8. **`FILE_EXTENSION_HISTORY` 已废弃**：旧版全局后缀历史会导致跨语言污染，新版仅保留 `languageExtensionMap` 作为唯一记忆。存储键在初始化时一次性清理，不再导入导出。