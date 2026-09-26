// filename: js/search.js
/**
 * ============================================================================
 * search.js — 查找 / 替换 / 搜索 Worker
 * ============================================================================
 *
 * 【本次重构】
 *   1. 正则安全模式单一事实来源（落地）：
 *      上一轮已从 util.js 导入 DANGEROUS_REGEX_PATTERN_SOURCES，
 *      但 createHighlightWorker 的 Worker 脚本仍硬编码了 19 条正则字面量，
 *      造成"导入但未使用"——两份列表仍然存在，维护漂移风险未消除。
 *
 *      本模块新增 buildDangerousRegexPatternsInlineCode()：
 *        · 遍历 DANGEROUS_REGEX_PATTERN_SOURCES；
 *        · 对每条源字符串调用 JSON.stringify，得到合法的 JS 字符串字面量；
 *        · 包裹为 new RegExp(...) 调用；
 *        · 用逗号 + 换行拼接成数组文本，通过模板字面量插值注入 Worker 脚本。
 *      这样 util.js 与 Worker 侧永远使用同一份模式列表。
 *
 *      正确性论证：
 *        · 源字符串中每个反斜杠在 JSON.stringify 后变为两个（JSON 转义）；
 *        · 通过 ${} 插入模板字面量时，插入值按原样拼接，不再二次转义；
 *        · Worker 收到 new RegExp("\\(...") 形式的源码，
 *          其中的字符串字面量在 Worker 求值时还原为原始模式字符串；
 *        · 与硬编码正则字面量语义完全等价。
 *
 *   2. Worker 创建失败时真正回退主线程同步搜索：
 *      创建、postMessage、超时三条路径都做 try/catch，
 *      任一步失败立即降级为 getMatchRangesSync。
 *
 *   3. 异步搜索竞态保护：
 *      每次调用分配递增序列号，回调执行前比对，过期结果被丢弃。
 *
 *   4. 保留全部原有导出接口与行为。
 * ============================================================================
 */

import { EditorState } from './state.js';
import { STORAGE_KEYS, CONFIG } from './config.js';
import {
    saveToLocalStorage,
    loadFromLocalStorage,
    buildSearchRegex,
    isRegexSafe,
    DANGEROUS_REGEX_PATTERN_SOURCES
} from './util.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { scheduleHighlightUpdate } from './highlight.js';
import { scrollToCursor, updateCursorPosition } from './line-numbers.js';
import { setEditorContent } from './editor-api.js';

// ==================== 异步搜索竞态保护 ====================

// 每次 getMatchRangesAsync 调用分配一个递增序列号；
// 回调执行前比对当前序列号，过期结果直接丢弃。
let searchGenerationCounter = 0;

// ==================== 危险模式动态内联（Worker 脚本用） ====================

/**
 * 把 util.js 导出的 DANGEROUS_REGEX_PATTERN_SOURCES 转换成
 * Worker 脚本中可用的 `new RegExp("...")` 数组文本。
 *
 * 关键点：
 *   · JSON.stringify 会把源字符串中的反斜杠正确转义为 \\，
 *     使结果成为合法的 JS 字符串字面量；
 *   · 通过模板字面量 ${} 插入时，插入值按原样拼接；
 *   · Worker 求值 new RegExp("\\(...") 时，
 *     字符串字面量 "\\(..." 在 Worker 内还原为 \(... 原始模式。
 *
 * @returns {string} 形如 `new RegExp("..."),\n                new RegExp("...")`
 */
function buildDangerousRegexPatternsInlineCode() {
    const inlineCodes = [];
    for (let index = 0; index < DANGEROUS_REGEX_PATTERN_SOURCES.length; index++) {
        inlineCodes.push(
            'new RegExp(' + JSON.stringify(DANGEROUS_REGEX_PATTERN_SOURCES[index]) + ')'
        );
    }
    return inlineCodes.join(',\n                ');
}

// ==================== 搜索 Worker ====================

