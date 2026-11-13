import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        // 主进程输出 CJS（.cjs）：Electron 主进程的通行做法，
        // 且 .cjs 扩展名不受 package.json "type": "module" 影响。
        // 注意：调试时若进程表现成纯 Node（require('electron') 返回路径字符串、
        // --version 打印 Node 版本），检查是否继承了 ELECTRON_RUN_AS_NODE 环境变量。
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
  },
});
