// filename: js/settings-io.js
/**
 * ============================================================================
 * settings-io.js — 设置导出 / 导入
 * ============================================================================
 *
 * 【本次重构】
 *   为新增的 TXT_EXTENSION_HISTORY 增加导出 / 导入支持：
 *     · 加入 SETTINGS_EXPORTABLE_KEYS（在 config.js 中已处理）；
 *     · 在 SETTINGS_VALUE_VALIDATORS 中新增校验器：
 *         - 必须是数组；
 *         - 元素必须是字符串；
 *         - 每个元素长度不超过 CONFIG.FILE_EXTENSION_MAX_LENGTH；
 *         - 数组长度不超过 CONFIG.FILE_EXTENSION_HISTORY_MAX * 4
 *           （宽松上限，允许历史迁移时的短暂超限）。
 *
 *   其余逻辑完全保持原样。
 * ============================================================================
 */

import {
    CONFIG,
    STORAGE_KEYS,
    SETTINGS_EXPORTABLE_KEYS
} from './config.js';
import { DOM } from './dom.js';
import { showToast } from './toast.js';
import { loadFromLocalStorage } from './util.js';
import { EditorState } from './state.js';

// ==================== 模块级常量 ====================

const SETTINGS_FILE_TYPE = 'code-editor-settings';
const SETTINGS_FILE_VERSION = 1;

// ==================== 模块级状态 ====================

let isSettingsIOInitialized = false;

// ==================== 下拉菜单显示 / 隐藏 ====================

function isSettingsDropdownVisible() {
    if (!DOM.settingsIODropdown) return false;
    return DOM.settingsIODropdown.style.display !== 'none';
}

function showSettingsDropdown() {
    if (!DOM.settingsIODropdown) return;
    DOM.settingsIODropdown.style.display = 'block';
    if (DOM.btnSettingsIO) {
        DOM.btnSettingsIO.setAttribute('aria-expanded', 'true');
    }
}

function hideSettingsDropdown() {
    if (!DOM.settingsIODropdown) return;
    DOM.settingsIODropdown.style.display = 'none';
    if (DOM.btnSettingsIO) {
        DOM.btnSettingsIO.setAttribute('aria-expanded', 'false');
    }
}

function toggleSettingsDropdown() {
    if (!DOM.settingsIODropdown) return;
    if (isSettingsDropdownVisible()) {
        hideSettingsDropdown();
    } else {
        showSettingsDropdown();
    }
}

function focusFirstSettingsMenuItem() {
    if (!DOM.settingsIODropdown) return;
    const firstMenuItem = DOM.settingsIODropdown.querySelector('.settings-io-item');
    if (firstMenuItem) {
        firstMenuItem.focus();
    }
}

// ==================== 值校验规则表 ====================

/**
 * 校验规则表：storageKey → 校验函数。
 *
 * 本次新增 TXT_EXTENSION_HISTORY 校验器。
 */
