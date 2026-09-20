// filename: js/highlight.js
/**
 * ============================================================================
 * highlight.js — 语法高亮 + Shadow DOM 高亮层
 * ============================================================================
 *
 * 【本次更新】
 *   updateHighlightStatusIndicator 移除 Emoji textContent 注入：
 *   原实现在启用时设置 DOM.highlightIcon.textContent = '🔆'，
 *   停用时设置为 '🌑'。本次 UI 美化统一图标风格后，Emoji 全部
 *   移除，状态指示器改由 CSS 通过 currentColor 渲染为一个 6px 圆点。
 *   JS 只需切换颜色与文字标签：
 *     · 启用 → color: var(--green) + label "高亮"
 *     · 停用 → color: var(--text-secondary) + label "高亮已关"
 *
 * 【保留】
 *   - 折叠行集合本地版本号缓存（共享 EditorState.foldedRangesVersion）
 *   - 折叠行输出裸换行符以保持与 textarea 垂直对齐
 *   - 行高只读取一次 computedStyle
 * ============================================================================
 */

import { EditorState } from './state.js';
import { DOM } from './dom.js';
import { escapeHtml, saveToLocalStorage } from './util.js';
import { STORAGE_KEYS } from './config.js';

// ==================== 折叠行集合（本地缓存） ====================

let highlightFoldedLinesSet = null;
let highlightFoldedLinesVersion = -1;

/**
 * 获取折叠行集合（带版本缓存）。
 *
 * 与 folding.js 的 getFoldedLinesSet 逻辑完全一致，
 * 独立缓存以避免循环依赖。
 */
function getFoldedLinesSetForHighlight() {
    if (highlightFoldedLinesSet !== null && highlightFoldedLinesVersion === EditorState.foldedRangesVersion) {
        return highlightFoldedLinesSet;
    }

    const foldedLines = new Set();
    for (let rangeIndex = 0; rangeIndex < EditorState.foldedRanges.length; rangeIndex++) {
        const range = EditorState.foldedRanges[rangeIndex];
        for (let lineIndex = range.startLine + 1; lineIndex <= range.endLine; lineIndex++) {
            foldedLines.add(lineIndex);
        }
    }

    highlightFoldedLinesSet = foldedLines;
    highlightFoldedLinesVersion = EditorState.foldedRangesVersion;
    return foldedLines;
}

// ==================== 语法高亮（主线程） ====================

