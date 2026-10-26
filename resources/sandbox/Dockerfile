# Foreman's Docker sandbox image (src/main/cloud/dockerProvider.ts builds it on each daemon, tagged
# foreman-sandbox:<hash of this file>, so editing it rebuilds). Derived from Vercel's open-source
# universal image (github.com/vercel/sandbox images/ubuntu and images/universal) so a Docker workspace
# matches a Vercel one: user ubuntu (uid 1000) with passwordless sudo, HOME=/vercel, the clone in
# /vercel/sandbox/repo and Foreman's host in /vercel/foreman. Built from stdin with no context, so it
# works the same against a remote daemon; any architecture Node publishes (a LAN box may be arm64).
FROM ubuntu:26.04

ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils && \
    install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      bzip2 dnsutils file gh git git-lfs iproute2 iputils-ping jq less lsof nano \
      netcat-openbsd openssl procps python-is-python3 python3 python3-pip python3-venv \
      ripgrep rsync sqlite3 sudo tmux tree unzip util-linux vim wget zip && \
    rm -f /usr/lib/python3*/EXTERNALLY-MANAGED && \
    rm -rf /var/lib/apt/lists/* && \
    git lfs install --system

# Node from nodejs.org, the latest of the major, checked against its SHASUMS.
RUN case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "No Node build for $(dpkg --print-architecture)" >&2; exit 1 ;; esac && \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" && \
    curl -fsSL "$base/SHASUMS256.txt" | grep "linux-${arch}.tar.xz\$" > /tmp/node.sha && \
    file="$(awk '{print $2}' /tmp/node.sha)" && \
    curl -fsSL "$base/$file" -o "/tmp/$file" && \
    (cd /tmp && sha256sum -c node.sha) && \
    tar -xJf "/tmp/$file" --strip-components=1 -C /usr/local --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md && \
    rm -f "/tmp/$file" /tmp/node.sha && \
    npm install -g pnpm && \
    npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai && \
    npm cache clean --force

# The user every command runs as: passwordless sudo that keeps the environment (a command's GH_TOKEN).
RUN id ubuntu >/dev/null 2>&1 || useradd --uid 1000 --create-home --shell /bin/bash ubuntu && \
    printf '%s\n' \
      'Defaults always_set_home' \
      'Defaults !env_reset' \
      'Defaults !fqdn' \
      'Defaults !secure_path' \
      'ubuntu ALL=(ALL) NOPASSWD:ALL' \
      > /etc/sudoers.d/sandbox && \
    chmod 0440 /etc/sudoers.d/sandbox && \
    install -d -o ubuntu -g ubuntu /vercel /vercel/sandbox /vercel/foreman && \
    usermod --home /vercel --shell /bin/bash ubuntu && \
    printf '%s\n' 'export PATH="/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
      > /etc/profile.d/foreman-path.sh

ENV HOME=/vercel
ENV SHELL=/bin/bash
USER ubuntu
WORKDIR /vercel

RUN mkdir -p ~/.global/npm ~/.global/pnpm && \
    npm config set prefix ~/.global/npm && \
    pnpm config set global-dir ~/.global/pnpm && \
    pnpm config set global-bin-dir ~/.global/pnpm/bin

ENV PATH="/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN node --version && npm --version && git --version && gh --version && sudo whoami && \
    claude --version && codex --version && opencode --version

WORKDIR /vercel/sandbox
CMD ["sleep", "infinity"]