/**
 * 创建搜索 Worker。
 *
 * 所有可能抛错的调用都包在 try/catch 中：
 *   · new Blob / URL.createObjectURL
 *   · new Worker
 * 任一失败时 EditorState.highlightWorker 保持 null，
 * 由 getMatchRangesAsync 统一走主线程同步回退。
 *
 * @returns {boolean} Worker 是否创建成功
 */
export function createHighlightWorker() {
    // 先终止旧 Worker，避免实例泄漏
    if (EditorState.highlightWorker) {
        try {
            EditorState.highlightWorker.terminate();
        } catch (terminateError) {
            // 忽略：旧 Worker 已损坏
        }
        EditorState.highlightWorker = null;
    }

    // 从 util.js 的单一事实来源动态生成 Worker 内的危险模式数组
    const dangerousPatternsInlineCode = buildDangerousRegexPatternsInlineCode();

    const workerScript = `
        function escapeRegExp(string) { return string.replace(/[-\\\\/^$*+?.()|[\\]{}]/g, '\\\\$&'); }
        function isRegexSafeForWorker(pattern) {
            if (!pattern || pattern.length > 100) return false;
            var dangerousPatterns = [
                ${dangerousPatternsInlineCode}
            ];
            for (var i = 0; i < dangerousPatterns.length; i++) {
                if (dangerousPatterns[i].test(pattern)) return false;
            }
            try { new RegExp(pattern); } catch(e) { return false; }
            return true;
        }
        function buildSearchRegex(searchTerm, caseSensitive, wholeWord, useRegex) {
            if (!searchTerm) return null;
            var pattern;
            if (useRegex) {
                if (!isRegexSafeForWorker(searchTerm)) return null;
                try { new RegExp(searchTerm); pattern = searchTerm; } catch (e) { return null; }
            } else {
                var escapedTerm = escapeRegExp(searchTerm);
                pattern = wholeWord ? '\\\\b' + escapedTerm + '\\\\b' : escapedTerm;
            }
            var flags = 'g' + (caseSensitive ? '' : 'i');
            try { return new RegExp(pattern, flags); } catch (e) { return null; }
        }
        self.onmessage = function(event) {
            var message = event.data;
            if (message.type !== 'searchMatches') return;
            var code = message.code,
                searchTerm = message.searchTerm,
                caseSensitive = message.caseSensitive,
                wholeWord = message.wholeWord,
                useRegex = message.useRegex,
                timeout = message.timeout,
                requestId = message.requestId;
            try {
                var regex = buildSearchRegex(searchTerm, caseSensitive, wholeWord, useRegex);
                if (!regex) {
                    self.postMessage({ type: 'searchMatchesResult', matches: [], safe: false, reason: 'regex_invalid', requestId: requestId });
                    return;
                }
                var matches = [];
                var startTime = performance.now();
                var match;
                while ((match = regex.exec(code)) !== null) {
                    matches.push({ index: match.index, length: match[0].length });
                    if (matches.length > 10000) break;
                    if (timeout && (performance.now() - startTime) > timeout) {
                        self.postMessage({ type: 'searchMatchesResult', matches: [], safe: false, reason: 'timeout', requestId: requestId });
                        return;
                    }
                }
                self.postMessage({ type: 'searchMatchesResult', matches: matches, safe: true, requestId: requestId });
            } catch (searchError) {
                self.postMessage({
                    type: 'searchMatchesResult',
                    matches: [],
                    safe: false,
                    reason: 'worker_error',
                    requestId: requestId
                });
            }
        };
        self.onerror = function(e) {
            self.postMessage({ type: 'searchMatchesResult', matches: [], safe: false, reason: 'worker_error' });
        };
    `;

    let worker = null;
    try {
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        worker = new Worker(blobUrl);
    } catch (workerConstructError) {
        console.warn('Web Worker 构造失败，查找功能将走主线程同步搜索:', workerConstructError);
        EditorState.highlightWorker = null;
        return false;
    }

    worker.onmessage = function(event) {
        const responseData = event.data;
        if (responseData.type === 'searchMatchesResult' && responseData.requestId !== undefined) {
            const pendingCallback = EditorState.workerCallbacksMap.get(responseData.requestId);
            if (pendingCallback) {
                EditorState.workerCallbacksMap.delete(responseData.requestId);
                let reason = null;
                if (!responseData.safe) reason = responseData.reason || 'unsafe_regex';
                let ranges = responseData.matches.map(function(m) {
                    return { start: m.index, end: m.index + m.length };
                });
                pendingCallback(ranges, reason);
            }
        }
    };

    // Worker 抛错时先 terminate 再置空，避免实例泄漏；
    // 同时清空所有在途回调（避免回调永久滞留）。
    worker.onerror = function(event) {
        if (EditorState.highlightWorker === worker) {
            try {
                worker.terminate();
            } catch (terminateError) {
                // 忽略
            }
            EditorState.highlightWorker = null;
        }
        EditorState.workerCallbacksMap.forEach(function(callback) {
            callback([], 'worker_error');
        });
        EditorState.workerCallbacksMap.clear();
    };

    EditorState.highlightWorker = worker;
    return true;
}

