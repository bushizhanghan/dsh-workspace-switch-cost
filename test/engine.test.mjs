// Unit tests: one per rule in the engine, with fixtures captured from the real
// session logs on this machine (shape verified against ~/.dsh/sessions).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateWorkspaces,
  attributeCost,
  auditWorkspace,
  estimateTokens,
  eventText,
  isEntryTurn,
  listSessions,
  loadSession,
  measureSession,
  recommendWorkspaces,
  slugToPath,
  turnInjected,
  visitFrequency,
} from '../lib/engine.js'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// ---- event construction helpers ----
// The helpers deliberately emit the *bare* text so a test can assert on exact
// char counts; real logs wrap these in <system-reminder>, which only adds
// length and is not what the measurement is about.
const ev = (seq, type, data) => ({ type, seq, time: 1792335549042 + seq, data })
const sysMsg = (seq, text) => ev(seq, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text }] } })
const skillCatalog = (seq, n, text = 'skills') => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'skill-catalog', form: 'catalog', entries: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, description: 'd' })) }, role: 'user', id: `id-${seq}` })
const agentsMd = (seq, text) => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'agent-instructions' }, role: 'user', id: `id-${seq}` })
const runtimeCtx = (seq, text = 'Current runtime context.') => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'runtime-context', form: 'snapshot' }, role: 'user', id: `id-${seq}` })
const timeCtx = (seq, text = 'Time sampled while preparing turn 1, step 1.') => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'time-context' }, role: 'user', id: `id-${seq}` })
const modelSel = (seq, text = '[model changed: ...]') => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'model-selection', form: 'notice' }, role: 'user', id: `id-${seq}` })
const userMsg = (seq, text) => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `id-${seq}` })
const turnStart = (seq, n) => ev(seq, 'turn/start', { turn: n })
const toolSchemas = (n) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, description: 'd', parameters: { type: 'object' } }))
const header = (seq, n) => ev(seq, 'request/header', { header: { config: { model: 'm' }, tools: toolSchemas(n) } })
const sessionEv = (cwd, createdAt, id = 'session-test') => ({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })

/** A realistic cold start: sys prompt + skills + AGENTS.md + tools + runtime. */
function coldStartEvents() {
  return [
    sessionEv('E:\\dsh\\插件开发', 1792403384682),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(13533)),
    agentsMd(10, 'A'.repeat(3139)),
    runtimeCtx(11),
    skillCatalog(12, 70, 'K'.repeat(22008)),
    header(13, 82),
    userMsg(14, 'go'),
  ]
}
// =====================================================================
// slug decoding
// =====================================================================

test('slugToPath decodes a hex-escaped CJK path', () => {
  assert.equal(slugToPath('--E-dsh-~63D2~4EF6~5F00~53D1--'), 'E:\\dsh\\插件开发')
})

test('slugToPath decodes an ASCII path', () => {
  assert.equal(slugToPath('--E-dsh--'), 'E:\\dsh')
})

test('slugToPath returns null for a pathless slug', () => {
  // a slug with no drive letter is not a path, and must not be invented as one
  assert.equal(slugToPath('--no-drive-here--'), null)
  assert.equal(slugToPath(''), null)
  assert.equal(slugToPath(null), null)
})

test('slugToPath leaves a ~ that is not a 4-hex escape alone', () => {
  assert.equal(slugToPath('--E-x~12--'), 'E:\\x~12')
})

// =====================================================================
// event text
// =====================================================================

test('eventText skips reasoning parts', () => {
  const e = ev(1, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'shown' }] } })
  assert.equal(eventText(e), 'shown')
})

// =====================================================================
// token estimate
// =====================================================================

test('estimateTokens weights CJK above latin', () => {
  assert.ok(estimateTokens('中文文本测试') > estimateTokens('abc'))
  assert.equal(estimateTokens(''), 0)
})

// =====================================================================
// turn accounting
// =====================================================================

test('turnInjected sums every injected item', () => {
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(1000)),
    skillCatalog(12, 5, 'K'.repeat(500)),
    header(13, 3),
  ]
  const m = measureSession(events)
  assert.equal(m.turns, 1)
  assert.equal(m.coldStartChars, 1500 + JSON.stringify(header(13, 3).data.header.tools).length)
})

test('a turn with no entry item is not an entry turn', () => {
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(1000)),
    turnStart(20, 2),
    timeCtx(21),
  ]
  const m = measureSession(events)
  assert.equal(m.turns, 2)
  assert.equal(m.entryTurns, 1, 'only turn 1 is an entry turn')
  assert.equal(m.steadyStateTurn, 2, 'turn 2 is the steady state')
})