const SETTINGS_VALUE_VALIDATORS = {
    [STORAGE_KEYS.THEME]: function(value) {
        return typeof value === 'string'
            && ['dark', 'light', 'ink', 'cream'].indexOf(value) !== -1;
    },
    [STORAGE_KEYS.INDENT]: function(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (typeof value.size !== 'number' || !isFinite(value.size)) return false;
        if (value.size < 1 || value.size > 16) return false;
        if (value.character !== ' ' && value.character !== '\t') return false;
        return true;
    },
    [STORAGE_KEYS.FONT_SIZE]: function(value) {
        return typeof value === 'number' && isFinite(value)
            && value >= 10 && value <= 30;
    },
    [STORAGE_KEYS.LANGUAGE]: function(value) {
        return typeof value === 'string'
            && ['js', 'html', 'css', 'python', 'java', 'txt'].indexOf(value) !== -1;
    },
    [STORAGE_KEYS.WRAP_ENABLED]: function(value) {
        return typeof value === 'boolean';
    },
    [STORAGE_KEYS.HIGHLIGHT_ENABLED]: function(value) {
        return typeof value === 'boolean';
    },
    [STORAGE_KEYS.ENCODING]: function(value) {
        return typeof value === 'string'
            && ['auto', 'utf-8', 'utf-8-bom', 'ansi', 'gbk', 'ascii'].indexOf(value) !== -1;
    },
    [STORAGE_KEYS.JAVA_VERSION]: function(value) {
        return typeof value === 'string'
            && ['21.0.2', '17.0.6', '15.0.2'].indexOf(value) !== -1;
    },
    [STORAGE_KEYS.FOLDED_RANGES]: function(value) {
        if (!Array.isArray(value)) return false;
        for (let index = 0; index < value.length; index++) {
            const range = value[index];
            if (!range || typeof range !== 'object') return false;
            if (typeof range.startLine !== 'number' || !isFinite(range.startLine)) return false;
            if (typeof range.endLine !== 'number' || !isFinite(range.endLine)) return false;
            if (range.startLine < 0 || range.endLine < range.startLine) return false;
        }
        return true;
    },
    [STORAGE_KEYS.STDIN_CACHE]: function(value) {
        return typeof value === 'string' && value.length <= 500000;
    },
    [STORAGE_KEYS.REPLACE_FIND]: function(value) {
        return typeof value === 'string' && value.length <= 100000;
    },
    [STORAGE_KEYS.REPLACE_WITH]: function(value) {
        return typeof value === 'string' && value.length <= 100000;
    },
    [STORAGE_KEYS.REPLACE_CASE_SENSITIVE]: function(value) {
        return typeof value === 'boolean';
    },
    [STORAGE_KEYS.REPLACE_WHOLE_WORD]: function(value) {
        return typeof value === 'boolean';
    },
    [STORAGE_KEYS.REPLACE_USE_REGEX]: function(value) {
        return typeof value === 'boolean';
    },
    [STORAGE_KEYS.REPLACE_MODAL_POSITION]: function(value) {
        if (value === null) return true;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (typeof value.left !== 'number' || !isFinite(value.left)) return false;
        if (typeof value.top !== 'number' || !isFinite(value.top)) return false;
        return true;
    },
    [STORAGE_KEYS.REPLACE_MODAL_SIZE]: function(value) {
        if (value === null) return true;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (typeof value.width !== 'number' || !isFinite(value.width)) return false;
        if (typeof value.height !== 'number' || !isFinite(value.height)) return false;
        if (value.width < 100 || value.height < 100) return false;
        return true;
    },
    [STORAGE_KEYS.REPLACE_FIND_MANUAL_HEIGHT]: function(value) {
        if (value === null) return true;
        return typeof value === 'number' && isFinite(value)
            && value >= 60 && value <= 400;
    },
    [STORAGE_KEYS.REPLACE_WITH_MANUAL_HEIGHT]: function(value) {
        if (value === null) return true;
        return typeof value === 'number' && isFinite(value)
            && value >= 60 && value <= 400;
    },
    [STORAGE_KEYS.LAST_DOWNLOAD_FILENAME]: function(value) {
        return typeof value === 'string' && value.length <= 255;
    },
    [STORAGE_KEYS.LANGUAGE_EXTENSION_MAP]: function(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const validLanguages = ['js', 'html', 'css', 'python', 'java', 'txt'];
        const keysOfValue = Object.keys(value);
        for (let index = 0; index < keysOfValue.length; index++) {
            const languageKey = keysOfValue[index];
            if (validLanguages.indexOf(languageKey) === -1) continue;
            const extensionValue = value[languageKey];
            if (typeof extensionValue !== 'string') return false;
            if (extensionValue.length > CONFIG.FILE_EXTENSION_MAX_LENGTH) return false;
        }
        return true;
    },
    // 本次新增：TXT 后缀历史校验器。
    [STORAGE_KEYS.TXT_EXTENSION_HISTORY]: function(value) {
        if (!Array.isArray(value)) return false;
        if (value.length > CONFIG.FILE_EXTENSION_HISTORY_MAX * 4) return false;
        for (let index = 0; index < value.length; index++) {
            const item = value[index];
            if (typeof item !== 'string') return false;
            if (item.length > CONFIG.FILE_EXTENSION_MAX_LENGTH) return false;
        }
        return true;
    }
};