export function terminateHighlightWorker() {
    if (EditorState.highlightWorker) {
        try {
            EditorState.highlightWorker.terminate();
        } catch (terminateError) {
            // 忽略：Worker 已损坏
        }
        EditorState.highlightWorker = null;
    }
    EditorState.workerCallbacksMap.clear();
}

/**
 * 异步搜索匹配范围。
 *
 * 回退策略（依次判断）：
 *   1. Worker 不存在 → 尝试创建；创建失败 → 主线程同步搜索；
 *   2. Worker 存在但 postMessage 抛错 → 主线程同步搜索；
 *   3. Worker 超时未返回 → 回传空结果 + 'timeout' 原因（不回退同步，
 *      避免超时后再次执行可能同样慢的同步搜索，造成双重卡顿）。
 *
 * 竞态保护：
 *   每次调用分配一个递增序列号；回调执行前比对当前序列号，
 *   过期结果被丢弃，避免旧请求覆盖新状态。
 */
export function getMatchRangesAsync(code, searchTerm, caseSensitive, wholeWord, useRegex, callback, timeout) {
    const effectiveTimeout = timeout || CONFIG.SEARCH_TIMEOUT_MS;

    // ---- 1. 确保 Worker 可用 ----
    if (!EditorState.highlightWorker) {
        createHighlightWorker();
    }

    // ---- 2. Worker 仍不可用 → 主线程同步回退 ----
    if (!EditorState.highlightWorker) {
        const syncRanges = getMatchRangesSync(code, searchTerm, caseSensitive, wholeWord, useRegex);
        callback(syncRanges, null);
        return;
    }

    const requestId = ++EditorState.workerMessageIdCounter;
    const myGeneration = ++searchGenerationCounter;

    // 包装回调：过期结果直接丢弃，不执行外层 callback
    EditorState.workerCallbacksMap.set(requestId, function(ranges, reason) {
        if (myGeneration !== searchGenerationCounter) {
            return;
        }
        callback(ranges, reason);
    });

    // ---- 3. postMessage 失败 → 主线程同步回退 ----
    try {
        EditorState.highlightWorker.postMessage({
            type: 'searchMatches',
            code: code,
            searchTerm: searchTerm,
            caseSensitive: caseSensitive,
            wholeWord: wholeWord,
            useRegex: useRegex,
            timeout: effectiveTimeout,
            requestId: requestId
        });
    } catch (postMessageError) {
        console.warn('Worker postMessage 失败，回退主线程同步搜索:', postMessageError);
        EditorState.workerCallbacksMap.delete(requestId);
        const syncRanges = getMatchRangesSync(code, searchTerm, caseSensitive, wholeWord, useRegex);
        if (myGeneration === searchGenerationCounter) {
            callback(syncRanges, null);
        }
        return;
    }

    // ---- 4. 超时兜底：过期请求直接丢弃，不覆盖新状态 ----
    setTimeout(function() {
        if (EditorState.workerCallbacksMap.has(requestId)) {
            EditorState.workerCallbacksMap.delete(requestId);
            if (EditorState.workerCallbacksMap.size === 0) {
                terminateHighlightWorker();
            }
            if (myGeneration === searchGenerationCounter) {
                callback([], 'timeout');
            }
        }
    }, effectiveTimeout + CONFIG.SEARCH_TIMEOUT_GRACE_MS);
}

