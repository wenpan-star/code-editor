// filename: js/directory-io.js
/**
 * ============================================================================
 * directory-io.js — 目录 / 保存位置管理（独立模块）
 * ============================================================================
 *
 * 【本次重构】
 *   1. openSaveLocation 增加二次确认：
 *      原实现在用户选择不同目录时直接更新保存位置。
 *      但"打开保存位置"的语义是"查看当前目录"，不是"更改保存位置"，
 *      用户可能误改。
 *
 *      新行为：
 *        · 用户选择相同目录 → 无副作用；
 *        · 用户选择不同目录 → confirm 二次确认，
 *          用户确认后才更新保存位置；
 *        · 用户取消确认 → 保持现状，不写 IndexedDB。
 *
 *   2. Picker 封装保留自动 startIn 与一次重试逻辑。
 *
 *   3. 保留全部原有导出接口与行为：
 *      getOrCreateSaveDirectory / changeSaveDirectory / openSaveLocation /
 *      bindDirectoryIOEvents。
 * ============================================================================
 */

import { DOM } from './dom.js';
import { showToast } from './toast.js';
import {
    loadDirectoryHandleWithStatus,
    saveDirectoryHandle,
    loadDirectoryHandleForStartIn
} from './storage.js';

// ==================== Picker 封装 ====================

/**
 * 封装 window.showDirectoryPicker，自动使用上次保存的目录句柄作为 startIn。
 *
 * 逻辑：
 *   1. 尝试通过 loadDirectoryHandleForStartIn() 读取上次保存的目录句柄
 *      （不做权限检查，仅取路径信息）。
 *   2. 若读取成功且句柄非空，则使用该句柄作为 startIn；
 *      否则回退到 'documents'。
 *   3. 调用 window.showDirectoryPicker。
 *   4. 若调用因句柄问题抛错（非用户主动取消 AbortError），
 *      自动重试一次并使用 'documents' 作为起始位置。
 *
 * @param {'read' | 'readwrite'} pickerMode - 目录访问模式
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function showDirectoryPickerWithLastPosition(pickerMode) {
    const pickerOptions = { mode: pickerMode };

    // loadDirectoryHandleForStartIn 内部已 catch 一切异常，永不抛错。
    const lastDirectoryHandle = await loadDirectoryHandleForStartIn();
    pickerOptions.startIn = lastDirectoryHandle || 'documents';

    try {
        return await window.showDirectoryPicker(pickerOptions);
    } catch (firstError) {
        // 用户主动取消：直接抛出，不做重试
        if (firstError && firstError.name === 'AbortError') {
            throw firstError;
        }
        // 句柄问题导致的失败：回退到 documents 重试一次
        if (pickerOptions.startIn !== 'documents') {
            return await window.showDirectoryPicker({
                mode: pickerMode,
                startIn: 'documents'
            });
        }
        throw firstError;
    }
}

/**
 * 判断两个目录句柄是否指向同一目录。
 *
 * 优先使用 isSameEntry（浏览器原生 API，最可靠）；
 * 不支持时回退到 name 比较（同名不同目录的极端情况会误判，
 * 但保存位置更新只是无害的重复赋值，可接受）。
 *
 * @param {FileSystemDirectoryHandle} handleA
 * @param {FileSystemDirectoryHandle} handleB
 * @returns {Promise<boolean>}
 */
async function isSameDirectory(handleA, handleB) {
    if (!handleA || !handleB) return false;
    if (typeof handleA.isSameEntry === 'function') {
        try {
            return await handleA.isSameEntry(handleB);
        } catch (compareError) {
            // isSameEntry 抛错时落到 name 比较
        }
    }
    return handleA.name === handleB.name;
}

// ==================== 对外：获取保存目录 ====================

/**
 * 获取当前可写的保存目录句柄。
 *
 * 供 file-io.js 的下载流程调用：
 *   · 已有授权目录（'granted'）        → 直接返回
 *   · 其余三种状态（'not-set' /
 *     'permission-denied' / 'error'）  → 弹出目录选择器
 *   因为此三态均需要用户重新选择目录，行为一致。
 *
 * 异常语义：
 *   · 用户取消选择 → 抛 AbortError（调用方据此终止保存）
 *   · 其他错误     → 原样抛出
 *
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getOrCreateSaveDirectory() {
    const loadResult = await loadDirectoryHandleWithStatus();
    if (loadResult.status === 'granted') {
        return loadResult.handle;
    }

    // 'not-set' / 'permission-denied' / 'error' 三态统一走目录选择器
    const pickedHandle = await showDirectoryPickerWithLastPosition('readwrite');
    await saveDirectoryHandle(pickedHandle);
    return pickedHandle;
}

// ==================== 对外：更改保存位置 ====================

/**
 * 更改保存位置。
 * 由工具栏的"更改保存位置"按钮触发。
 */