/**
 * 判定单个设置项的值是否合法。
 */
function isSettingValueValid(settingKey, settingValue) {
    const validatorFunction = SETTINGS_VALUE_VALIDATORS[settingKey];
    if (typeof validatorFunction !== 'function') {
        return true;
    }
    try {
        return validatorFunction(settingValue) === true;
    } catch (validationError) {
        console.warn('设置项校验异常:', settingKey, validationError);
        return false;
    }
}

// ==================== 辅助工具 ====================

function stripByteOrderMark(text) {
    if (!text) return '';
    if (text.charCodeAt(0) === 0xFEFF) {
        return text.slice(1);
    }
    return text;
}

function buildTimestampForFilename(dateObject) {
    const year = dateObject.getFullYear();
    const month = String(dateObject.getMonth() + 1).padStart(2, '0');
    const day = String(dateObject.getDate()).padStart(2, '0');
    const hour = String(dateObject.getHours()).padStart(2, '0');
    const minute = String(dateObject.getMinutes()).padStart(2, '0');
    const second = String(dateObject.getSeconds()).padStart(2, '0');
    return year + month + day + '-' + hour + minute + second;
}

function serializeSettingValue(settingValue) {
    return JSON.stringify(settingValue);
}

// ==================== 导出 ====================

export function exportAllSettings() {
    const exportedData = {};

    for (let index = 0; index < SETTINGS_EXPORTABLE_KEYS.length; index++) {
        const storageKey = SETTINGS_EXPORTABLE_KEYS[index];
        const storedValue = loadFromLocalStorage(storageKey, undefined);
        if (storedValue !== undefined) {
            exportedData[storageKey] = storedValue;
        }
    }

    const payloadObject = {
        _meta: {
            type: SETTINGS_FILE_TYPE,
            version: SETTINGS_FILE_VERSION,
            appVersion: CONFIG.APP_VERSION,
            exportedAt: new Date().toISOString()
        },
        data: exportedData
    };

    let serializedJson;
    try {
        serializedJson = JSON.stringify(payloadObject, null, 2);
    } catch (serializeError) {
        console.error('设置序列化失败:', serializeError);
        showToast('❌ 设置序列化失败（可能存在循环引用）', true);
        return;
    }

    const settingsBlob = new Blob(
        [serializedJson],
        { type: 'application/json;charset=utf-8' }
    );
    const downloadUrl = URL.createObjectURL(settingsBlob);
    const downloadLink = document.createElement('a');
    const timestampString = buildTimestampForFilename(new Date());
    downloadLink.href = downloadUrl;
    downloadLink.download = 'editor-settings-' + timestampString + '.json';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadUrl);

    const exportedCount = Object.keys(exportedData).length;
    showToast('📤 已导出 ' + exportedCount + ' 项设置');
}

// ==================== 导入 ====================

function parseSettingsJsonText(jsonText) {
    let parsedPayload;
    try {
        parsedPayload = JSON.parse(jsonText);
    } catch (parseError) {
        console.warn('JSON 解析失败:', parseError);
        showToast('❌ 设置文件格式错误（非有效 JSON）', true);
        return null;
    }
    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
        showToast('❌ 设置文件内容无效（顶层不是对象）', true);
        return null;
    }
    return parsedPayload;
}

function validateSettingsMeta(parsedPayload) {
    const metaObject = parsedPayload._meta;
    const hasMetaObject = metaObject
        && typeof metaObject === 'object'
        && !Array.isArray(metaObject);
    const hasMetaType = hasMetaObject && typeof metaObject.type === 'string';

    if (hasMetaObject && hasMetaType && metaObject.type !== SETTINGS_FILE_TYPE) {
        showToast('❌ 不是本编辑器的设置文件', true);
        return false;
    }
    if (!hasMetaType) {
        const proceedWithoutMeta = confirm(
            '该文件缺少编辑器标识信息，可能来自其他来源。\n' +
            '继续导入可能导致设置异常，是否继续？'
        );
        if (!proceedWithoutMeta) return false;
    }
    return true;
}