export function getMatchRangesSync(code, searchTerm, caseSensitive, wholeWord, useRegex) {
    const regex = buildSearchRegex(searchTerm, caseSensitive, wholeWord, useRegex);
    if (!regex) return [];
    const matches = [];
    let match;
    let count = 0;
    while ((match = regex.exec(code)) !== null && count < 1000) {
        matches.push({ start: match.index, end: match.index + match[0].length });
        count++;
    }
    return matches;
}

// ==================== 匹配计数防抖 ====================

let matchCountDebounceTimer = null;

export function updateMatchCountDebounced() {
    if (matchCountDebounceTimer) clearTimeout(matchCountDebounceTimer);
    matchCountDebounceTimer = setTimeout(function() {
        matchCountDebounceTimer = null;
        updateMatchCount();
    }, CONFIG.MATCH_COUNT_DEBOUNCE_MS);
}

// ==================== 查找替换弹窗 ====================

export function openReplaceModal() {
    DOM.replaceModalOverlay.classList.add('open');
    const savedPosition = loadFromLocalStorage(STORAGE_KEYS.REPLACE_MODAL_POSITION, null);
    if (savedPosition && savedPosition.left !== undefined && savedPosition.top !== undefined) {
        DOM.replaceModal.style.position = 'fixed';
        DOM.replaceModal.style.left = savedPosition.left + 'px';
        DOM.replaceModal.style.top = savedPosition.top + 'px';
        DOM.replaceModal.style.margin = '0';
    } else {
        DOM.replaceModal.style.position = '';
        DOM.replaceModal.style.left = '';
        DOM.replaceModal.style.top = '';
        DOM.replaceModal.style.margin = '';
    }
    const savedSize = loadFromLocalStorage(STORAGE_KEYS.REPLACE_MODAL_SIZE, null);
    if (savedSize && savedSize.width && savedSize.height) {
        DOM.replaceModal.style.width = savedSize.width + 'px';
        DOM.replaceModal.style.height = savedSize.height + 'px';
    } else {
        DOM.replaceModal.style.width = '';
        DOM.replaceModal.style.height = '';
    }
    setTimeout(function() {
        const findHeight = loadFromLocalStorage(STORAGE_KEYS.REPLACE_FIND_MANUAL_HEIGHT, null);
        const withHeight = loadFromLocalStorage(STORAGE_KEYS.REPLACE_WITH_MANUAL_HEIGHT, null);
        if (findHeight && typeof findHeight === 'number') DOM.replaceFind.style.height = findHeight + 'px';
        if (withHeight && typeof withHeight === 'number') DOM.replaceWith.style.height = withHeight + 'px';
    }, 20);
    DOM.replaceFind.focus();
    updateMatchCount();
}

export function closeReplaceModal() {
    if (EditorState.isDragging) {
        EditorState.isDragging = false;
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
    }
    if (EditorState.isResizing) {
        EditorState.isResizing = false;
        document.removeEventListener('mousemove', onResize);
        document.removeEventListener('mouseup', stopResize);
        DOM.replaceModal.style.overflow = '';
    }
    if (DOM.replaceModalOverlay.classList.contains('open')) {
        const modalRect = DOM.replaceModal.getBoundingClientRect();
        saveToLocalStorage(STORAGE_KEYS.REPLACE_MODAL_POSITION, {
            left: modalRect.left,
            top: modalRect.top
        });
        saveToLocalStorage(STORAGE_KEYS.REPLACE_MODAL_SIZE, {
            width: modalRect.width,
            height: modalRect.height
        });
    }
    DOM.replaceModalOverlay.classList.remove('open');
    EditorState.lastSearchMatches = [];
    EditorState.searchMatchIndex = -1;
    scheduleHighlightUpdate();
}

