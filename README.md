# filename: README.md
# 在线代码编辑器 · 专业版

一个纯前端、零构建、开箱即用的在线代码编辑器。基于 ES Module 原生模块化，无需打包工具，双击即可本地预览。

---

## 一、项目简介

本项目是一个功能完整的浏览器端代码编辑器，支持多种编程语言、多种文件编码、查找替换、代码折叠、Java 在线编译运行、设置导出导入等能力。全部逻辑运行在浏览器沙箱内，不依赖任何后端服务（Java 运行除外，走公开 Piston API）。

**核心特征**：

- 纯原生 ES Module，无 webpack / vite / rollup 等构建工具
- 零依赖，无 npm 安装步骤
- 四主题切换（Dark / Light / Ink / Cream）
- 六种编码支持（UTF-8 / UTF-8 BOM / ANSI / GBK / 纯 ASCII / 自动检测），带编码标准透明化
- 五语言语法高亮（JavaScript / HTML / CSS / Python / Java）+ 纯文本模式
- Shadow DOM 高亮层，避免与 textarea 冲突
- Web Worker 异步搜索，正则安全检测（单一事实来源，防 ReDoS）
- IndexedDB + localStorage 双层自动保存
- File System Access API 目录保存（支持记忆上次位置）
- 折叠范围持久化 + 初始化校验（防止行号越界与块结构失效）

---

## 二、快速开始

### 方式 1：本地 HTTP 服务（推荐）

由于浏览器对 `file://` 协议下的 ES Module 有 CORS 限制，**必须通过 HTTP/HTTPS 访问**。

使用 Python 内置服务器：

```bash
cd code-editor
python3 -m http.server 8000
```

然后浏览器访问：

```text
http://localhost:8000
```

### 方式 2：其他静态服务器

任选一种：

```bash
# Node.js
npx serve .

# PHP
php -S localhost:8000

# Ruby
ruby -run -e httpd . -p 8000
```

### 方式 3：部署到静态托管

直接把 `code-editor/` 目录整体上传到 GitHub Pages、Netlify、Vercel、Cloudflare Pages 等任意静态托管服务即可。

---

## 三、功能清单

### 编辑能力