function countMatchedSettingsKeys(importedData) {
    let totalMatchedCount = 0;
    for (let index = 0; index < SETTINGS_EXPORTABLE_KEYS.length; index++) {
        const storageKey = SETTINGS_EXPORTABLE_KEYS[index];
        if (Object.prototype.hasOwnProperty.call(importedData, storageKey)) {
            totalMatchedCount++;
        }
    }
    return totalMatchedCount;
}

function confirmOverwriteSettings(totalMatchedCount) {
    const overwriteConfirmed = confirm(
        '导入将覆盖当前 ' + totalMatchedCount + ' 项设置（主题、字体、语言、编码等）。\n' +
        '建议先导出备份，是否继续？'
    );
    if (!overwriteConfirmed) return false;

    if (EditorState.codeModified) {
        const continueDespiteUnsaved = confirm(
            '当前编辑器有未明确保存的更改（自动保存已记录到本地）。\n' +
            '导入设置会刷新页面：\n' +
            '  · 自动保存的内容会在页面重载后提示恢复；\n' +
            '  · 但自动保存不是"明确保存"，建议先按 Ctrl+S。\n' +
            '是否继续导入？'
        );
        if (!continueDespiteUnsaved) return false;
    }
    return true;
}

function applySettingsToStorage(importedData) {
    const appliedKeys = [];
    const skippedKeys = [];
    const failedKeys = [];

    for (let index = 0; index < SETTINGS_EXPORTABLE_KEYS.length; index++) {
        const storageKey = SETTINGS_EXPORTABLE_KEYS[index];
        if (!Object.prototype.hasOwnProperty.call(importedData, storageKey)) continue;

        const settingValue = importedData[storageKey];

        if (!isSettingValueValid(storageKey, settingValue)) {
            skippedKeys.push(storageKey);
            continue;
        }

        try {
            const serializedValue = serializeSettingValue(settingValue);
            localStorage.setItem(storageKey, serializedValue);
            const readBackValue = localStorage.getItem(storageKey);
            if (readBackValue === null) {
                throw new Error('写入未持久化');
            }
            appliedKeys.push(storageKey);
        } catch (writeError) {
            failedKeys.push(storageKey);
            console.warn('设置项写入失败:', storageKey, writeError);
        }
    }

    return {
        appliedKeys: appliedKeys,
        skippedKeys: skippedKeys,
        failedKeys: failedKeys
    };
}

function reportImportResult(appliedKeys, skippedKeys, failedKeys) {
    let resultMessage = '📥 已导入 ' + appliedKeys.length + ' 项设置';
    if (skippedKeys.length > 0) {
        resultMessage += '，跳过 ' + skippedKeys.length + ' 项（格式不兼容）';
    }
    if (failedKeys.length > 0) {
        resultMessage += '，失败 ' + failedKeys.length + ' 项（存储空间可能已满）';
    }

    const isErrorResult = failedKeys.length > 0 || appliedKeys.length === 0;

    if (appliedKeys.length > 0) {
        resultMessage += '，页面即将刷新...';
    } else {
        resultMessage += '。未刷新页面。';
    }

    showToast(resultMessage, isErrorResult);

    if (skippedKeys.length > 0) {
        console.warn('跳过的设置项:', skippedKeys);
    }
    if (failedKeys.length > 0) {
        console.warn('写入失败的设置项:', failedKeys);
    }

    return appliedKeys.length > 0;
}