export function toggleReplaceModal() {
    if (DOM.replaceModalOverlay.classList.contains('open')) closeReplaceModal();
    else openReplaceModal();
}

export function updateMatchCount() {
    if (!DOM.replaceModalOverlay.classList.contains('open') || !DOM.replaceFind.value) {
        DOM.matchCountEl.textContent = '';
        DOM.matchCountEl.style.color = '';
        return;
    }
    if (EditorState.largeFileActive) {
        DOM.matchCountEl.textContent = '大文件模式不计算';
        DOM.matchCountEl.style.color = 'var(--text-secondary)';
        return;
    }
    getMatchRangesAsync(
        DOM.codeEditor.value,
        DOM.replaceFind.value,
        DOM.replaceCaseSensitive.checked,
        DOM.replaceWholeWord.checked,
        DOM.replaceUseRegex.checked,
        function(matches, reason) {
            if (reason) {
                DOM.matchCountEl.textContent = '⚠️ 正则不安全或超时';
                DOM.matchCountEl.style.color = 'var(--red)';
            } else if (matches.length === 0) {
                DOM.matchCountEl.textContent = '0 处匹配';
                DOM.matchCountEl.style.color = 'var(--text-secondary)';
            } else {
                DOM.matchCountEl.textContent = matches.length + ' 处匹配';
                DOM.matchCountEl.style.color = 'var(--green)';
            }
        },
        CONFIG.SEARCH_TIMEOUT_MS
    );
}

export function findNext() {
    if (EditorState.largeFileActive) {
        showToast('大文件模式下查找功能受限', true);
        return;
    }
    const foundMatches = getMatchRangesSync(
        DOM.codeEditor.value,
        DOM.replaceFind.value,
        DOM.replaceCaseSensitive.checked,
        DOM.replaceWholeWord.checked,
        DOM.replaceUseRegex.checked
    );
    if (foundMatches.length === 0) {
        const regex = buildSearchRegex(
            DOM.replaceFind.value,
            DOM.replaceCaseSensitive.checked,
            DOM.replaceWholeWord.checked,
            DOM.replaceUseRegex.checked
        );
        if (!regex && DOM.replaceFind.value) {
            if (DOM.replaceUseRegex.checked && !isRegexSafe(DOM.replaceFind.value)) {
                showToast('⚠️ 正则表达式存在性能风险，请简化', true);
            } else {
                showToast('未找到匹配项', true);
            }
        } else {
            showToast('未找到匹配项', true);
        }
        return;
    }
    EditorState.lastSearchMatches = foundMatches;
    const currentSelectionStart = DOM.codeEditor.selectionStart;
    let nextMatchIndex = foundMatches.findIndex(function(match) {
        return match.start > currentSelectionStart;
    });
    if (nextMatchIndex === -1) nextMatchIndex = 0;
    EditorState.searchMatchIndex = nextMatchIndex;
    const targetMatch = foundMatches[nextMatchIndex];
    DOM.codeEditor.focus();
    DOM.codeEditor.setSelectionRange(targetMatch.start, targetMatch.end);
    scrollToCursor();
    updateCursorPosition();
    showToast('匹配 ' + (nextMatchIndex + 1) + '/' + foundMatches.length);
}

