// 故意的语法错：测试「加载失败时报出文件与行号」（第 3 行少了右值）
export const manifest = { id: 'demo.syntax', version: '1.0.0', apiVersion: '1.0.0' };
export const broken = ;
