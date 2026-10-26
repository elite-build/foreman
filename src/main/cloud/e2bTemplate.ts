// Foreman's E2B template: the Docker provider's image
// (resources/sandbox/Dockerfile) adapted to E2B, built on E2B's builders with the SDK's Template.build and
// the connection's API key alone (no CLI, no local Docker). A sandbox's size is fixed by its template, so
// each vCPU option is its own template, named for the Dockerfile's hash: editing the Dockerfile builds new
// ones. A build is a one-time step per team and size that takes minutes.
import { createHash } from 'node:crypto'

/**
 * E2B's `user` (its default, which E2B provisions; made here if missing) with passwordless sudo and HOME=/vercel,
 * the clone in /vercel/sandbox/repo, Foreman's host in /vercel/foreman. ENV only lasts through the build on E2B,
 * so PATH goes in /etc/profile.d (every command runs in a login bash). Ubuntu 24.04 rather than the Docker image's
 * 26.04: E2B provisions its own init and envd into the image, and 24.04 is the release it is known to work with.
 */
export const E2B_DOCKERFILE = `FROM ubuntu:24.04

ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24

RUN apt-get update && \\
    apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils && \\
    install -d -m 0755 /etc/apt/keyrings && \\
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends \\
      bzip2 dnsutils file gh git git-lfs iproute2 iputils-ping jq less lsof nano \\
      netcat-openbsd openssl procps python-is-python3 python3 python3-pip python3-venv \\
      ripgrep rsync sqlite3 sudo tmux tree unzip util-linux vim wget zip && \\
    rm -f /usr/lib/python3*/EXTERNALLY-MANAGED && \\
    rm -rf /var/lib/apt/lists/* && \\
    git lfs install --system

RUN case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "No Node build for $(dpkg --print-architecture)" >&2; exit 1 ;; esac && \\
    base="https://nodejs.org/dist/latest-v\${NODE_MAJOR}.x" && \\
    curl -fsSL "$base/SHASUMS256.txt" | grep "linux-\${arch}.tar.xz\\$" > /tmp/node.sha && \\
    file="$(awk '{print $2}' /tmp/node.sha)" && \\
    curl -fsSL "$base/$file" -o "/tmp/$file" && \\
    (cd /tmp && sha256sum -c node.sha) && \\
    tar -xJf "/tmp/$file" --strip-components=1 -C /usr/local --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md && \\
    rm -f "/tmp/$file" /tmp/node.sha && \\
    npm install -g pnpm @anthropic-ai/claude-code @openai/codex opencode-ai && \\
    npm cache clean --force

RUN (id user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user) && \\
    printf '%s\\n' 'Defaults always_set_home' 'Defaults !env_reset' 'Defaults !fqdn' 'Defaults !secure_path' 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/foreman && \\
    chmod 0440 /etc/sudoers.d/foreman && \\
    install -d -o user -g user /vercel /vercel/sandbox /vercel/foreman && \\
    usermod --home /vercel --shell /bin/bash user && \\
    printf '%s\\n' 'export PATH="/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/profile.d/foreman-path.sh

ENV HOME=/vercel
USER user
WORKDIR /vercel

RUN mkdir -p ~/.global/npm ~/.global/pnpm && \\
    npm config set prefix ~/.global/npm && \\
    pnpm config set global-dir ~/.global/pnpm && \\
    pnpm config set global-bin-dir ~/.global/pnpm/bin

RUN node --version && npm --version && git --version && gh --version && sudo whoami && \\
    claude --version && codex --version && opencode --version

WORKDIR /vercel/sandbox
`

// Memory per size: 2 GiB per vCPU as on Vercel, within E2B's 8 GiB per sandbox on Hobby. Pausing takes about
// 4 s per GiB, so this is also what a stop costs in time.
export const E2B_SIZES: Record<number, { memoryMB: number }> = { 2: { memoryMB: 4096 }, 4: { memoryMB: 8192 }, 8: { memoryMB: 8192 } }
export const E2B_VCPU_OPTIONS = Object.keys(E2B_SIZES).map(Number)

const HASH = createHash('sha256').update(E2B_DOCKERFILE).digest('hex').slice(0, 8)

/** The template for a size: foreman-sandbox-<hash>-<vcpus>cpu. Sizes E2B doesn't list round down to one it does. */
export function e2bTemplateName(vcpus: number): string {
  return `foreman-sandbox-${HASH}-${e2bSize(vcpus)}cpu`
}

export function e2bSize(vcpus: number): number {
  const fits = E2B_VCPU_OPTIONS.filter((v) => v <= vcpus)
  return fits.length ? Math.max(...fits) : E2B_VCPU_OPTIONS[0]
}

/** The parts of the SDK's Template this uses, so tests can stand in for it. */
export interface TemplateSdk {
  Template: {
    (): { fromDockerfile(content: string): unknown }
    exists(name: string, opts: { apiKey: string; domain?: string }): Promise<boolean>
    build(template: never, name: string, opts: { apiKey: string; domain?: string; cpuCount: number; memoryMB: number; onBuildLogs?: (entry: { toString(): string }) => void }): Promise<unknown>
  }
}

// One build per team and template at a time: two workspaces made at once wait on the same build.
const building = new Map<string, Promise<string>>()

/**
 * The template for `vcpus`, built first if this team has none (minutes, once). `log` gets the build's lines; the
 * error of a failed build carries its last lines.
 */
export function ensureE2bTemplate(sdk: TemplateSdk, creds: { apiKey: string; domain?: string }, vcpus: number, log: (line: string) => void = () => undefined): Promise<string> {
  const name = e2bTemplateName(vcpus)
  const key = `${createHash('sha256').update(creds.apiKey).digest('hex').slice(0, 16)}|${creds.domain ?? ''}|${name}`
  const inFlight = building.get(key)
  if (inFlight) return inFlight
  const auth = { apiKey: creds.apiKey, ...(creds.domain ? { domain: creds.domain } : {}) }
  const job = (async () => {
    if (await sdk.Template.exists(name, auth)) return name
    const size = e2bSize(vcpus)
    log(`Building the E2B template ${name} (${size} vCPUs). This happens once per size and takes a few minutes.\n`)
    const tail: string[] = []
    try {
      await sdk.Template.build(sdk.Template().fromDockerfile(E2B_DOCKERFILE) as never, name, {
        ...auth,
        cpuCount: size,
        memoryMB: E2B_SIZES[size].memoryMB,
        onBuildLogs: (entry) => {
          const line = String(entry)
          tail.push(line)
          if (tail.length > 20) tail.shift()
          log(`${line}\n`)
        }
      })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(`Building the E2B template ${name} failed: ${why}${tail.length ? `\n${tail.join('\n')}` : ''}`)
    }
    log(`Built ${name}.\n`)
    return name
  })()
  building.set(key, job)
  // A failed build can be tried again; a finished one is answered by exists() next time.
  void job.finally(() => building.delete(key)).catch(() => undefined)
  return job
}
