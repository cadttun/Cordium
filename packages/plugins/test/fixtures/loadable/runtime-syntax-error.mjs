// 语法正确，但【顶层执行时】抛 SyntaxError（JSON.parse）——
// 加载器会去子进程探位置；这里用副作用计数证明：探测只解析不执行（计数必须只有主进程那 1 次）
import { appendFileSync } from 'node:fs';
if (process.env.CORDIUM_EVAL_LOG) appendFileSync(process.env.CORDIUM_EVAL_LOG, 'evaluated\n');
export const manifest = { id: 'demo.runtime', version: '1.0.0', apiVersion: '1.0.0' };
export const config = JSON.parse('{oops');