- 语法高亮（JS / HTML / CSS / Python / Java）
- 自动括号配对（`()` `[]` `{}` `""` `''` `` ` ``）
- 智能回车缩进（根据 `{` `(` `[` 或 Python `:` 结尾自动缩进）
- 智能退格（删除整级缩进）
- Tab / Shift+Tab 缩进与反缩进（支持多行选区）
- Ctrl+/ 注释切换（语言自适应）
- 代码折叠（行号旁折叠标记，状态持久化 + 初始化校验）
- 自动换行开关
- 字体缩放（10px – 30px）
- 撤销/重做（历史栈溢出索引修复，支持 200 步）

### 文件能力

- 导入文本文件（拖拽 / 按钮）
- 下载 / 保存到目录（File System Access API）
- 记忆上次保存位置
- 每语言独立后缀（可选 / 可自定义 / 可看历史）
- 后缀历史下拉（含预设候选）
- “打开保存位置”语义与“更改保存位置”严格区分（选择其他目录时二次确认）

### 编码能力

| 编码 | 显示名 | 说明 |
|---|---|---|
| `auto` | 自动检测 | 导入按 BOM / 扩展名 / UTF-8 有效性判定 |
| `utf-8` | UTF-8 | 现代跨平台首选，符合 RFC 3629 标准 |
| `utf-8-bom` | UTF-8 BOM | 兼容 Windows 记事本等要求 BOM 的场景 |
| `ansi` | ANSI (系统默认) | 微软历史术语。本编辑器实现：简中 Windows 上等价 GBK；浏览器不支持 GBK 时回退纯 ASCII（非 ASCII 替换为 `?`） |
| `gbk` | GBK (中文 ANSI) | 中国国家标准 GBK（GB2312 扩展）；浏览器不支持时硬报错，由调用方提示 |
| `ascii` | 纯 ASCII | ANSI X3.4 标准，仅支持 0x00-0x7F；非 ASCII 字符替换为 `?` |

**编码透明化**：每个编码下拉 option 均带 `title` 属性，详述其真实语义与失败行为；切换 `ansi` 时 Toast 明确显示当前环境实际使用 GBK 还是回退 ASCII；切换 `gbk` 而浏览器不支持时也给出明确提示。用户无需查阅文档即可理解每种编码的实际行为。

扩展名 → 默认保存编码（仅当编码为 `auto` 时生效）：

| 扩展名 | 默认编码 |
|---|---|
| `.py` / `.spec` / `.md` / `.json` / `.html` / `.htm` | UTF-8 |
| `.bat` / `.cmd` | ANSI |
| 其他 | UTF-8 |

### 查找替换

- 支持多行查找
- 支持正则表达式（含安全性检测，防灾难性回溯）
- 区分大小写 / 全词匹配 / 正则开关
- 匹配计数显示
- 弹窗可拖拽、可调整大小（位置与尺寸持久化）
- Web Worker 异步搜索（超时自动终止重建；创建 / postMessage 失败时自动回退主线程同步搜索）
- 异步搜索竞态保护（旧请求结果被序列号丢弃，不会覆盖新状态）
- 大文件模式下降级为主线程同步搜索

### Java 运行

- 通过 Piston API 在线编译运行
- 支持 Java 21 / 17 / 15 版本切换
- 标准输入 (stdin) 缓存（输入防抖 + blur / pagehide / beforeunload 兜底落盘）
- 30 秒超时自动中断
- 输出面板（stdout / stderr / 编译信息）

### 设置管理

- 一键导出全部设置为 JSON（含时间戳文件名）
- 从 JSON 文件导入恢复
- 逐项校验（枚举白名单 / 数值范围 / 结构校验）
- 导入前确认 + 未保存代码提醒（明确区分“自动保存”与“明确保存”）

### 自动保存

- IndexedDB 主存 + localStorage 兜底
- 页面隐藏 / 卸载时紧急保存
- 恢复时提示用户是否加载上次内容
- 状态栏反馈：成功绿色 2 秒后恢复默认色；失败红色持续到下次成功；降级到本地存储时黄色

### 代码折叠

- 折叠范围持久化（`FOLDED_RANGES` 存储键）
- 初始化时调用 `validateFoldedRanges` 校验：行号越界、块结构失效、数据篡改均被过滤
- 内容恢复后二次校验，失效项自动清理并回写存储
- 折叠行集合缓存基于版本号（`foldedRangesVersion`），任何变更使缓存正确失效
- 行号列渲染 O(n)：一次预计算折叠起始行集合，避免逐行调用 `findFoldRange` 造成的 O(n²)

---

## 四、键盘快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+C` | 复制全部代码 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Y` / `Ctrl+Shift+Z` | 重做 |
| `Ctrl+F` | 打开查找 |
| `Ctrl+H` | 打开替换 |
| `Ctrl+G` | 跳转到行 |
| `Ctrl+↑` | 跳到文档第一行 |
| `Ctrl+Shift+↑` | 扩展选区到文档开头 |
| `Ctrl+/` | 注释 / 取消注释 |
| `Ctrl+S` | 立即保存 |
| `Ctrl+Enter` | 运行 Java 代码 |
| `Ctrl+=` / `Ctrl++` | 放大字体 |
| `Ctrl+-` | 缩小字体 |
| `Ctrl+0` | 重置字体为 14px |
| `Ctrl+T` | 切换主题 |

macOS 用户可将 `Ctrl` 替换为 `Cmd`。

---

## 五、项目结构

完整目录树与模块职责说明见 [STRUCTURE.md](./STRUCTURE.md)。

简要结构：

```text
code-editor/
├── index.html
├── README.md
├── STRUCTURE.md
├── 完整目录树.txt
├── css/
│   └── styles.css
└── js/
    ├── main.js
    ├── config.js
    ├── util.js
    ├── state.js
    ├── dom.js
    ├── toast.js
    ├── storage.js
    ├── history.js
    ├── highlight.js
    ├── folding.js
    ├── line-numbers.js
    ├── encoding.js
    ├── gbk-codec.js
    ├── search.js
    ├── editor-api.js
    ├── editor.js
    ├── file-io.js
    ├── directory-io.js
    ├── output.js
    ├── java-runner.js
    ├── ui.js
    └── settings-io.js
```

模块依赖遵循**单向无环**原则，`editor-api.js` 作为统一编辑入口解耦循环依赖。

---

## 六、浏览器兼容性

| 浏览器 | 最低版本 | 说明 |
|---|---|---|
| Chrome | 86+ | 完整支持（含 File System Access API） |
| Edge | 86+ | 完整支持（含 File System Access API） |
| Firefox | 19+ | 支持 GBK 解码；不支持 File System Access API（自动回退下载） |
| Safari | 15+ | 支持大部分功能；File System Access API 部分受限 |

**关键能力依赖**：

- `TextDecoder('gbk')`：Chrome 38+ / Edge 79+ / Firefox 19+
- `File System Access API`：Chrome 86+ / Edge 86+
- `Shadow DOM`：所有现代浏览器
- `Web Worker`：所有现代浏览器（不可用时自动回退主线程同步搜索）

当 File System Access API 不可用时，下载功能自动回退到浏览器原生下载。

---

## 七、开发约束

### 不可妥协的规则

1. **必须通过 HTTP/HTTPS 访问**：ES Module 在 `file://` 协议下会被 CORS 拦截，整个应用不执行。
2. **模块间不得出现循环依赖**：`editor-api.js` 是唯一允许被多个模块引用的协调层，其他模块之间通过注入回调解耦。
3. **不得使用 JS 注释符之外的注释语法**：文件头注释统一使用 `//` 或 `/** */`，不得使用 `#`。
4. **不得引入构建工具**：保持零构建，直接 ES Module 加载。

### 代码风格

- 每个模块第一行为 `// filename: js/xxx.js` 注释（或对应的 Markdown 首行注释）
- 所有函数与变量使用完整、语义化的英文命名，不缩写
- 大括号不换行（Allman 风格除外，本项目统一 K&R 风格）
- 使用 `var` / `let` / `const` 时优先 `const`，其次 `let`，避免 `var`

---

## 八、常见问题

### Q1：打开页面白屏 / 完全无响应

检查浏览器 Console 是否有 `CORS` 或 `Failed to resolve module specifier` 报错。若是，说明你正通过 `file://` 访问，请改用 HTTP 服务。

### Q2：Java 运行报“网络错误”

Piston API（`https://emkc.org/api/v2/piston/execute`）是公开服务，可能因网络环境或服务限流而不可用。请检查网络连接后重试。

### Q3：导入 `.bat` 文件显示乱码

`.bat` / `.cmd` 文件在简体中文 Windows 上默认为 GBK 编码。导入时若编辑器当前编码为“自动检测”，会按扩展名推荐 ANSI（即 GBK）。若仍有乱码，请手动切换编码为“GBK (中文 ANSI)”后重新导入。

### Q4：保存到目录时提示“权限已失效”

浏览器出于安全考虑，会在页面会话结束后撤销目录权限。这是预期行为，重新选择目录即可。

### Q5：大文件（>300KB）编辑卡顿

超过 300KB 后编辑器会自动关闭实时语法高亮，超过 2MB 会阻止加载。这是为避免浏览器 textarea 渲染层物理瓶颈导致页面无响应。

### Q6：为什么 `ANSI (系统默认)` 的实际行为是 GBK 或回退 ASCII？

ANSI 是微软历史术语，指“操作系统默认代码页”，具体是哪种编码取决于操作系统与区域设置（简中 Windows 为 GBK，日文 Windows 为 Shift-JIS，西欧 Windows 为 Windows-1252 等）。浏览器沙箱无法探测操作系统代码页，因此本编辑器做了务实取舍：优先 GBK，不支持时回退纯 ASCII（非 ASCII 字符替换为 `?`）。每个编码下拉 option 的悬停提示、以及切换编码时的 Toast 均会明确告知当前实际使用的编码。

---

## 九、版本历史

- **当前版本**：编码标准合规性重构；历史栈溢出索引修复；Worker 失败回退主线程；导入编码 BOM 覆盖修复；下载只 prompt 一次文件名；保存位置语义二次确认；高亮状态污染修复；自动保存颜色恢复；折叠范围初始化校验；折叠行渲染 O(n)；正则安全单一事实来源；帮助弹窗去 Emoji；状态栏字号提升至 12px；语言下拉 `JV` → `Java`
- **更早版本**：Python 后缀放开自定义（py / pyw）；后缀下拉支持预设候选；`skipBeforeUnload` 双字段模式（布尔 + 过期时间戳）；新增 `ansi` / `gbk` / `ascii` 编码；新增“打开保存位置”按钮；模块拆出 `gbk-codec.js` / `directory-io.js`；设置导出 / 导入；导入后跳过 beforeunload 二次确认；导入文件后后缀自动跟随语言；`Ctrl+↑` / `Ctrl+Shift+↑` 快捷键；TXT 模式禁用自动配对；四主题；五语言高亮；代码折叠；查找替换；Java 运行；双层自动保存

---

## 十、许可

本项目为内部工具项目，未附带开源许可证。使用、修改、分发请遵循所在组织的相关规定。