export function replaceOne() {
    if (EditorState.largeFileActive) {
        showToast('大文件模式下替换功能受限', true);
        return;
    }
    const foundMatches = getMatchRangesSync(
        DOM.codeEditor.value,
        DOM.replaceFind.value,
        DOM.replaceCaseSensitive.checked,
        DOM.replaceWholeWord.checked,
        DOM.replaceUseRegex.checked
    );
    if (foundMatches.length === 0) {
        const regex = buildSearchRegex(
            DOM.replaceFind.value,
            DOM.replaceCaseSensitive.checked,
            DOM.replaceWholeWord.checked,
            DOM.replaceUseRegex.checked
        );
        if (!regex && DOM.replaceFind.value) {
            if (DOM.replaceUseRegex.checked && !isRegexSafe(DOM.replaceFind.value)) {
                showToast('⚠️ 正则表达式存在性能风险，请简化', true);
            } else {
                showToast('未找到匹配项', true);
            }
        } else {
            showToast('未找到匹配项', true);
        }
        return;
    }
    EditorState.lastSearchMatches = foundMatches;
    const currentSelectionStart = DOM.codeEditor.selectionStart;
    const currentSelectionEnd = DOM.codeEditor.selectionEnd;
    const currentMatchIndex = foundMatches.findIndex(function(match) {
        return match.start === currentSelectionStart && match.end === currentSelectionEnd;
    });
    if (currentMatchIndex === -1) {
        findNext();
        return;
    }
    const targetMatch = foundMatches[currentMatchIndex];
    const replacementText = DOM.replaceWith.value;
    const currentCode = DOM.codeEditor.value;
    const newCode = currentCode.substring(0, targetMatch.start)
        + replacementText
        + currentCode.substring(targetMatch.end);
    setEditorContent(newCode, true);

    const newMatches = getMatchRangesSync(
        DOM.codeEditor.value,
        DOM.replaceFind.value,
        DOM.replaceCaseSensitive.checked,
        DOM.replaceWholeWord.checked,
        DOM.replaceUseRegex.checked
    );
    EditorState.lastSearchMatches = newMatches;
    if (newMatches.length > 0) {
        const nextMatchIndex = newMatches.findIndex(function(match) {
            return match.start >= targetMatch.start;
        });
        if (nextMatchIndex !== -1) {
            const nextMatch = newMatches[nextMatchIndex];
            DOM.codeEditor.setSelectionRange(nextMatch.start, nextMatch.end);
            EditorState.searchMatchIndex = nextMatchIndex;
            scrollToCursor();
        }
    }
}

export function replaceAll() {
    if (EditorState.largeFileActive) {
        showToast('大文件模式下替换功能受限', true);
        return;
    }
    const searchRegex = buildSearchRegex(
        DOM.replaceFind.value,
        DOM.replaceCaseSensitive.checked,
        DOM.replaceWholeWord.checked,
        DOM.replaceUseRegex.checked
    );
    if (!searchRegex) {
        if (DOM.replaceUseRegex.checked && DOM.replaceFind.value) {
            showToast('⚠️ 正则表达式存在性能风险，请简化', true);
        } else {
            showToast('请输入有效的查找内容', true);
        }
        return;
    }
    const currentCode = DOM.codeEditor.value;
    const matchedItems = currentCode.match(searchRegex);
    if (!matchedItems) {
        showToast('未找到匹配项', true);
        return;
    }
    const totalMatches = matchedItems.length;
    if (!confirm('确定要替换全部 ' + totalMatches + ' 处匹配吗？')) return;
    const replacementText = DOM.replaceWith.value;
    const newCode = currentCode.replace(searchRegex, function() {
        return replacementText;
    });
    setEditorContent(newCode, true);
    showToast('✅ 已替换 ' + totalMatches + ' 处匹配');
    EditorState.lastSearchMatches = [];
    EditorState.searchMatchIndex = -1;
}

