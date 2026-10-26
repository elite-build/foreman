import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // cli is the `foreman` command (bin/foreman.mjs); it runs in plain Node, outside Electron.
    // sttHelper is the speech-to-text helper (speech/sttHelper.ts): Foreman's own binary in Node mode runs it, so it needs a file of its own.
    // sandboxHost and sandboxAttach run in plain Node inside a cloud workspace's sandbox (agentHost/sandbox*.ts).
    build: {
      rolldownOptions: {
        input: {
          index: 'src/main/index.ts',
          cli: 'src/cli/index.ts',
          cursorWorker: 'src/main/cursorWorker.ts',
          sttHelper: 'src/main/speech/sttHelper.ts',
          sandboxHost: 'src/main/agentHost/sandboxHost.ts',
          sandboxAttach: 'src/main/agentHost/sandboxAttach.ts'
        }
      }
    }
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: { rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react()]
  }
})
