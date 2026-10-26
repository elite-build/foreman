// The one local speech model, and its download.
//
// Model: the sherpa-onnx streaming Zipformer English model of 2023-06-26 (icefall, Apache-2.0), int8 files,
// chunk-16 / left-128. The release page offers it only as a 310 MB .tar.bz2 that also holds the float
// files; the same files sit one by one in the author's Hugging Face repository, so we fetch just the four we
// run (about 73 MB), over HTTPS, pinned to one commit, each checked for exact size and SHA-256. That also
// means no archive extraction (Node has no bzip2 or tar, and the `tar` package is not a runtime dependency).
// The hashes below are Hugging Face's LFS object ids for the pinned commit (tokens.txt, a plain file, was
// hashed by hand). The model writes upper-case English with no punctuation; local.ts tidies that.
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MainEvent } from '../../shared/types'
import type { HelperModelFiles } from './protocol'

export interface SttModelFile {
  name: string
  bytes: number
  sha256: string
}

export interface SttModelInfo {
  /** Folder name under `<data dir>/stt-models/`. */
  name: string
  /** Where it comes from, for the consent dialog. */
  source: string
  baseUrl: string
  files: SttModelFile[]
  roles: { encoder: string; decoder: string; joiner: string; tokens: string }
}

const REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24'
const REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26'

export const STT_MODEL: SttModelInfo = {
  name: 'sherpa-onnx-streaming-zipformer-en-2023-06-26-int8',
  source: `huggingface.co/${REPO}`,
  baseUrl: `https://huggingface.co/${REPO}/resolve/${REVISION}/`,
  files: [
    { name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', bytes: 71083163, sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1' },
    { name: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', bytes: 1307236, sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02' },
    { name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', bytes: 259335, sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297' },
    { name: 'tokens.txt', bytes: 5048, sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb' }
  ],
  roles: {
    encoder: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
    decoder: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
    joiner: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
    tokens: 'tokens.txt'
  }
}

export type SttModelState = 'missing' | 'downloading' | 'ready'

export interface SttModelStatus {
  state: SttModelState
  bytes?: number
  total?: number
  name: string
  sizeMb: number
  source: string
}

export interface SttModelsOptions {
  /** `<data dir>/stt-models`. */
  dir: string
  broadcast(event: MainEvent): void
  fetch?: typeof fetch
  model?: SttModelInfo
  /** Minimum milliseconds between progress events. */
  progressMs?: number
}

const totalBytes = (model: SttModelInfo) => model.files.reduce((sum, file) => sum + file.bytes, 0)

export class SttModels {
  private readonly model: SttModelInfo
  private job: Promise<void> | null = null
  private bytes = 0

  constructor(private options: SttModelsOptions) {
    this.model = options.model ?? STT_MODEL
  }

  private get dir(): string {
    return path.join(this.options.dir, this.model.name)
  }

  private complete(): boolean {
    return this.model.files.every((file) => {
      try {
        return statSync(path.join(this.dir, file.name)).size === file.bytes
      } catch {
        return false
      }
    })
  }

  status(): SttModelStatus {
    const info = { name: this.model.name, sizeMb: Math.round(totalBytes(this.model) / 1e6), source: this.model.source }
    if (this.job) return { state: 'downloading', bytes: this.bytes, total: totalBytes(this.model), ...info }
    return { state: this.complete() ? 'ready' : 'missing', ...info }
  }

  /** Absolute paths of the model's files, or null when it is not on disk. */
  files(): HelperModelFiles | null {
    if (this.job || !this.complete()) return null
    const at = (name: string) => path.join(this.dir, name)
    const { roles } = this.model
    return { encoder: at(roles.encoder), decoder: at(roles.decoder), joiner: at(roles.joiner), tokens: at(roles.tokens) }
  }

  /** Download and check the model. A second call while one runs waits for the same download. */
  download(): Promise<void> {
    if (this.complete()) return Promise.resolve()
    this.job ??= this.run().finally(() => {
      this.job = null
    })
    return this.job
  }

  private emit(state: SttModelState): void {
    const total = totalBytes(this.model)
    this.options.broadcast(state === 'downloading' ? { type: 'stt-model', state, bytes: this.bytes, total } : { type: 'stt-model', state })
  }

  private async run(): Promise<void> {
    const staging = `${this.dir}.partial`
    const get = this.options.fetch ?? fetch
    this.bytes = 0
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    this.emit('downloading')
    let lastEvent = Date.now()
    try {
      for (const file of this.model.files) {
        const response = await get(this.model.baseUrl + file.name, { redirect: 'follow' })
        if (!response.ok || !response.body) throw new Error(`The server answered ${response.status} for ${file.name}`)
        const hash = createHash('sha256')
        let size = 0
        const meter = new Transform({
          transform: (chunk: Buffer, _encoding, done) => {
            hash.update(chunk)
            size += chunk.length
            this.bytes += chunk.length
            const now = Date.now()
            if (now - lastEvent >= (this.options.progressMs ?? 250)) {
              lastEvent = now
              this.emit('downloading')
            }
            done(null, chunk)
          }
        })
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(path.join(staging, file.name)))
        if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`${file.name} did not match its published size and checksum`)
      }
      rmSync(this.dir, { recursive: true, force: true })
      renameSync(staging, this.dir)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      this.bytes = 0
      // `job` is still set here; clear it first so the status the renderer reads next is `missing`.
      this.job = null
      this.emit('missing')
      throw new Error(`The speech model could not be downloaded: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.bytes = 0
    this.job = null
    this.emit('ready')
  }
}