export function importAllSettingsFromFile(selectedFile) {
    if (!selectedFile) return;

    if (selectedFile.size > CONFIG.SETTINGS_FILE_MAX_SIZE) {
        const maxMegabytes = (CONFIG.SETTINGS_FILE_MAX_SIZE / (1024 * 1024)).toFixed(0);
        showToast('❌ 设置文件过大（最大 ' + maxMegabytes + 'MB）', true);
        return;
    }

    const settingsFileReader = new FileReader();

    settingsFileReader.onload = function(loadEvent) {
        let rawText = String(loadEvent.target.result || '');
        rawText = stripByteOrderMark(rawText);

        const parsedPayload = parseSettingsJsonText(rawText);
        if (!parsedPayload) return;

        const importedData = parsedPayload.data;
        if (!importedData || typeof importedData !== 'object' || Array.isArray(importedData)) {
            showToast('❌ 设置文件缺少 data 字段', true);
            return;
        }

        if (!validateSettingsMeta(parsedPayload)) return;

        const totalMatchedCount = countMatchedSettingsKeys(importedData);
        if (totalMatchedCount === 0) {
            showToast('⚠️ 设置文件中没有可导入的设置项', true);
            return;
        }

        if (!confirmOverwriteSettings(totalMatchedCount)) return;

        const result = applySettingsToStorage(importedData);
        const shouldReload = reportImportResult(
            result.appliedKeys,
            result.skippedKeys,
            result.failedKeys
        );

        if (!shouldReload) {
            return;
        }

        EditorState.skipBeforeUnload = true;
        EditorState.skipBeforeUnloadExpiresAt =
            Date.now() + CONFIG.SETTINGS_SKIP_BEFOREUNLOAD_TTL_MS;

        setTimeout(function() {
            window.location.reload();
        }, CONFIG.SETTINGS_RELOAD_DELAY_MS);
    };

    settingsFileReader.onerror = function() {
        showToast('❌ 设置文件读取失败', true);
    };

    settingsFileReader.readAsText(selectedFile, 'utf-8');
}

// ==================== 事件绑定 ====================

export function setupSettingsIOEvents() {
    if (isSettingsIOInitialized) return;
    if (!DOM.btnSettingsIO || !DOM.settingsIODropdown) return;

    isSettingsIOInitialized = true;

    DOM.btnSettingsIO.addEventListener('click', function(event) {
        event.stopPropagation();
        toggleSettingsDropdown();
    });

    DOM.btnSettingsIO.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && isSettingsDropdownVisible()) {
            event.preventDefault();
            hideSettingsDropdown();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            if (!isSettingsDropdownVisible()) {
                event.preventDefault();
                showSettingsDropdown();
                focusFirstSettingsMenuItem();
            }
        }
    });

    DOM.settingsIODropdown.addEventListener('click', function(event) {
        const menuItem = event.target.closest('.settings-io-item');
        if (!menuItem) return;
        const actionName = menuItem.getAttribute('data-action');
        hideSettingsDropdown();
        if (actionName === 'export') {
            exportAllSettings();
        } else if (actionName === 'import') {
            if (DOM.settingsFileInput) {
                DOM.settingsFileInput.click();
            }
        }
    });

    DOM.settingsIODropdown.addEventListener('keydown', function(event) {
        const menuItems = Array.from(
            DOM.settingsIODropdown.querySelectorAll('.settings-io-item')
        );
        if (menuItems.length === 0) return;

        const activeItem = document.activeElement;
        const activeIndex = menuItems.indexOf(activeItem);

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            const nextIndex = activeIndex < 0
                ? 0
                : (activeIndex + 1) % menuItems.length;
            menuItems[nextIndex].focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            const previousIndex = activeIndex < 0
                ? menuItems.length - 1
                : (activeIndex - 1 + menuItems.length) % menuItems.length;
            menuItems[previousIndex].focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (activeItem && menuItems.indexOf(activeItem) !== -1) {
                activeItem.click();
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            hideSettingsDropdown();
            if (DOM.btnSettingsIO) DOM.btnSettingsIO.focus();
        } else if (event.key === 'Tab') {
            hideSettingsDropdown();
        }
    });

    if (DOM.settingsFileInput) {
        DOM.settingsFileInput.addEventListener('change', function(event) {
            const selectedFile = event.target.files[0];
            if (selectedFile) {
                importAllSettingsFromFile(selectedFile);
            }
            event.target.value = '';
        });
    }

    document.addEventListener('pointerdown', function(event) {
        if (!isSettingsDropdownVisible()) return;
        const wrapperElement = DOM.settingsIOWrapper;
        if (wrapperElement && wrapperElement.contains(event.target)) return;
        hideSettingsDropdown();
    }, { passive: true });

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && isSettingsDropdownVisible()) {
            hideSettingsDropdown();
        }
    });
}