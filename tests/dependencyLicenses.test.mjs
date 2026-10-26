import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { licenseErrors } from '../scripts/check-licenses.mjs'

const notice = 'Copyright example\nPermission notice\n'
function fixture(distribution = 'allowed') {
  const pkg = { version: '1.0.0', integrity: 'sha512-reviewed-artifact' }
  const entry = { path: 'node_modules/example', ...pkg, declaredLicense: null }
  return {
    lock: { packages: { '': { license: 'Apache-2.0' }, [entry.path]: pkg } },
    policy: { schemaVersion: 1, reviews: [{ id: 'example', license: 'MIT', source: 'https://example.org/source/commit', notice: 'docs/licenses/example.txt', noticeSha256: createHash('sha256').update(notice).digest('hex'), reason: 'Verified published license text', distribution, packages: [entry] }] }
  }
}

test('missing metadata requires evidence for that exact artifact', () => {
  const { lock, policy } = fixture()
  assert.deepEqual(licenseErrors(lock, policy, () => notice), [])
  assert.match(licenseErrors(lock, { schemaVersion: 1, reviews: [] }, () => notice).join(), /unreviewed UNKNOWN/)
  lock.packages['node_modules/example'].version = '2.0.0'
  assert.match(licenseErrors(lock, policy, () => notice).join(), /renew license evidence/)
})

test('integrity, declared terms, notice contents and missing notices fail closed', () => {
  for (const key of ['integrity', 'license']) {
    const { lock, policy } = fixture()
    lock.packages['node_modules/example'][key] = 'changed'
    assert.match(licenseErrors(lock, policy, () => notice).join(), /renew license evidence/)
  }
  const { lock, policy } = fixture()
  assert.match(licenseErrors(lock, policy, () => 'changed').join(), /notice changed/)
  assert.match(licenseErrors(lock, policy, () => { throw new Error('missing') }).join(), /notice missing/)
  assert.deepEqual(licenseErrors(lock, policy, () => notice.replaceAll('\n', '\r\n')), [])
})

test('a source reference does not clear proprietary or source-offer distribution', () => {
  for (const status of ['review-required', 'source-required']) {
    const { lock, policy } = fixture(status)
    assert.deepEqual(licenseErrors(lock, policy, () => notice), [])
    assert.equal(licenseErrors(lock, policy, () => notice, { distribution: true }).length, 1)
  }
})

test('new unknown packages and versionless optional placeholders are not exempt', () => {
  const { lock, policy } = fixture()
  lock.packages['node_modules/unknown'] = { optional: true }
  const errors = licenseErrors(lock, policy, () => notice)
  assert.ok(errors.some(error => error.includes('incomplete package identity')))
  assert.ok(errors.some(error => error.includes('unreviewed UNKNOWN')))
})

test('stale, duplicate and malformed reviews require attention', () => {
  const { lock, policy } = fixture()
  policy.reviews.push(structuredClone(policy.reviews[0]))
  assert.match(licenseErrors(lock, policy, () => notice).join(), /duplicate/)
  delete lock.packages['node_modules/example']
  assert.match(licenseErrors(lock, policy, () => notice).join(), /stale/)
  policy.reviews[0].notice = '../outside.txt'
  assert.match(licenseErrors(lock, policy, () => notice).join(), /incomplete license evidence/)
})
