// filename: js/folding.js
/**
 * ============================================================================
 * folding.js — 代码折叠
 * ============================================================================
 *
 * 【本次重构】
 *   1. 新增 validateFoldedRanges(lines, foldedRanges) 导出函数：
 *      原实现在 main.js 初始化时直接从 localStorage 恢复
 *      EditorState.foldedRanges，未做任何校验。
 *
 *      存在的风险：
 *        · 行号越界：历史折叠范围指向的行已不存在；
 *        · 结构变化：用户导入新文件后，旧折叠范围的 startLine
 *          对应的行已不再是块起点；
 *        · 语言切换：旧范围的语义在新语言下已无意义；
 *        · 数据篡改：localStorage 被外部修改后可能导致渲染异常。
 *
 *      校验规则：
 *        · startLine / endLine 必须为有限非负整数；
 *        · startLine < endLine；
 *        · endLine < lines.length；
 *        · 以 lines 重新调用 findFoldRange，若返回 null 则该范围失效；
 *        · 若新范围与旧范围 startLine 不一致（块起点已变），也失效。
 *
 *      返回：过滤后的合法折叠范围数组（保持原有字段结构）。
 *
 *   2. 保留全部原有导出接口与行为：
 *      getLineIndentLevel / findFoldRange / updateFoldedRangesInStorage /
 *      setupLineNumberClickHandler / toggleFold / getFoldedLinesSet /
 *      isLineHidden。
 *
 *   3. A3 修复保留：移除 baseIndent === 0 提前返回。
 *   4. A3 引入的闭合行误判修复保留：紧邻下一非空行缩进必须更深。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { STORAGE_KEYS } from './config.js';
import { saveToLocalStorage } from './util.js';
import { DOM } from './dom.js';
import { scheduleHighlightUpdate } from './highlight.js';

// ==================== 折叠范围计算 ====================

/**
 * 获取某一行的缩进层级（前导空白字符数）。
 */
export function getLineIndentLevel(line) {
    const indentMatch = line.match(/^[ \t]*/);
    if (!indentMatch) return 0;
    return indentMatch[0].length;
}

/**
 * 查找从 startLineIndex 起可折叠的范围。
 *
 * 返回 { startLine, endLine } 或 null。
 *
 * 语义：
 *   · startLineIndex 是折叠标记所在行（保持可见）
 *   · 返回的 [startLine + 1, endLine] 是折叠后隐藏的行范围
 *   · 起始行为空行时不产生折叠
 *   · 起始行的"紧邻下一非空行"缩进必须比 baseIndent 更深
 *
 * 该判定同时满足：
 *   · 顶层 function / class / def / <html> 可折叠（缩进 0 也可）
 *   · 闭合行 `}` 后紧跟同级块的行，不会被误判为折叠起点
 *   · 空块（下一非空行缩进不深）不产生折叠标记
 */
export function findFoldRange(lines, startLineIndex) {
    if (startLineIndex >= lines.length - 1) return null;

    // 起始行为空行 → 不产生折叠（避免空白行吞掉下方块）
    if (lines[startLineIndex].trim() === '') return null;

    const baseIndent = getLineIndentLevel(lines[startLineIndex]);

    // ---- 紧邻下一非空行必须缩进更深 ----
    let foldStart = startLineIndex + 1;
    while (foldStart < lines.length && lines[foldStart].trim() === '') {
        foldStart++;
    }
    if (foldStart >= lines.length) return null;

    if (getLineIndentLevel(lines[foldStart]) <= baseIndent) return null;

    // ---- 计算块结束行 ----
    let endLineIndex = foldStart + 1;
    while (endLineIndex < lines.length) {
        const currentIndent = getLineIndentLevel(lines[endLineIndex]);
        if (currentIndent <= baseIndent && lines[endLineIndex].trim() !== '') break;
        endLineIndex++;
    }

    return { startLine: startLineIndex, endLine: endLineIndex - 1 };
}

// ==================== 折叠范围校验 ====================

/**
 * 校验并清理折叠范围数组。
 *
 * 校验规则：
 *   1. startLine / endLine 必须为有限非负整数；
 *   2. startLine < endLine；
 *   3. endLine < lines.length（行号未越界）；
 *   4. 以当前 lines 重新计算 findFoldRange，若返回 null 则该范围失效；
 *   5. 若重新计算的 startLine 与原 startLine 不一致，也失效
 *      （说明该行已不再是块起点）。
 *
 * 保留原有 foldedCount 字段（若存在）。
 *
 * @param {string[]} lines - 当前代码 split('\n') 的结果
 * @param {Array} rawFoldedRanges - 待校验的原始折叠范围数组
 * @returns {Array} 过滤后的合法折叠范围数组
 */
