// Paths the public repository must never hold: design mocks, private planning, build output, local data and keys.
// No imports, so the pre-push hook can use it in a checkout without node_modules. Human review must protect this guard too.

export function forbiddenPath(file) {
  const p = file.replaceAll('\\', '/').toLowerCase()
  return /^(?:design|\.publication-private|out|dist|release|node_modules|\.workspace-people-cache)\//.test(p)
    || /^docs\/[^/]+-spec\//.test(p)
    || /^(?:features\.md|publication-[^/]+\.md)$/.test(p)
    || /(?:^|\/)(?:state\.json|foreman\.db(?:-wal|-shm)?|secrets\.json|credentials\.json)$/.test(p)
    || /(?:^|\/)\.env(?:\..*)?$/.test(p) && !/(?:^|\/)\.env\.(?:example|sample)$/.test(p)
    || /\.(?:pem|key|p8|p12|pfx|log)$/.test(p)
    || /(?:^|\/)(?:mocks?(?:[-.][^/]*)?|mockups?)(?:\/|\.html$)/.test(p)
}
