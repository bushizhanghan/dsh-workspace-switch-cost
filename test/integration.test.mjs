// Integration test: boot the plugin against a fake ctx and drive every tool
// against the real session logs on this machine.
import { apply } from '../lib/index.js'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const registry = new Map()
const fakeCtx = { tools: { register: (t) => registry.set(t.name, t) } }
apply(fakeCtx, { maxSessions: 20 })

const SESSIONS = join(homedir(), '.dsh', 'sessions')

// find one real session log that has turns (the root has a workspace level)
function realSession() {
  for (const ws of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const d of readdirSync(join(SESSIONS, ws.name), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const f = join(SESSIONS, ws.name, d.name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      try {
        const text = execFileSync('zstd', ['-dc', f], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
        if (text.includes('"request/header"') && text.includes('"turn/start"')) return { file: f, workspace: ws.name }
      } catch {}
    }
  }
  return null
}

const results = []
const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

try {
  const expected = ['wsc_audit', 'wsc_compare', 'wsc_recommend']
  results.push([`${expected.length} tools registered`, expected.every((n) => registry.has(n))])
  results.push(['every tool declares a read-only presentCall', [...registry.values()].every((t) => t.presentCall({}).kind === 'read' && t.presentCall({}).card === 'generic')])

  const found = realSession()
  results.push(['found a real session log on this machine', found !== null])

  if (found) {
    const audit = await call('wsc_audit', { session: found.file })
    results.push(['wsc_audit runs on a real session', audit.ok === true])
    results.push(['wsc_audit reports a cold start with all four line items', audit.ok && audit.entry.coldStartChars > 10000 && audit.entry.items.system && audit.entry.items['skill-catalog'] && audit.entry.items.tools])
    results.push(['wsc_audit reports tool schemas as a measured line item', audit.ok && audit.entry.items.tools.chars > 0 && audit.entry.items.tools.toolCount > 0])
    results.push(['wsc_audit measures the steady state and the turn it is reached', audit.ok && typeof audit.entry.steadyStateChars === 'number' && audit.entry.steadyStateTurn >= 1])
    results.push(['wsc_audit produces a text report', typeof audit.report === 'string' && audit.report.includes('cold start')])
    results.push(['wsc_audit findings are structured', Array.isArray(audit.findings) && audit.findings.every((f) => f.rule && f.severity && f.title && f.detail)])

    // Slug resolution is checked against a workspace the tool's own sweep can
    // reach: ound comes from a full directory walk, while wsc_audit scans
    // the newest N sessions, so the oldest workspace may legitimately be out of
    // range. Ask the audit for the slug it just reported and confirm the
    // by-slug route lands on the same workspace.
    const reachable = await call('wsc_compare', { dir: SESSIONS, limit: 20 })
    const anyWs = reachable.workspaces?.[0]?.workspace
    const bySlug = anyWs ? await call('wsc_audit', { workspace: anyWs }) : { ok: false }
    results.push(['wsc_audit resolves a workspace slug without an explicit session', bySlug.ok === true && bySlug.entry.slug === anyWs])

    const missing = await call('wsc_audit', { session: 'Z:/nope/nothing.zstd' })
    results.push(['a missing session is an error, not a throw', missing.ok === false])
  }

  const compare = await call('wsc_compare', { dir: SESSIONS, limit: 20 })
  results.push(['wsc_compare sweeps real sessions', compare.ok === true && compare.workspaces.length >= 1])
  results.push(['wsc_compare ranks by entry cost', compare.ok && compare.workspaces.every((w, i, a) => i === 0 || a[i - 1].entryCostChars >= w.entryCostChars)])
  // Attribution needs >= 3 workspaces to compute a correlation. A machine with
  // only two real workspaces must get the honest "not enough data" answer
  // rather than a fabricated one, so accept either shape.
  const attributionOk = compare.ok && (compare.attribution.factors.length === 3 ? Boolean(compare.attribution.biggestItem) : /need at least 3/.test(compare.attribution.note || ''))
  results.push(['wsc_compare attributes the cost', attributionOk])
  results.push(['wsc_compare reports a spread per factor', compare.ok && compare.attribution.factors.every((f) => f.spread && typeof f.r !== 'undefined')])
  results.push(['wsc_compare produces a text report', typeof compare.report === 'string' && compare.report.includes('entry cost comparison')])

  const rec = await call('wsc_recommend', { dir: SESSIONS, limit: 20 })
  results.push(['wsc_recommend sweeps real sessions', rec.ok === true && rec.rows.length >= 1])
  results.push(['wsc_recommend gives every workspace a verdict with a reason', rec.ok && rec.rows.every((r) => ['keep-warm', 'archive', 'watch'].includes(r.verdict) && r.why.length > 0 && r.frequency.perDay >= 0)])
  results.push(['wsc_recommend ranks by cost x frequency', rec.ok && rec.rows.every((r, i, a) => i === 0 || a[i - 1].costPerDayChars >= r.costPerDayChars)])
  results.push(['wsc_recommend produces a text report', typeof rec.report === 'string' && rec.report.includes('keep warm')])

  // the empty-root case must not throw
  const empty = await call('wsc_compare', { dir: 'Z:/nope' })
  results.push(['an empty sessions root is an error, not a throw', empty.ok === false])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
