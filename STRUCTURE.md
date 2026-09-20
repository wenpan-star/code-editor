# 项目目录结构

code-editor/
├── index.html
├── css/
│   └── styles.css                ← 全站样式（含四主题变量 / 组件 / 响应式）
└── js/
    ├── main.js                   ← 引导入口（script type="module"）
    ├── config.js                 ← 常量 / 存储键 / 编码映射 / 扩展名→编码 / 设置导出键集
    ├── util.js                   ← 通用工具 / 正则安全
    ├── state.js                  ← EditorState 全局状态
    ├── dom.js                    ← DOM 元素引用
    ├── toast.js                  ← Toast 提示
    ├── storage.js                ← localStorage / IndexedDB / 目录句柄底层
    ├── history.js                ← HistoryManager 撤销/重做
    ├── highlight.js              ← 语法高亮 + Shadow DOM
    ├── folding.js                ← 代码折叠
    ├── line-numbers.js           ← 行号渲染 + 光标 + scrollToCursor
    ├── encoding.js               ← 编码统一入口（UTF-8 / BOM / ANSI / ASCII）
    ├── gbk-codec.js              ← GBK 编解码（独立生命周期：探测/构建/缓存/预热）
    ├── search.js                 ← 查找替换 + 搜索 Worker
    ├── editor-api.js             ← 统一编辑入口（循环依赖解耦）
    ├── editor.js                 ← 编辑器核心（键盘 / 缩进 / 注释 / 粘贴）
    ├── file-io.js                ← 文件内容 I/O（导入 / 下载 / 拖拽 / 后缀联动）
    ├── directory-io.js           ← 目录 / 保存位置管理（更改 / 打开 / Picker 封装）
    ├── output.js                 ← 输出面板
    ├── java-runner.js            ← Java 编译运行（Piston API）
    ├── ui.js                     ← 主 UI 事件 / 快捷键 / 弹窗
    ├── settings-io.js            ← 设置导出 / 导入
    └── （共 22 个 JS 文件）

## 模块职责边界

### 存储与目录分层

    storage.js        底层持久化原语（IndexedDB / localStorage / 目录句柄存储）
        ↑
    directory-io.js   目录选择与生命周期（Picker 封装 / 权限 / startIn 记忆）
        ↑
    file-io.js        文件内容 I/O（读写文本 / 编码转换 / 拖拽 / 后缀联动）

### 编码模块分层

    encoding.js       统一入口 + 静态映射编码（UTF-8 / BOM / ANSI / ASCII）
        ↑ 委托
    gbk-codec.js      GBK 编解码（动态构建映射表 / 支持性探测 / 后台预热）

### 数据流依赖（单向无环）

    main.js
      ├── editor-api.js         （统一编辑入口）
      ├── file-io.js            → directory-io.js → storage.js
      ├── settings-io.js        → config.js
      ├── ui.js                 → editor-api.js / search.js
      └── highlight.js          ← main.js（注入调度回调）

## 编码支持（v8.7.0）

| 编码 ID | 显示名 | 说明 |
|---|---|---|
| `auto` | 自动检测 | 导入按 BOM / 扩展名 / UTF-8 有效性判定 |
| `utf-8` | UTF-8 | 现代跨平台首选 |
| `utf-8-bom` | UTF-8 BOM | 兼容 Windows 记事本 |
| `ansi` | ANSI (系统默认) | 简中 Windows = GBK；GBK 不可用时回退 ASCII |
| `gbk` | GBK (中文 ANSI) | 明确指定 GBK，不支持时硬报错 |
| `ascii` | 纯 ASCII | 非 ASCII 字符替换为 `?` |

### 扩展名 → 默认保存编码（仅当编码为 `auto` 时生效）

| 扩展名 | 默认编码 |
|---|---|
| `.py` / `.spec` / `.md` / `.json` / `.html` / `.htm` | UTF-8 |
| `.bat` / `.cmd` | ANSI（简中 Windows 上 = GBK） |
| 其他 | UTF-8 |