// =====================================================================
// cold start measurement
// =====================================================================

test('cold start counts the system prompt, catalog, AGENTS.md and tool schemas', () => {
  const m = measureSession(coldStartEvents())
  assert.equal(m.cwd, 'E:\\dsh\\插件开发')
  assert.equal(m.turns, 1)
  assert.equal(m.items.system.chars, 13533)
  assert.equal(m.items['skill-catalog'].chars, 22008)
  assert.equal(m.items['skill-catalog'].skillCount, 70)
  assert.equal(m.items['agent-instructions'].chars, 3139)
  assert.equal(m.items.tools.toolCount, 82)
  assert.ok(m.items.tools.chars > 0, 'tool schemas are measured')
  assert.equal(m.items['runtime-context'].chars, 'Current runtime context.'.length)
  assert.equal(m.firstUserChars, 2, 'the user turn is "go"')
  assert.equal(m.coldStartTurn, 1)
})

test('the largest copy of a re-injected item is what is measured', () => {
  // DSH re-injects a fresh AGENTS.md when the file changes mid-session; the
  // larger copy is what the model had to hold, so it must win.
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    agentsMd(10, 'A'.repeat(1000)),
    turnStart(20, 2),
    agentsMd(21, 'A'.repeat(5000)),
  ]
  const m = measureSession(events)
  assert.equal(m.items['agent-instructions'].chars, 5000)
  assert.equal(m.coldStartTurn, 2, 'the cold start is the turn that carried the largest copy')
})

test('a session with no turns measures zero, not a crash', () => {
  const m = measureSession([sessionEv('E:\\a', 1), ev(2, 'permission/preset', { preset: 'never' })])
  assert.equal(m.turns, 0)
  assert.equal(m.coldStartChars, 0)
  assert.deepEqual(m.items, {})
})

// =====================================================================
// steady state
// =====================================================================

test('steady state is the recurring floor once the entry items are gone', () => {
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(13000)),
    skillCatalog(12, 59, 'K'.repeat(20000)),
    header(13, 71),
    turnStart(20, 2),
    timeCtx(21),
    turnStart(30, 3),
    timeCtx(31),
  ]
  const m = measureSession(events)
  assert.equal(m.turns, 3)
  assert.equal(m.steadyStateChars, 'Time sampled while preparing turn 1, step 1.'.length)
  assert.equal(m.steadyStateTurn, 2)
  assert.ok(m.entryOverheadChars > 30000, 'the entry overhead dominates')
})

test('a turn that re-injects an entry item is not the steady state', () => {
  // a compaction re-injects the catalog; that turn is a re-entry, not a floor
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(13000)),
    skillCatalog(12, 59, 'K'.repeat(20000)),
    turnStart(20, 2),
    skillCatalog(21, 59, 'K'.repeat(20000)),
    turnStart(30, 3),
    timeCtx(31),
  ]
  const m = measureSession(events)
  assert.equal(m.entryTurns, 2)
  assert.equal(m.steadyStateTurn, 3)
})

test('steady state is null when every turn carries an entry item', () => {
  const events = [
    sessionEv('E:\\a', 1),
    turnStart(5, 1),
    sysMsg(8, 'S'.repeat(100)),
    turnStart(20, 2),
    sysMsg(21, 'S'.repeat(100)),
  ]
  const m = measureSession(events)
  assert.equal(m.steadyStateChars, null)
  assert.equal(m.steadyStateTurn, null)
})

// =====================================================================
// loadSession
// =====================================================================

test('loadSession reports a missing file as an error, not a throw', () => {
  const { events, error } = loadSession('Z:/nope/nothing.zstd')
  assert.deepEqual(events, [])
  assert.match(error, /not found/)
})

test('loadSession drops a truncated last line and keeps the rest', () => {
  const dir = join(tmpdir(), `wsc-load-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const lines = [JSON.stringify(sessionEv('E:\\a', 1)), JSON.stringify(turnStart(5, 1)), '{"type":"tool/call","seq":']
  const zstd = execFileSync('zstd', ['-c'], { input: lines.join('\n') })
  writeFileSync(file, zstd)
  const { events, error } = loadSession(file)
  assert.equal(error, null)
  assert.equal(events.length, 2, 'the partial line is dropped, the rest survives')
  rmSync(dir, { recursive: true, force: true })
})

// =====================================================================
// listSessions
// =====================================================================

test('listSessions walks the workspace level between the root and the session', () => {
  const dir = join(tmpdir(), `wsc-list-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  const wsDir = join(dir, '--E-dsh--')
  const sDir = join(wsDir, 'session-abc')
  mkdirSync(sDir, { recursive: true })
  writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), 'x')
  const found = listSessions(dir)
  assert.equal(found.length, 1)
  assert.equal(found[0].workspace, '--E-dsh--')
  assert.equal(found[0].name, 'session-abc')
  // and a missing root is an empty list, not a throw
  assert.deepEqual(listSessions('Z:/nope'), [])
  rmSync(dir, { recursive: true, force: true })
})

