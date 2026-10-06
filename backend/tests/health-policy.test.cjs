const { test } = require('node:test')
const assert = require('node:assert/strict')
const { healthOutcome, healthDiagnostic } = require('../dist/modules/provider-health/health-policy.js')
test('health thresholds distinguish single failure, repeated failures, slow success and recovery', () => {
  assert.deepEqual(healthOutcome(false, 0, 50, 3, 2000), { status: 'DEGRADED', consecutiveFailures: 1 })
  assert.deepEqual(healthOutcome(false, 2, 50, 3, 2000), { status: 'UNAVAILABLE', consecutiveFailures: 3 })
  assert.deepEqual(healthOutcome(true, 3, 50, 3, 2000), { status: 'HEALTHY', consecutiveFailures: 0 })
  assert.deepEqual(healthOutcome(true, 3, 2500, 3, 2000), { status: 'DEGRADED', consecutiveFailures: 0 })
})
test('health diagnostics do not serialize SDK errors, credentials, or remote response bodies', () => {
  const raw = { $metadata: { httpStatusCode: 403 }, message: 'secret-key=private', response: { data: { error: 'credential-content' } } }
  const result = healthDiagnostic(raw)
  assert.equal(result.code, 'ACCESS_DENIED')
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(healthDiagnostic({ name: 'AbortError' }).code, 'CHECK_TIMEOUT')
  assert.equal(healthDiagnostic({ response: { status: 429 } }).code, 'RATE_LIMITED')
})
