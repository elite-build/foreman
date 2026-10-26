// Each workspace gets a block of ports so parallel dev servers don't collide.
import net from 'node:net'

export const PORT_BLOCK_SIZE = 10
const FIRST_PORT = 50_000
const LAST_PORT = 60_000

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** First block whose base is unassigned and currently free. */
export async function allocatePortBlock(assigned: Iterable<number>): Promise<number> {
  const taken = new Set(assigned)
  for (let base = FIRST_PORT; base + PORT_BLOCK_SIZE <= LAST_PORT; base += PORT_BLOCK_SIZE) {
    if (taken.has(base)) continue
    if (await isPortFree(base)) return base
  }
  throw new Error('No free port block left')
}
