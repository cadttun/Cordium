/**
 * @param {string} href 插件模块的 file: URL
 * @returns {Promise<string | null>} `位置\n源码行\n指示符`，或 null
 */
export declare function locateSyntaxError(href: string): Promise<string | null>;