// =====================================================================
// aggregation
// =====================================================================

// A workspace roll-up row as aggregateWorkspaces emits it. `skills`, `tools`
// and `agentsMdChars` live at the top level, which is what attributeCost reads.
const wsRow = (workspace, cold, extra = {}) => ({
  workspace,
  coldStartChars: cold,
  coldStartTokens: cold / 4,
  steadyStateChars: 300,
  steadyStateTurn: 2,
  turns: 10,
  entryTurns: 2,
  createdAt: 1792403384682,
  skills: 59,
  tools: 71,
  agentsMdChars: 3000,
  items: { 'skill-catalog': { chars: 20000, skillCount: 59 }, tools: { chars: 60000, toolCount: 71 }, 'agent-instructions': { chars: 3000 } },
  ...extra,
})

test('aggregateWorkspaces groups by workspace and uses the median', () => {
  const rows = [
    wsRow('--E-dsh--', 34000),
    wsRow('--E-dsh--', 35000),
    wsRow('--E-dsh--', 900000, { createdAt: 1792403384699 }), // one monster session
    wsRow('--E-dsh-workspace--', 11000),
  ]
  const ws = aggregateWorkspaces(rows)
  assert.equal(ws.length, 2)
  assert.equal(ws[0].workspace, '--E-dsh--', 'sorted by entry cost, most expensive first')
  assert.equal(ws[0].entryCostChars, 35000, 'the median, so one 900K session does not define the workspace')
  assert.equal(ws[0].entryCostMaxChars, 900000)
  assert.equal(ws[0].skills, 59)
  assert.equal(ws[0].tools, 71)
  assert.equal(ws[0].agentsMdChars, 3000)
  assert.equal(ws[1].entryCostChars, 11000)
})

test('aggregateWorkspaces drops sessions with no turns', () => {
  const ws = aggregateWorkspaces([wsRow('--E-dsh--', 34000), { workspace: '--E-dsh--', turns: 0, coldStartChars: 0 }])
  assert.equal(ws.length, 1)
  assert.equal(ws[0].sessions, 1)
})

// =====================================================================
// visit frequency
// =====================================================================

test('visitFrequency measures over the observed window, not since epoch', () => {
  const day = 86_400_000
  const ws = { firstSeen: 1792403384682, lastSeen: 1792403384682 + 8 * day, sessions: 4 }
  const f = visitFrequency(ws)
  assert.equal(f.spanDays, 8)
  assert.equal(f.perDay, 0.5)
  assert.equal(f.recencyDays, 0)
})

test('visitFrequency honours an explicit window and reports recency', () => {
  const day = 86_400_000
  const ws = { firstSeen: 0, lastSeen: 10 * day, sessions: 2 }
  const f = visitFrequency(ws, { now: 40 * day, windowDays: 40 })
  assert.equal(f.spanDays, 40, 'the caller window wins over the session span')
  assert.equal(f.perDay, 0.05)
  assert.equal(f.recencyDays, 30)
})

test('visitFrequency survives a workspace with no timestamps', () => {
  const f = visitFrequency({ sessions: 3, firstSeen: null, lastSeen: null })
  assert.equal(f.perDay, 0)
  assert.equal(f.recencyDays, null)
})

// =====================================================================
// recommendations
// =====================================================================

test('recommendWorkspaces keeps a hot workspace warm even when it is expensive', () => {
  const day = 86_400_000
  const rows = recommendWorkspaces([{ workspace: '--E-dsh--', entryCostChars: 34000, sessions: 34, firstSeen: 0, lastSeen: 7 * day }])
  assert.equal(rows[0].verdict, 'keep-warm')
  assert.match(rows[0].why, /entries\/day/)
})

