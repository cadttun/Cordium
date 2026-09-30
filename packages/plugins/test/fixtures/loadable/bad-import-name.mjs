// 语法正确、链接失败：导入了不存在的导出名
import { doesNotExist } from './base.mjs';
export const manifest = { id: 'demo.link', version: '1.0.0', apiVersion: '1.0.0', x: doesNotExist };
