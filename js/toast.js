// filename: js/toast.js
/**
 * ============================================================================
 * toast.js — Toast 顶部滑入提示
 * ============================================================================
 *
 * 【本次更新】
 *   仅在文件首行补充 // filename: js/toast.js 标注，与项目约定统一。
 *   内容逻辑保持不变。
 *
 * 行为：
 *   - 顶部居中滑入
 *   - 2.5 秒后自动消失
 *   - 支持错误样式（红色背景）
 *   - 通过强制回流重新触发动画
 *   - 重复调用会重置定时器，保证新消息完整展示
 * ============================================================================
 */

import { DOM } from './dom.js';
import { CONFIG } from './config.js';
import { EditorState } from './state.js';

export function showToast(message, isError) {
    if (EditorState.toastTimer) clearTimeout(EditorState.toastTimer);
    DOM.toast.textContent = message;
    DOM.toast.className = isError ? 'toast error' : 'toast';
    void DOM.toast.offsetHeight;
    DOM.toast.classList.add('show');
    EditorState.toastTimer = setTimeout(function() {
        DOM.toast.classList.remove('show');
        EditorState.toastTimer = null;
    }, CONFIG.TOAST_DURATION_MS);
}