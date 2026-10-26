// The sandbox provider registry: provider id → the factory that
// makes a SandboxProvider from a connection and its secret. SandboxManager resolves a repository's or a
// workspace's provider through here; nothing else picks a provider by id. Factories never touch the network.
import { CLOUD_PROVIDERS, planLimits, type CloudProviderId } from '../../shared/cloud'
import { DAYTONA_API_URL, isSandboxService, type Connection } from '../../shared/integrations'
import { createDaytonaProvider } from './daytonaProvider'
import { createDockerProvider } from './dockerProvider'
import { createE2bProvider } from './e2bProvider'
import { CloudUnavailableError, type SandboxProvider } from './provider'
import { VercelProvider } from './vercelProvider'

/** Makes a provider for a connection. `secret` is the connection's token from the vault (none for Docker). */
export type ProviderFactory = (connection: Connection, secret: string | undefined) => SandboxProvider

function needSecret(connection: Connection, secret: string | undefined): string {
  if (!secret) throw new CloudUnavailableError(`The saved key for ${connection.name} is missing on this computer. Replace it in Settings → Integrations.`)
  return secret
}

export const PROVIDER_FACTORIES: Record<CloudProviderId, ProviderFactory> = {
  vercel: (c, secret) => {
    if (!c.vercel?.teamId || !c.vercel.projectId) throw new CloudUnavailableError('The Vercel connection is incomplete. Edit it in Settings → Integrations.')
    return new VercelProvider({ token: needSecret(c, secret), teamId: c.vercel.teamId, projectId: c.vercel.projectId }, c.vercel.limits ?? planLimits(c.vercel.plan))
  },
  docker: (c) => createDockerProvider({ context: c.docker?.context, host: c.docker?.host }, c.docker),
  e2b: (c, secret) => createE2bProvider({ apiKey: needSecret(c, secret), domain: c.e2b?.domain }, c.e2b),
  daytona: (c, secret) => createDaytonaProvider({ apiKey: needSecret(c, secret), apiUrl: c.daytona?.apiUrl || DAYTONA_API_URL, target: c.daytona?.target }, c.daytona)
}

/** The provider for a ready sandbox connection. One whose module isn't implemented yet is unavailable, not an error. */
export function createProvider(connection: Connection, secret: string | undefined): SandboxProvider {
  if (!isSandboxService(connection.service)) throw new Error(`${connection.name} isn’t a sandbox connection`)
  const info = CLOUD_PROVIDERS[connection.service]
  if (!info.implemented) throw new CloudUnavailableError(`${info.label} remote workspaces are coming soon.`)
  return PROVIDER_FACTORIES[connection.service](connection, secret)
}
