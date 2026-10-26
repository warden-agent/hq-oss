import { createHash, randomUUID } from 'node:crypto'
export const id = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
export const short = (s: string): string => sha(s).slice(0, 12)
/** POSIX shell single-quote quoting (printf %q equivalent for our purposes). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export function j<T>(s: string | null | undefined, fallback: T): T { try { return s ? (JSON.parse(s) as T) : fallback } catch { return fallback } }
/** A request body over the limit (the servers answer 413). */
export class TooLarge extends Error {}
/** A request's JSON body (undefined when empty or not JSON). Past `limit` bytes the rest is read and dropped, then it throws
 *  TooLarge, so the client still gets the 413 instead of a cut-off connection. */
export function readJson(req: import('node:http').IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size <= limit) chunks.push(c) })
    req.on('error', reject)
    req.on('end', () => { if (size > limit) return reject(new TooLarge(`request body over ${limit} bytes`)); const b = Buffer.concat(chunks).toString('utf8'); try { resolve(b ? JSON.parse(b) : undefined) } catch { resolve(undefined) } })
  })
}
/** A JSON body as an object ({} when it's missing or isn't one). */
export const asObject = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