export function syntaxHighlightMainThread(code, language) {
    if (!code) return '';
    let escaped = escapeHtml(code);

    if (language === 'js' || language === 'javascript') {
        escaped = escaped.replace(/\/\*[\s\S]*?\*\//g, function(m) {
            return '<span class="cmt">' + m + '</span>';
        });
        escaped = escaped.replace(/(\/\/.*)/g, '<span class="cmt">$1</span>');
        escaped = escaped.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="str">$1</span>');
        escaped = escaped.replace(/\b(function|const|let|var|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|async|await|try|catch|throw|typeof|instanceof|this|super|default|yield|of|in|static|get|set)\b/g, '<span class="kw">$1</span>');
        escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
        escaped = escaped.replace(/\b([a-zA-Z_$][\w$]*)\s*\(/g, '<span class="fn">$1</span>(');
        escaped = escaped.replace(/\.([a-zA-Z_$][\w$]*)/g, '.<span class="prop">$1</span>');
    } else if (language === 'html') {
        escaped = escaped.replace(/&lt;!--[\s\S]*?--&gt;/g, '<span class="cmt">$&</span>');
        escaped = escaped.replace(/(&lt;\/?)([\w-]+)([\s\S]*?)(\/?&gt;)/g, function(m, openTag, tagName, attributes, closeTag) {
            const processedAttributes = attributes.replace(/([\w-]+)=(".*?"|'.*?')/g, '<span class="attr">$1</span>=<span class="str">$2</span>');
            return openTag + '<span class="tag">' + tagName + '</span>' + processedAttributes + closeTag;
        });
    } else if (language === 'css') {
        escaped = escaped.replace(/\/\*[\s\S]*?\*\//g, '<span class="cmt">$&</span>');
        escaped = escaped.replace(/([\w-]+)\s*:/g, '<span class="attr">$1</span>:');
        escaped = escaped.replace(/:\s*([^;{}]+)/g, function(m, propertyValue) {
            return ': ' + propertyValue.replace(/(#[0-9a-fA-F]{3,8}|\d+\.?\d*(\w+|%)?)/g, '<span class="num">$1</span>');
        });
        escaped = escaped.replace(/([.#][\w-]+)/g, '<span class="tag">$1</span>');
    } else if (language === 'python') {
        escaped = escaped.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, '<span class="str">$&</span>');
        escaped = escaped.replace(/(#.*)/g, '<span class="cmt">$1</span>');
        escaped = escaped.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="str">$1</span>');
        escaped = escaped.replace(/\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|yield|lambda|and|or|not|in|is|None|True|False|self|print|range|len|int|str|float|list|dict|set|tuple)\b/g, '<span class="kw">$1</span>');
        escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
        escaped = escaped.replace(/def\s+([a-zA-Z_]\w*)/g, 'def <span class="fn">$1</span>');
        escaped = escaped.replace(/(@[\w.]+)/g, '<span class="tag">$1</span>');
    } else if (language === 'java') {
        escaped = escaped.replace(/\/\*\*[\s\S]*?\*\//g, function(m) {
            return '<span class="cmt">' + m + '</span>';
        });
        escaped = escaped.replace(/\/\*[\s\S]*?\*\//g, function(m) {
            return '<span class="cmt">' + m + '</span>';
        });
        escaped = escaped.replace(/(\/\/.*)/g, '<span class="cmt">$1</span>');
        escaped = escaped.replace(/("(?:[^"\\]|\\.)*")/g, '<span class="str">$1</span>');
        escaped = escaped.replace(/('(?:[^'\\]|\\.)')/g, '<span class="str">$1</span>');
        escaped = escaped.replace(/(@[\w.]+)/g, '<span class="annot">$1</span>');
        escaped = escaped.replace(/\b(public|private|protected|static|final|class|interface|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|import|package|void|int|long|double|float|boolean|char|byte|short|this|super|null|true|false|abstract|synchronized|volatile|transient|native|strictfp|instanceof|enum|assert|default|var|record|sealed|permits|yield)\b/g, '<span class="kw">$1</span>');
        escaped = escaped.replace(/\b(\d+\.?\d*(?:[lLfFdD])?|0x[0-9a-fA-F]+)\b/g, '<span class="num">$1</span>');
        escaped = escaped.replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, '<span class="type">$1</span>');
        escaped = escaped.replace(/\b([a-z_][\w$]*)\s*\(/g, '<span class="fn">$1</span>(');
        escaped = escaped.replace(/\.([a-z_][\w$]*)/g, '.<span class="prop">$1</span>');
    }
    return escaped;
}

// ==================== Shadow DOM 高亮层 ====================

export function syncShadowCSSVariables() {
    if (!EditorState.highlightShadowRoot) return;
    const host = EditorState.highlightShadowRoot.host;
    const rootStyle = getComputedStyle(document.documentElement);
    const vars = [
        '--hl-kw', '--hl-str', '--hl-num', '--hl-cmt', '--hl-fn',
        '--hl-tag', '--hl-attr', '--hl-prop', '--hl-op', '--hl-punc',
        '--hl-annot', '--hl-type', '--hl-search-bg', '--hl-bracket-bg',
        '--text', '--editor-font-size', '--editor-line-height', '--editor-font',
        '--line-highlight-bg'
    ];
    vars.forEach(function(v) {
        host.style.setProperty(v, rootStyle.getPropertyValue(v).trim());
    });
}

export function setupShadowHighlightLayer() {
    const shadowRoot = DOM.highlightHost.attachShadow({ mode: 'open' });
    EditorState.highlightShadowRoot = shadowRoot;
    const style = document.createElement('style');
    style.textContent = `
        :host { display: block; width: 100%; height: 100%; position: absolute; top: 0; left: 0; overflow: hidden; pointer-events: none; }
        pre { position: absolute; top: 0; left: 0; right: 0; bottom: 0; margin: 0; padding: 12px 18px; font-family: var(--editor-font, monospace); font-size: var(--editor-font-size, 14px); line-height: var(--editor-line-height, 1.7); tab-size: 4; white-space: pre; overflow-wrap: normal; word-wrap: normal; overflow: hidden; color: var(--text, #cdd6f4); background: transparent; border: none; outline: none; letter-spacing: 0; box-sizing: border-box; }
        pre.wrap-enabled { white-space: pre-wrap; word-break: break-all; }
        .kw { color: var(--hl-kw); }
        .str { color: var(--hl-str); }
        .num { color: var(--hl-num); }
        .cmt { color: var(--hl-cmt); font-style: italic; }
        .fn { color: var(--hl-fn); }
        .tag { color: var(--hl-tag); }
        .attr { color: var(--hl-attr); }
        .prop { color: var(--hl-prop); }
        .op { color: var(--hl-op); }
        .punc { color: var(--hl-punc); }
        .annot { color: var(--hl-annot); }
        .type { color: var(--hl-type); }
        .search-match { background: var(--hl-search-bg); border-radius: 2px; display: inline; }
        .bracket-match { background: var(--hl-bracket-bg); border-radius: 2px; display: inline; }
        .line-highlight { background: var(--line-highlight-bg); display: block; position: absolute; left: 0; right: 0; pointer-events: none; }
    `;
    shadowRoot.appendChild(style);
    const preElement = document.createElement('pre');
    preElement.setAttribute('aria-hidden', 'true');
    shadowRoot.appendChild(preElement);
    EditorState.highlightPreElement = preElement;
    syncShadowCSSVariables();
}

export function updateShadowHighlight(highlightedHTML, wrapEnabled) {
    if (!EditorState.highlightPreElement) return;
    const pre = EditorState.highlightPreElement;
    pre.innerHTML = highlightedHTML + '\n';
    if (wrapEnabled) pre.classList.add('wrap-enabled');
    else pre.classList.remove('wrap-enabled');
}

export function syncShadowScroll() {
    if (EditorState.highlightPreElement) {
        EditorState.highlightPreElement.scrollTop = DOM.codeEditor.scrollTop;
        EditorState.highlightPreElement.scrollLeft = DOM.codeEditor.scrollLeft;
    }
}

/**
 * 同步滚动：行号 + 高亮层。
 */
export function syncScroll() {
    DOM.lineNumbers.scrollTop = DOM.codeEditor.scrollTop;
    syncShadowScroll();
}

// ==================== 括号匹配 ====================

export function findMatchingBracket(code, position) {
    const character = code[position];
    const bracketPairs = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };
    if (!bracketPairs[character]) return -1;
    const isOpeningBracket = '([{'.indexOf(character) !== -1;
    const targetCharacter = bracketPairs[character];
    let nestingDepth = 0;

    if (isOpeningBracket) {
        for (let i = position + 1; i < code.length; i++) {
            if (code[i] === character) nestingDepth++;
            else if (code[i] === targetCharacter) {
                if (nestingDepth === 0) return i;
                nestingDepth--;
            }
        }
    } else {
        for (let i = position - 1; i >= 0; i--) {
            if (code[i] === character) nestingDepth++;
            else if (code[i] === targetCharacter) {
                if (nestingDepth === 0) return i;
                nestingDepth--;
            }
        }
    }
    return -1;
}

// ==================== 综合高亮渲染 ====================

export function buildHighlightHTML(code, language, searchRanges, bracketRanges, currentLineIndex) {
    if (!code || EditorState.largeFileActive) return '';
    if (!EditorState.highlightEnabled) return escapeHtml(code) + '\n';

    const allHighlightRanges = [];
    for (let i = 0; i < searchRanges.length; i++) {
        allHighlightRanges.push({ start: searchRanges[i].start, end: searchRanges[i].end, type: 'search' });
    }
    for (let i = 0; i < bracketRanges.length; i++) {
        allHighlightRanges.push({ start: bracketRanges[i].start, end: bracketRanges[i].end, type: 'bracket' });
    }
    allHighlightRanges.sort(function(a, b) {
        return a.start - b.start;
    });

    const lines = code.split('\n');
    const foldedLinesSet = getFoldedLinesSetForHighlight();

    let resultHtml = '';
    let charIndex = 0;
    let visualLineIndex = 0;
    let rangePointer = 0;

    // 行高只读取一次计算样式
    const editorComputedStyle = getComputedStyle(DOM.codeEditor);
    const parsedLineHeight = parseFloat(editorComputedStyle.lineHeight);
    const lineHeightPx = parsedLineHeight || EditorState.currentFontSize * 1.7;
    const paddingTop = parseFloat(editorComputedStyle.paddingTop) || 12;
    const scrollTopOffset = DOM.codeEditor.scrollTop;

    function processTextSegment(text, segmentStart, segmentEnd) {
        while (rangePointer < allHighlightRanges.length && allHighlightRanges[rangePointer].end <= segmentStart) {
            rangePointer++;
        }
        let result = '';
        let lastPos = 0;
        while (rangePointer < allHighlightRanges.length && allHighlightRanges[rangePointer].start < segmentEnd) {
            const currentRange = allHighlightRanges[rangePointer];
            const rangeStartInSegment = currentRange.start - segmentStart;
            const rangeEndInSegment = Math.min(currentRange.end, segmentEnd) - segmentStart;

            if (rangeStartInSegment > lastPos) {
                const plainText = text.substring(segmentStart + lastPos, segmentStart + rangeStartInSegment);
                result += syntaxHighlightMainThread(plainText, language);
            }
            const matchText = text.substring(segmentStart + rangeStartInSegment, segmentStart + rangeEndInSegment);
            const matchClass = currentRange.type === 'search' ? 'search-match' : 'bracket-match';
            result += '<span class="' + matchClass + '">' + syntaxHighlightMainThread(matchText, language) + '</span>';
            lastPos = rangeEndInSegment;

            if (currentRange.end <= segmentEnd) rangePointer++;
            else break;
        }
        if (lastPos < segmentEnd - segmentStart) {
            const remainingText = text.substring(segmentStart + lastPos, segmentEnd);
            result += syntaxHighlightMainThread(remainingText, language);
        }
        return result;
    }

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        // ---- 折叠隐藏行：输出空行保持垂直对齐 ----
        // 关键：仍要 visualLineIndex++，否则后续行高亮位置会偏移；
        // 仍要 charIndex 前进，否则后续行的全局字符索引会错。
        if (foldedLinesSet.has(lineIdx)) {
            charIndex += lines[lineIdx].length + 1;
            resultHtml += '\n';
            visualLineIndex++;
            continue;
        }

        const line = lines[lineIdx];
        const lineStartGlobal = charIndex;
        const lineEndGlobal = lineStartGlobal + line.length;

        if (lineIdx === currentLineIndex) {
            const highlightTopPosition = (visualLineIndex * lineHeightPx) - scrollTopOffset + paddingTop;
            resultHtml += '<span class="line-highlight" style="top:' + highlightTopPosition + 'px;height:' + lineHeightPx + 'px;"></span>';
        }

        visualLineIndex++;
        resultHtml += processTextSegment(code, lineStartGlobal, lineEndGlobal) + '\n';
        charIndex = lineEndGlobal + 1;
    }

    return resultHtml;
}

// ==================== 调度 ====================

let highlightRAFId = null;
let scheduleHighlightCallback = null;

export function setHighlightScheduler(callback) {
    scheduleHighlightCallback = callback;
}

export function scheduleHighlightUpdate() {
    if (!scheduleHighlightCallback) return;
    if (highlightRAFId) return;
    highlightRAFId = requestAnimationFrame(function() {
        highlightRAFId = null;
        scheduleHighlightCallback();
    });
}

// ==================== 高亮开关 ====================

/**
 * 更新高亮状态指示器。
 *
 * 状态点由 CSS 通过 currentColor 渲染（#highlightIcon 是一个
 * 6px 圆形 span，background: currentColor，颜色继承自
 * #highlightStatus 的 color）。JS 只需切换颜色与文字标签。
 *
 * 本次 UI 美化已移除 Emoji（原 '🔆' / '🌑'），
 * 使状态栏与整体图标风格（SVG 线稿）保持一致。
 */
export function updateHighlightStatusIndicator(enabled) {
    if (enabled) {
        DOM.highlightStatus.style.color = 'var(--green)';
        DOM.highlightLabel.textContent = '高亮';
    } else {
        DOM.highlightStatus.style.color = 'var(--text-secondary)';
        DOM.highlightLabel.textContent = '高亮已关';
    }
}

export function setHighlightEnabled(enabled, showModal) {
    const shouldShowModal = showModal === true;
    if (EditorState.highlightEnabled === enabled && !shouldShowModal) return;
    EditorState.highlightEnabled = enabled;
    saveToLocalStorage(STORAGE_KEYS.HIGHLIGHT_ENABLED, enabled);
    updateHighlightStatusIndicator(enabled);

    if (enabled) {
        if (EditorState.largeFileActive) {
            DOM.largeFileModal.classList.add('open');
        } else {
            DOM.largeFileModal.classList.remove('open');
        }
        scheduleHighlightUpdate();
    } else {
        if (shouldShowModal && !EditorState.userForcedHighlight) {
            DOM.largeFileModal.classList.add('open');
        }
        if (EditorState.largeFileActive) {
            if (EditorState.highlightPreElement) EditorState.highlightPreElement.innerHTML = '';
        } else {
            updateShadowHighlight(escapeHtml(DOM.codeEditor.value), EditorState.wordWrapEnabled);
        }
        syncShadowScroll();
    }
}