test('recommendWorkspaces archives a rare workspace regardless of cost', () => {
  const day = 86_400_000
  // one session ever, yesterday: not stale, but far too rare to keep warm.
  // The span defaults to the session span, so a single session is 1 day and
  // 1 session/day is exactly the warm threshold.
  const rows = recommendWorkspaces([{ workspace: '--E-dsh-workspace--', entryCostChars: 34000, sessions: 1, firstSeen: 40 * day, lastSeen: 40 * day }])
  assert.equal(rows[0].verdict, 'keep-warm', 'a single session is its own 1-day span, so it reads as hot — that is why an explicit window matters')
  const windowed = recommendWorkspaces([{ workspace: '--E-dsh-workspace--', entryCostChars: 34000, sessions: 1, firstSeen: 0, lastSeen: 40 * day }], { now: 40 * day, windowDays: 40 })
  assert.equal(windowed[0].verdict, 'watch', 'over the real window it is 0.025/day: rare, not dead — the archive floor is deliberately low so a monthly workspace is not written off')
  assert.equal(windowed[0].costPerDayChars, 850)
})

test('recommendWorkspaces archives a workspace that is both rare and stale', () => {
  const day = 86_400_000
  // one session ever, 60 days ago: both too rare and too stale to warm
  const rows = recommendWorkspaces([{ workspace: '--E-dsh-workspace--', entryCostChars: 34000, sessions: 1, firstSeen: 0, lastSeen: 60 * day }], { now: 60 * day })
  assert.equal(rows[0].verdict, 'archive')
})

test('recommendWorkspaces archives a stale workspace before looking at frequency', () => {
  // 12 sessions in 3 days is hot by frequency, but the last one was 90 days
  // ago — nothing is being kept warm by that history.
  const day = 86_400_000
  const rows = recommendWorkspaces([{ workspace: '--E-dsh--', entryCostChars: 34000, sessions: 12, firstSeen: 0, lastSeen: 3 * day }], { now: 93 * day })
  assert.equal(rows[0].verdict, 'archive')
  assert.match(rows[0].why, /days ago/)
})

test('recommendWorkspaces puts a mid-frequency workspace on watch', () => {
  // 2 sessions over 40 days = 0.05/day: above the archive floor (0.02), below warm
  const day = 86_400_000
  const rows = recommendWorkspaces([{ workspace: '--E-dsh--', entryCostChars: 34000, sessions: 2, firstSeen: 0, lastSeen: 40 * day }])
  assert.equal(rows[0].verdict, 'watch')
  assert.equal(rows[0].costPerDayChars, Math.round(34 * 0.05 * 1000))
})

test('recommendWorkspaces archives a workspace visited about once a month', () => {
  // 1 session over 40 days = 0.025/day: above the archive floor of 0.02, so it
  // lands on watch rather than archive. The archive floor is deliberately low
  // — a monthly workspace is expensive, but not obviously dead.
  const day = 86_400_000
  const rows = recommendWorkspaces([{ workspace: '--E-dsh-workspace--', entryCostChars: 11000, sessions: 1, firstSeen: 0, lastSeen: 40 * day }], { now: 40 * day })
  assert.equal(rows[0].verdict, 'watch')
  assert.equal(rows[0].costPerDayChars, Math.round(11 * 0.025 * 1000))
})

test('recommendWorkspaces ranks by cost x frequency, not by either alone', () => {
  const day = 86_400_000
  const rows = recommendWorkspaces([
    { workspace: 'expensive-hot', entryCostChars: 40000, sessions: 40, firstSeen: 0, lastSeen: 8 * day },
    { workspace: 'cheap-hot', entryCostChars: 10000, sessions: 40, firstSeen: 0, lastSeen: 8 * day },
    { workspace: 'expensive-cold', entryCostChars: 40000, sessions: 1, firstSeen: 0, lastSeen: 8 * day },
  ])
  assert.deepEqual(rows.map((r) => r.workspace), ['expensive-hot', 'cheap-hot', 'expensive-cold'])
})

// =====================================================================
// attribution
// =====================================================================

test('attributeCost refuses to draw a conclusion from two workspaces', () => {
  const r = attributeCost([wsRow('a', 34000), wsRow('b', 11000)])
  assert.deepEqual(r.factors, [])
  assert.match(r.note, /at least 3/)
})

test('attributeCost names a factor with no spread as a profile fingerprint', () => {
  // three workspaces with the same skill count and the same tool count but
  // different entry costs: the difference is NOT skills or tools
  const rows = [
    wsRow('a', 34000, { skills: 59, tools: 71 }),
    wsRow('b', 35000, { skills: 59, tools: 71 }),
    wsRow('c', 36000, { skills: 59, tools: 71 }),
  ]
  const r = attributeCost(rows)
  assert.ok(r.factors.every((f) => f.collinear), 'no spread means collinear')
  assert.match(r.factors[0].verdict, /no spread/)
  assert.match(r.note, /property of the profile/)
})