export function persistReplaceInputs() {
    saveToLocalStorage(STORAGE_KEYS.REPLACE_FIND, DOM.replaceFind.value);
    saveToLocalStorage(STORAGE_KEYS.REPLACE_WITH, DOM.replaceWith.value);
    saveToLocalStorage(STORAGE_KEYS.REPLACE_CASE_SENSITIVE, DOM.replaceCaseSensitive.checked);
    saveToLocalStorage(STORAGE_KEYS.REPLACE_WHOLE_WORD, DOM.replaceWholeWord.checked);
    saveToLocalStorage(STORAGE_KEYS.REPLACE_USE_REGEX, DOM.replaceUseRegex.checked);
}

export function restoreReplaceInputs() {
    DOM.replaceFind.value = loadFromLocalStorage(STORAGE_KEYS.REPLACE_FIND, '');
    DOM.replaceWith.value = loadFromLocalStorage(STORAGE_KEYS.REPLACE_WITH, '');
    DOM.replaceCaseSensitive.checked = loadFromLocalStorage(STORAGE_KEYS.REPLACE_CASE_SENSITIVE, false);
    DOM.replaceWholeWord.checked = loadFromLocalStorage(STORAGE_KEYS.REPLACE_WHOLE_WORD, false);
    DOM.replaceUseRegex.checked = loadFromLocalStorage(STORAGE_KEYS.REPLACE_USE_REGEX, false);
}

// ==================== 弹窗拖拽 ====================

export function onDrag(event) {
    if (!EditorState.isDragging) return;
    DOM.replaceModal.style.left = (event.clientX - EditorState.dragOffsetX) + 'px';
    DOM.replaceModal.style.top = (event.clientY - EditorState.dragOffsetY) + 'px';
    DOM.replaceModal.style.position = 'fixed';
    DOM.replaceModal.style.margin = '0';
}

export function stopDrag() {
    EditorState.isDragging = false;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    const modalRect = DOM.replaceModal.getBoundingClientRect();
    saveToLocalStorage(STORAGE_KEYS.REPLACE_MODAL_POSITION, {
        left: modalRect.left,
        top: modalRect.top
    });
}

// ==================== 弹窗调整大小 ====================

export function startResize(event, direction) {
    EditorState.isResizing = true;
    EditorState.resizeDirection = direction;
    EditorState.resizeStartX = event.clientX;
    EditorState.resizeStartY = event.clientY;
    const modalRect = DOM.replaceModal.getBoundingClientRect();
    EditorState.startWidth = modalRect.width;
    EditorState.startHeight = modalRect.height;
    EditorState.startLeft = modalRect.left;
    EditorState.startTop = modalRect.top;
    DOM.replaceModal.style.overflow = 'hidden';
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', stopResize);
    event.preventDefault();
    event.stopPropagation();
}

export function onResize(event) {
    if (!EditorState.isResizing) return;
    const deltaX = event.clientX - EditorState.resizeStartX;
    const deltaY = event.clientY - EditorState.resizeStartY;
    const minimumWidth = 300;
    const minimumHeight = 200;

    if (EditorState.resizeDirection === 'right') {
        const newWidth = EditorState.startWidth + deltaX;
        if (newWidth > minimumWidth) DOM.replaceModal.style.width = newWidth + 'px';
    } else if (EditorState.resizeDirection === 'bottom') {
        const newHeight = EditorState.startHeight + deltaY;
        if (newHeight > minimumHeight) DOM.replaceModal.style.height = newHeight + 'px';
    } else if (EditorState.resizeDirection === 'corner') {
        const newWidth = EditorState.startWidth + deltaX;
        const newHeight = EditorState.startHeight + deltaY;
        if (newWidth > minimumWidth) DOM.replaceModal.style.width = newWidth + 'px';
        if (newHeight > minimumHeight) DOM.replaceModal.style.height = newHeight + 'px';
    }
}

export function stopResize() {
    EditorState.isResizing = false;
    EditorState.resizeDirection = null;
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', stopResize);
    DOM.replaceModal.style.overflow = '';
    const modalRect = DOM.replaceModal.getBoundingClientRect();
    saveToLocalStorage(STORAGE_KEYS.REPLACE_MODAL_SIZE, {
        width: modalRect.width,
        height: modalRect.height
    });
}

