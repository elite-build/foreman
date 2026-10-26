// The `.foreman` file: a header (manifest + entry table) followed by the entries'
// bytes. Backups are wrapped in AES-256-GCM with a scrypt-derived key (Node crypto,
// no dependency). Reading is defensive: nothing in a file is trusted until its
// version, sizes, paths and hashes have been checked, and nothing is executed.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { EXPORT_FORMAT, EXPORT_VERSION, unsafeEntryPath, type ExportManifest } from '../shared/portable'

const MAGIC = Buffer.from('FRMN')
const KIND_PLAIN = 0x50 // 'P'
const KIND_ENCRYPTED = 0x45 // 'E'
const SCRYPT = { N: 1 << 15, r: 8, p: 1 }
// What a file may ask of the reader before it is refused.
const MAX_SCRYPT_N = 1 << 17

export const DEFAULT_LIMITS = {
  fileBytes: 1024 * 1024 * 1024,
  headerBytes: 16 * 1024 * 1024,
  entries: 50_000,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024
}
export type Limits = typeof DEFAULT_LIMITS

export type ExportFileErrorCode = 'not-an-export' | 'unsupported-version' | 'needs-passphrase' | 'bad-passphrase' | 'tampered' | 'unsafe' | 'too-large'

export class ExportFileError extends Error {
  constructor(
    readonly code: ExportFileErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface PackEntry {
  path: string
  data: Buffer
}

export interface ParsedEntry {
  path: string
  size: number
  sha256: string
  data: Buffer
}

interface HeaderEntry {
  path: string
  type: 'file'
  size: number
  sha256: string
  offset: number
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** One hash over every entry's path and hash, in path order. */
export function contentHash(entries: { path: string; sha256: string }[]): string {
  return sha256([...entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => `${e.path}:${e.sha256}`).join('\n'))
}

function frame(kind: number, header: Buffer, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return Buffer.concat([MAGIC, Buffer.from([kind]), length, header, body])
}

export function pack(manifest: Omit<ExportManifest, 'format' | 'version' | 'contentHash'>, entries: PackEntry[]): Buffer {
  const table: HeaderEntry[] = []
  let offset = 0
  for (const entry of entries) {
    const bad = unsafeEntryPath(entry.path)
    if (bad) throw new Error(`Can't pack “${entry.path}”: ${bad}`)
    table.push({ path: entry.path, type: 'file', size: entry.data.length, sha256: sha256(entry.data), offset })
    offset += entry.data.length
  }
  const full: ExportManifest = { ...manifest, format: EXPORT_FORMAT, version: EXPORT_VERSION, contentHash: contentHash(table) }
  const header = Buffer.from(JSON.stringify({ version: EXPORT_VERSION, manifest: full, entries: table }))
  return frame(KIND_PLAIN, header, Buffer.concat(entries.map((e) => e.data)))
}

function scryptKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

/** Wrap a packed file. The header is authenticated along with the contents. */
export async function encrypt(file: Buffer, passphrase: string): Promise<Buffer> {
  if (!passphrase) throw new Error('A backup needs a passphrase')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await scryptKey(passphrase, salt, SCRYPT)
  const header = Buffer.from(JSON.stringify({ version: EXPORT_VERSION, cipher: 'aes-256-gcm', kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64') }))
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(file), cipher.final(), cipher.getAuthTag()])
  return frame(KIND_ENCRYPTED, header, body)
}

function readFrame(file: Buffer, limits: Limits): { kind: number; header: Buffer; body: Buffer } {
  if (file.length > limits.fileBytes) throw new ExportFileError('too-large', 'This file is larger than Foreman will open.')
  if (file.length < MAGIC.length + 5 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new ExportFileError('not-an-export', 'This is not a Foreman export file.')
  const kind = file[MAGIC.length]
  if (kind !== KIND_PLAIN && kind !== KIND_ENCRYPTED) throw new ExportFileError('not-an-export', 'This is not a Foreman export file.')
  const headerLength = file.readUInt32BE(MAGIC.length + 1)
  const start = MAGIC.length + 5
  if (headerLength > limits.headerBytes || start + headerLength > file.length) throw new ExportFileError('tampered', 'The file is truncated or its header is damaged.')
  return { kind, header: file.subarray(start, start + headerLength), body: file.subarray(start + headerLength) }
}

function readHeaderJson(header: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(header.toString('utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Falls through to the error below.
  }
  throw new ExportFileError('tampered', 'The file’s header is damaged.')
}

function checkVersion(version: unknown): void {
  if (version !== EXPORT_VERSION) {
    throw new ExportFileError(
      'unsupported-version',
      typeof version === 'number' && version > EXPORT_VERSION
        ? `This export uses format version ${version}, which this Foreman doesn’t understand. Update Foreman to import it.`
        : `This export uses format version ${String(version)}, which this Foreman doesn’t understand.`
    )
  }
}

/** Whether the file is an encrypted backup, judged from its first bytes. */
export function isEncrypted(file: Buffer): boolean {
  return file.length > MAGIC.length && file.subarray(0, MAGIC.length).equals(MAGIC) && file[MAGIC.length] === KIND_ENCRYPTED
}

/** Undo `encrypt`. A wrong passphrase and a changed file are indistinguishable by design. */
export async function decrypt(file: Buffer, passphrase: string, limits: Limits = DEFAULT_LIMITS): Promise<Buffer> {
  const { kind, header, body } = readFrame(file, limits)
  if (kind !== KIND_ENCRYPTED) return file
  const h = readHeaderJson(header)
  checkVersion(h.version)
  const { N, r, p } = h as { N?: number; r?: number; p?: number }
  if (h.cipher !== 'aes-256-gcm' || h.kdf !== 'scrypt' || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N! < 2 || N! > MAX_SCRYPT_N || (N! & (N! - 1)) !== 0 || r! < 1 || r! > 16 || p! < 1 || p! > 4) {
    throw new ExportFileError('tampered', 'The file’s encryption settings are not ones Foreman wrote.')
  }
  if (!passphrase) throw new ExportFileError('needs-passphrase', 'This backup is encrypted. Enter its passphrase.')
  const salt = Buffer.from(String(h.salt), 'base64')
  const iv = Buffer.from(String(h.iv), 'base64')
  if (salt.length !== 16 || iv.length !== 12 || body.length < 16) throw new ExportFileError('tampered', 'The file is truncated or its header is damaged.')
  const key = await scryptKey(passphrase, salt, { N: N!, r: r!, p: p! })
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(header)
  decipher.setAuthTag(body.subarray(body.length - 16))
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
  } catch {
    throw new ExportFileError('bad-passphrase', 'Wrong passphrase, or the file was changed.')
  }
}

/** Check a packed (already decrypted) file against every rule, and return its contents. */
export function parse(file: Buffer, limits: Limits = DEFAULT_LIMITS): { manifest: ExportManifest; entries: ParsedEntry[] } {
  const { kind, header, body } = readFrame(file, limits)
  if (kind !== KIND_PLAIN) throw new ExportFileError('needs-passphrase', 'This backup is encrypted. Enter its passphrase.')
  const h = readHeaderJson(header)
  checkVersion(h.version)
  const manifest = h.manifest as ExportManifest | undefined
  const table = h.entries
  if (!manifest || manifest.format !== EXPORT_FORMAT || !Array.isArray(table)) throw new ExportFileError('not-an-export', 'This is not a Foreman export file.')
  checkVersion(manifest.version)
  if (table.length > limits.entries) throw new ExportFileError('too-large', `The file lists more than ${limits.entries} entries.`)
  const entries: ParsedEntry[] = []
  const seen = new Set<string>()
  let expectedOffset = 0
  for (const raw of table as Partial<HeaderEntry>[]) {
    if (raw.type !== 'file') throw new ExportFileError('unsafe', `“${String(raw.path)}” is not a plain file (links and special files are refused).`)
    const bad = unsafeEntryPath(raw.path)
    if (bad) throw new ExportFileError('unsafe', `“${String(raw.path)}” is refused: ${bad}.`)
    const entryPath = raw.path as string
    const folded = entryPath.toLowerCase()
    if (seen.has(folded)) throw new ExportFileError('unsafe', `“${entryPath}” appears twice.`)
    seen.add(folded)
    const { size, offset } = raw
    if (!Number.isInteger(size) || size! < 0 || !Number.isInteger(offset) || offset !== expectedOffset || offset! + size! > body.length) {
      throw new ExportFileError('tampered', `“${entryPath}” does not fit inside the file.`)
    }
    if (size! > limits.entryBytes) throw new ExportFileError('too-large', `“${entryPath}” is larger than Foreman will extract.`)
    expectedOffset += size!
    if (expectedOffset > limits.totalBytes) throw new ExportFileError('too-large', 'The file would extract to more than Foreman allows.')
    const data = body.subarray(offset, offset! + size!)
    if (sha256(data) !== raw.sha256) throw new ExportFileError('tampered', `“${entryPath}” does not match its hash: the file was changed or damaged.`)
    entries.push({ path: entryPath, size: size!, sha256: raw.sha256 as string, data })
  }
  if (expectedOffset !== body.length) throw new ExportFileError('tampered', 'The file has bytes the entry list does not account for.')
  if (contentHash(entries) !== manifest.contentHash) throw new ExportFileError('tampered', 'The entry list does not match the manifest.')
  return { manifest, entries }
}