export function validateFoldedRanges(lines, rawFoldedRanges) {
    if (!Array.isArray(rawFoldedRanges)) return [];
    if (!Array.isArray(lines) || lines.length === 0) return [];

    const validRanges = [];
    const seenStartLines = new Set();

    for (let index = 0; index < rawFoldedRanges.length; index++) {
        const rawRange = rawFoldedRanges[index];
        if (!rawRange || typeof rawRange !== 'object') continue;

        const rawStartLine = rawRange.startLine;
        const rawEndLine = rawRange.endLine;

        // 1. 类型与有限性
        if (typeof rawStartLine !== 'number' || !isFinite(rawStartLine)) continue;
        if (typeof rawEndLine !== 'number' || !isFinite(rawEndLine)) continue;

        // 2. 非负整数
        if (rawStartLine < 0 || rawEndLine < 0) continue;
        if (Math.floor(rawStartLine) !== rawStartLine) continue;
        if (Math.floor(rawEndLine) !== rawEndLine) continue;

        // 3. startLine < endLine
        if (rawStartLine >= rawEndLine) continue;

        // 4. 行号未越界
        if (rawStartLine >= lines.length) continue;
        if (rawEndLine >= lines.length) continue;

        // 5. 去重（同一 startLine 只保留第一个）
        if (seenStartLines.has(rawStartLine)) continue;

        // 6. 结构有效性：以当前 lines 重新计算折叠范围
        const recomputedRange = findFoldRange(lines, rawStartLine);
        if (!recomputedRange) continue;

        // 7. 重新计算的起始行必须与原起始行一致
        if (recomputedRange.startLine !== rawStartLine) continue;

        // 通过全部校验：使用重新计算的范围（保证 endLine 反映当前代码结构）
        const validRange = {
            startLine: recomputedRange.startLine,
            endLine: recomputedRange.endLine,
            foldedCount: recomputedRange.endLine - recomputedRange.startLine
        };
        validRanges.push(validRange);
        seenStartLines.add(recomputedRange.startLine);
    }

    // 按 startLine 排序，保证顺序稳定
    validRanges.sort(function(a, b) {
        return a.startLine - b.startLine;
    });

    return validRanges;
}

// ==================== 持久化 ====================

export function updateFoldedRangesInStorage() {
    saveToLocalStorage(STORAGE_KEYS.FOLDED_RANGES, EditorState.foldedRanges);
}

// ==================== 行号点击处理器 ====================

export function setupLineNumberClickHandler() {
    DOM.lineNumbers.addEventListener('click', function(event) {
        if (EditorState.largeFileActive) return;
        const target = event.target;
        if (target.classList.contains('fold-marker')) {
            event.stopPropagation();
            const lineIndex = parseInt(target.dataset.line);
            if (isNaN(lineIndex)) return;
            toggleFold(lineIndex);
        }
    });
}

// ==================== 折叠切换 ====================

export function toggleFold(lineIndex) {
    if (EditorState.largeFileActive) return;
    const lines = DOM.codeEditor.value.split('\n');
    const range = findFoldRange(lines, lineIndex);
    if (!range) return;

    const existingIndex = EditorState.foldedRanges.findIndex(function(r) {
        return r.startLine === range.startLine;
    });

    if (existingIndex >= 0) {
        EditorState.foldedRanges.splice(existingIndex, 1);
    } else {
        range.foldedCount = range.endLine - range.startLine;
        EditorState.foldedRanges.push(range);
    }

    // 折叠范围变更：自增版本号，使所有缓存失效。
    EditorState.foldedRangesVersion++;

    updateFoldedRangesInStorage();
    scheduleHighlightUpdate();
}

// ==================== 折叠行集合（带版本缓存） ====================

// 缓存的折叠行集合
let cachedFoldedLinesSet = null;
// 缓存对应的版本号
let cachedFoldedLinesVersion = -1;

/**
 * 获取所有"被折叠隐藏"的行索引集合。
 *
 * 折叠范围 [startLine, endLine] 中，隐藏的是 [startLine + 1, endLine]，
 * 起始行本身保持可见（用于显示 ▶ 折叠标记）。
 *
 * 结果基于 EditorState.foldedRangesVersion 缓存：
 *   · 版本号未变 → 直接返回缓存
 *   · 版本号变化 → 重建 Set 并更新缓存
 *
 * 避免 O(n×m) 重复计算。
 */
export function getFoldedLinesSet() {
    if (cachedFoldedLinesSet !== null && cachedFoldedLinesVersion === EditorState.foldedRangesVersion) {
        return cachedFoldedLinesSet;
    }

    const foldedLines = new Set();
    for (let rangeIndex = 0; rangeIndex < EditorState.foldedRanges.length; rangeIndex++) {
        const range = EditorState.foldedRanges[rangeIndex];
        for (let lineIndex = range.startLine + 1; lineIndex <= range.endLine; lineIndex++) {
            foldedLines.add(lineIndex);
        }
    }

    cachedFoldedLinesSet = foldedLines;
    cachedFoldedLinesVersion = EditorState.foldedRangesVersion;
    return foldedLines;
}

/**
 * 判断某行是否被折叠隐藏。
 */
export function isLineHidden(lineIndex) {
    for (let rangeIndex = 0; rangeIndex < EditorState.foldedRanges.length; rangeIndex++) {
        const range = EditorState.foldedRanges[rangeIndex];
        if (lineIndex > range.startLine && lineIndex <= range.endLine) return true;
    }
    return false;
}