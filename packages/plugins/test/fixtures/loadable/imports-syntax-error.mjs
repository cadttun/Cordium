// 语法本身没错，但依赖里有语法错 ⇒ 报的应是依赖文件的位置
import './syntax-error.mjs';
export const manifest = { id: 'demo.dep', version: '1.0.0', apiVersion: '1.0.0' };