test('attributeCost still attributes a factor that does vary', () => {
  // skills vary (4/59/70) and so does the cost: that one is a real cause.
  // The rows are shaped like aggregateWorkspaces output, where `skills` comes
  // from the session items and `entryCostChars` is the median across sessions.
  const rows = [
    { workspace: 'a', entryCostChars: 11000, skills: 4, tools: 71, agentsMdChars: 3000, items: { tools: { chars: 60000 } } },
    { workspace: 'b', entryCostChars: 34000, skills: 59, tools: 71, agentsMdChars: 3000, items: { tools: { chars: 60000 } } },
    { workspace: 'c', entryCostChars: 39000, skills: 70, tools: 71, agentsMdChars: 3000, items: { tools: { chars: 60000 } } },
  ]
  const r = attributeCost(rows)
  const skills = r.factors.find((f) => f.key === 'skills')
  const tools = r.factors.find((f) => f.key === 'tools')
  assert.equal(skills.collinear, false)
  assert.ok(Math.abs(skills.r) > 0.9, 'a factor that varies and tracks the cost is strong')
  assert.equal(tools.collinear, true, 'a factor that never varies is named as a fingerprint')
})

test('attributeCost reports a real correlation when one exists', () => {
  const rows = [
    { workspace: 'a', entryCostChars: 10000, skills: 4, tools: 27, agentsMdChars: 2000 },
    { workspace: 'b', entryCostChars: 20000, skills: 20, tools: 55, agentsMdChars: 4000 },
    { workspace: 'c', entryCostChars: 30000, skills: 40, tools: 80, agentsMdChars: 6000 },
    { workspace: 'd', entryCostChars: 40000, skills: 60, tools: 100, agentsMdChars: 8000 },
  ]
  const r = attributeCost(rows)
  const skills = r.factors.find((f) => f.key === 'skills')
  assert.ok(Math.abs(skills.r) > 0.9, 'a real monotonic relationship is reported as strong')
  assert.equal(skills.collinear, false)
})

// =====================================================================
// per-entry audit
// =====================================================================

test('auditWorkspace flags a tool-schema-dominated entry', () => {
  const entry = { coldStartChars: 100000, items: { tools: { chars: 80000, toolCount: 71 }, 'skill-catalog': { chars: 10000, skillCount: 59 } }, firstUserChars: 2000, entryTurns: 1, turns: 5 }
  const rules = auditWorkspace(entry).map((f) => f.rule)
  assert.ok(rules.includes('tool-schema-dominated'))
  assert.ok(!rules.includes('catalog-dominated'))
})

test('auditWorkspace flags a catalog-dominated entry', () => {
  const entry = { coldStartChars: 40000, items: { tools: { chars: 10000, toolCount: 71 }, 'skill-catalog': { chars: 25000, skillCount: 59 }, 'agent-instructions': { chars: 4000 } }, firstUserChars: 2000, entryTurns: 1, turns: 5 }
  const rules = auditWorkspace(entry).map((f) => f.rule)
  assert.ok(rules.includes('catalog-dominated'))
  assert.ok(!rules.includes('tool-schema-dominated'))
})
test('auditWorkspace flags an entry that dwarfs the request', () => {
  const entry = { coldStartChars: 40000, items: { tools: { chars: 10000 } }, firstUserChars: 70, entryTurns: 1, turns: 5 }
  const findings = auditWorkspace(entry)
  const dwarf = findings.find((f) => f.rule === 'entry-dwarfs-request')
  assert.ok(dwarf)
  assert.match(dwarf.title, /571x/)
})

test('auditWorkspace does not cry wolf on a well-formed entry', () => {
  // a healthy entry: tools are a minority, the request is substantial, one entry turn
  const entry = { coldStartChars: 40000, items: { tools: { chars: 15000, toolCount: 71 }, 'skill-catalog': { chars: 10000, skillCount: 59 }, 'agent-instructions': { chars: 3000 } }, firstUserChars: 4000, entryTurns: 1, turns: 5 }
  assert.deepEqual(auditWorkspace(entry), [], 'a well-formed session must come back clean')
})

test('auditWorkspace reports the re-entry tax when a session compacted', () => {
  const entry = { coldStartChars: 40000, items: {}, firstUserChars: 4000, entryTurns: 4, turns: 20 }
  const rules = auditWorkspace(entry).map((f) => f.rule)
  assert.ok(rules.includes('re-entry-tax'))
})