export async function changeSaveDirectory() {
    if (!window.showDirectoryPicker) {
        showToast('⚠️ 您的浏览器不支持目录选择，请使用传统下载', true);
        return;
    }
    try {
        const directoryHandle = await showDirectoryPickerWithLastPosition('readwrite');
        await saveDirectoryHandle(directoryHandle);
        showToast('📁 保存位置已更新');
    } catch (err) {
        if (err && err.name === 'AbortError') return;
        showToast('❌ 更改保存位置失败', true);
    }
}

// ==================== 对外：打开保存位置 ====================

/**
 * 打开文件保存位置。
 *
 * 浏览器沙箱不允许 JS 直接打开操作系统文件管理器，
 * 本函数的最佳可行方案：
 *   · 用已保存的目录句柄作为 startIn 打开 showDirectoryPicker
 *   · 用户可在原生对话框中"看到"当前保存目录及其内容
 *   · 若用户选择了不同的目录 → 二次确认后再更新保存位置
 *   · 若用户取消或选择相同目录，保持现状
 *
 * 与"更改保存位置"的区别：
 *   · "更改保存位置" 从上次位置开始，目的是选新目录
 *   · "打开保存位置" 从当前目录开始，目的是"看到"当前目录
 *
 * 提示文案按状态精确区分：
 *   · 'not-set'           → 引导用户先设置保存位置
 *   · 'permission-denied' → 告知权限已失效，请重新设置
 *   · 'error'             → 告知读取失败，请重新设置
 */
export async function openSaveLocation() {
    if (!window.showDirectoryPicker) {
        showToast('⚠️ 当前浏览器不支持文件系统访问', true);
        return;
    }

    const loadResult = await loadDirectoryHandleWithStatus();

    if (loadResult.status === 'not-set') {
        showToast('⚠️ 尚未设置保存位置，请先点击"更改保存位置"', true);
        return;
    }

    if (loadResult.status === 'permission-denied') {
        showToast('⚠️ 保存位置权限已失效，请重新设置保存位置', true);
        return;
    }

    if (loadResult.status === 'error') {
        showToast('❌ 读取保存位置信息失败，请重新设置', true);
        return;
    }

    // status === 'granted'，handle 必然非空
    const currentHandle = loadResult.handle;

    try {
        const pickedHandle = await window.showDirectoryPicker({
            mode: 'readwrite',
            startIn: currentHandle
        });

        const sameDirectory = await isSameDirectory(pickedHandle, currentHandle);
        if (!sameDirectory) {
            // 用户选择了不同目录：二次确认后再更新保存位置。
            // "打开保存位置"语义是"查看"，不应静默更改保存位置。
            const shouldChangeSaveLocation = confirm(
                '检测到您选择了其他目录："' + pickedHandle.name + '"。\n\n' +
                '是否将该目录设为新的保存位置？\n\n' +
                '点击"确定"：更新保存位置\n' +
                '点击"取消"：仅查看，不更改保存位置'
            );
            if (shouldChangeSaveLocation) {
                await saveDirectoryHandle(pickedHandle);
                showToast('📁 保存位置已更新为 "' + pickedHandle.name + '"');
            }
        }
    } catch (openError) {
        // 用户主动取消：无副作用
        if (openError && openError.name === 'AbortError') return;
        console.error('打开保存位置失败:', openError);
        showToast('❌ 无法打开保存位置', true);
    }
}

// ==================== 事件绑定 ====================

/**
 * 绑定"更改保存位置"与"打开保存位置"两个按钮。
 *
 * 由 main.js 在初始化阶段调用一次。
 */
export function bindDirectoryIOEvents() {
    if (DOM.btnChangeSaveDir) {
        DOM.btnChangeSaveDir.addEventListener('click', changeSaveDirectory);
    }
    if (DOM.btnOpenSaveLocation) {
        DOM.btnOpenSaveLocation.addEventListener('click', openSaveLocation);
    }
}