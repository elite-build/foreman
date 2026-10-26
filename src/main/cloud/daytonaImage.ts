// The Foreman image on Daytona: the same environment as the
// Docker image (resources/sandbox/Dockerfile, itself after Vercel's universal image), as Dockerfile
// instructions after a base, built by Daytona into one snapshot per size and region. Kept as code rather
// than a resource file so the main bundle carries it. Snapshot names carry a hash of it, so editing it
// builds new snapshots (the old ones go inactive after two weeks unused).
import { createHash } from 'node:crypto'

// Daytona refuses `latest`-style tags for snapshot images.
export const DAYTONA_BASE_IMAGE = 'ubuntu:24.04'

export const DAYTONA_DOCKERFILE: string[] = [
  'ENV LANG=C.UTF-8',
  'ARG DEBIAN_FRONTEND=noninteractive',
  'ARG NODE_MAJOR=24',
  `RUN apt-get update && \\
    apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils && \\
    install -d -m 0755 /etc/apt/keyrings && \\
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \\
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\
    apt-get update && \\
    apt-get install -y --no-install-recommends \\
      bzip2 coreutils file gh git git-lfs iproute2 jq less lsof nano netcat-openbsd openssl procps \\
      python-is-python3 python3 python3-pip python3-venv ripgrep rsync sqlite3 sudo tmux tree unzip vim wget zip && \\
    rm -f /usr/lib/python3*/EXTERNALLY-MANAGED && \\
    rm -rf /var/lib/apt/lists/* && \\
    git lfs install --system`,
  // Node from nodejs.org, the latest of the major, checked against its SHASUMS; then the agent CLIs.
  `RUN case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac && \\
    base="https://nodejs.org/dist/latest-v\${NODE_MAJOR}.x" && \\
    curl -fsSL "$base/SHASUMS256.txt" | grep "linux-\${arch}.tar.xz\\$" > /tmp/node.sha && \\
    file="$(awk '{print $2}' /tmp/node.sha)" && \\
    curl -fsSL "$base/$file" -o "/tmp/$file" && \\
    (cd /tmp && sha256sum -c node.sha) && \\
    tar -xJf "/tmp/$file" --strip-components=1 -C /usr/local --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md && \\
    rm -f "/tmp/$file" /tmp/node.sha && \\
    npm install -g pnpm @anthropic-ai/claude-code @openai/codex opencode-ai && \\
    npm cache clean --force`,
  // The command user: uid 1000 with passwordless sudo that keeps a command's environment, HOME=/vercel.
  `RUN (id ubuntu >/dev/null 2>&1 || useradd --uid 1000 --create-home --shell /bin/bash ubuntu) && \\
    printf '%s\\n' 'Defaults always_set_home' 'Defaults !env_reset' 'Defaults !fqdn' 'Defaults !secure_path' 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sandbox && \\
    chmod 0440 /etc/sudoers.d/sandbox && \\
    install -d -o ubuntu -g ubuntu /vercel /vercel/sandbox /vercel/foreman && \\
    usermod --home /vercel --shell /bin/bash ubuntu && \\
    printf '%s\\n' 'export PATH="/vercel/.local/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/profile.d/foreman-path.sh`,
  'ENV HOME=/vercel',
  'ENV SHELL=/bin/bash',
  'USER ubuntu',
  'WORKDIR /vercel',
  'RUN mkdir -p ~/.global/npm && npm config set prefix ~/.global/npm',
  'ENV PATH="/vercel/.local/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  'RUN node --version && git --version && gh --version && sudo whoami && claude --version && codex --version && opencode --version',
  'WORKDIR /vercel/sandbox',
  'CMD ["sleep", "infinity"]'
]

/** Short and stable: a new image definition gets new snapshot names. */
export function daytonaImageHash(): string {
  return createHash('sha256').update(DAYTONA_BASE_IMAGE).update('\n').update(DAYTONA_DOCKERFILE.join('\n')).digest('hex').slice(0, 8)
}

// Daytona's default per-sandbox maximums (docs: 4 vCPU, 8 GiB, 10 GiB).
const MAX_MEMORY_GIB = 8
const DISK_GIB = 10

/** A sandbox's resources for `vcpus`: 2 GiB per vCPU (as Vercel sizes them), the largest default disk. */
export function daytonaResources(vcpus: number): { cpu: number; memory: number; disk: number } {
  return { cpu: vcpus, memory: Math.min(MAX_MEMORY_GIB, 2 * vcpus), disk: DISK_GIB }
}

/**
 * The snapshot a size starts from. A sandbox made from a snapshot gets the snapshot's resources (create takes none
 * with a snapshot), and snapshots belong to a region, so there is one per size and region.
 */
export function daytonaSnapshotName(vcpus: number, region: string | undefined): string {
  return `foreman-sandbox-${daytonaImageHash()}-${region || 'default'}-${vcpus}c`
}
