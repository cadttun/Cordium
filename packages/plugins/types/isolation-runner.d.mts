export type IsolationRequest = {
    href: string;
    exportName: string;
    /**
     * 插件函数参数（任意值）
     */
    args: unknown[];
    /**
     * 回包关联标识（父侧生成；runner 原样带回）
     */
    nonce?: string;
};