// ==================== 查找/替换弹窗事件绑定 ====================

export function bindReplaceModalEvents() {
    DOM.replaceModalHeader.addEventListener('mousedown', function(event) {
        EditorState.isDragging = true;
        const modalRect = DOM.replaceModal.getBoundingClientRect();
        EditorState.dragOffsetX = event.clientX - modalRect.left;
        EditorState.dragOffsetY = event.clientY - modalRect.top;
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
    });

    DOM.resizeHandleRight.addEventListener('mousedown', function(event) {
        startResize(event, 'right');
    });
    DOM.resizeHandleBottom.addEventListener('mousedown', function(event) {
        startResize(event, 'bottom');
    });
    DOM.resizeHandleCorner.addEventListener('mousedown', function(event) {
        startResize(event, 'corner');
    });

    DOM.replaceModalClose.addEventListener('click', closeReplaceModal);
    DOM.replaceModalOverlay.addEventListener('click', function(event) {
        if (event.target === DOM.replaceModalOverlay) closeReplaceModal();
    });
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && DOM.replaceModalOverlay.classList.contains('open')) closeReplaceModal();
    });

    DOM.btnFindNext.addEventListener('click', findNext);
    DOM.btnReplaceOne.addEventListener('click', replaceOne);
    DOM.btnReplaceAll.addEventListener('click', replaceAll);

    DOM.replaceFind.addEventListener('input', function() {
        updateMatchCountDebounced();
        persistReplaceInputs();
        scheduleHighlightUpdate();
    });
    DOM.replaceWith.addEventListener('input', function() {
        persistReplaceInputs();
    });
    DOM.replaceCaseSensitive.addEventListener('change', function() {
        updateMatchCount();
        persistReplaceInputs();
        scheduleHighlightUpdate();
    });
    DOM.replaceWholeWord.addEventListener('change', function() {
        updateMatchCount();
        persistReplaceInputs();
        scheduleHighlightUpdate();
    });
    DOM.replaceUseRegex.addEventListener('change', function() {
        updateMatchCount();
        persistReplaceInputs();
        scheduleHighlightUpdate();
    });

    DOM.replaceModal.addEventListener('keydown', function(event) {
        if (event.key === 'Enter'
            && (event.target === DOM.replaceFind || event.target === DOM.replaceWith)
            && !event.shiftKey) {
            event.preventDefault();
            findNext();
        }
    });

    setupSmartSelect(DOM.replaceFind);
    setupSmartSelect(DOM.replaceWith);
}

/**
 * 智能选择：单击全选，拖动不选中。
 * 使用前置声明的 boundMouseMove / boundMouseUp 保证 removeEventListener 引用一致。
 */
function setupSmartSelect(textarea) {
    let isDragging = false;
    let hadSelection = false;
    textarea.addEventListener('mousedown', function(e) {
        hadSelection = this.selectionStart !== this.selectionEnd;
        isDragging = false;
        const startX = e.clientX;
        const startY = e.clientY;
        const self = this;

        let boundMouseMove = null;
        let boundMouseUp = null;

        function onMouseMove(moveEvent) {
            if (Math.abs(moveEvent.clientX - startX) > 2 || Math.abs(moveEvent.clientY - startY) > 2) {
                isDragging = true;
                if (boundMouseMove) document.removeEventListener('mousemove', boundMouseMove);
                if (boundMouseUp) document.removeEventListener('mouseup', boundMouseUp);
            }
        }

        function onMouseUp() {
            if (!hadSelection && !isDragging) self.select();
            if (boundMouseMove) document.removeEventListener('mousemove', boundMouseMove);
            if (boundMouseUp) document.removeEventListener('mouseup', boundMouseUp);
        }

        boundMouseMove = onMouseMove.bind(self);
        boundMouseUp = onMouseUp.bind(self);
        document.addEventListener('mousemove', boundMouseMove);
        document.addEventListener('mouseup', boundMouseUp);
    });
}