// dsh-workspace-switch-cost engine.
//
// What it costs to enter a workspace. Every time DSH opens a session in a
// project directory it pays an entry tax before the first token of the user's
// request is read, and the bill has four line items:
//
//   1. the system prompt      (system/message)
//   2. the skill catalog      (user/message, source.kind = skill-catalog)
//   3. AGENTS.md and friends  (user/message, source.kind = agent-instructions)
//   4. the tool schemas       (request/header . header.tools)
//
// plus small items injected every turn regardless (runtime snapshot,
// model-selection notice, time context).
//
// None of this is conversation. It is the price of admission, and on the
// machine this was measured on it is 34,000–47,000 characters for a single
// entry — against a first user turn that is often 2–70 characters. That ratio
// is the point of the plugin: switching projects is not free, and the
// workspaces that charge the most are not necessarily the ones you visit most.
//
// Everything here is deterministic: no LLM, no wall-clock guessing. The "cold
// start" is the first turn of a session, measured from the log; the "steady
// state" is the per-turn injected floor once the one-off entry items are gone.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// =====================================================================
// Session log reading
// =====================================================================

/**
 * Load a session.v4.jsonl.zstd into ordered events.
 *
 * A session killed mid-write leaves a partial last line; that line is dropped
 * rather than failing the whole load, because every other event in the file is
 * still valid evidence.
 */
export function loadSession(file) {
  if (!file || !existsSync(file)) return { events: [], error: `not found: ${file}` }
  let text
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' })
  } catch (e) {
    return { events: [], error: `cannot decompress (is zstd installed?): ${String(e.message).slice(0, 120)}` }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {}
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return { events, error: null }
}

/** The visible text of a message event, reasoning excluded. */
export function eventText(ev) {
  const d = ev?.data || {}
  const holder = d.message && typeof d.message === 'object' ? d.message : d
  const parts = Array.isArray(holder.content) ? holder.content : Array.isArray(d.content) ? d.content : []
  const out = []
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p.trim()) out.push(p)
      continue
    }
    if (!p || typeof p !== 'object') continue
    if (/^(reasoning|thinking|thought)$/i.test(p.type || '')) continue
    if (typeof p.text === 'string' && p.text.trim()) out.push(p.text)
  }
  return out.join('\n\n').trim()
}

/**
 * Rough token estimate: CJK chars count more than latin words.
 * Same weighting as dsh-compaction-audit so the numbers are comparable.
 */
export function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length
  return Math.round(cjk * 1.5 + latin * 1.3)
}

// =====================================================================
// Workspace slug <-> path
// =====================================================================

/**
 * Decode a session workspace slug back into the path it encodes.
 *
 * The slug is the path with separators flattened to `-` and non-ASCII bytes
 * hex-escaped as `~XXXX`: `--E-dsh-~63D2~4EF6~5F00~53D1--` is
 * `E:\dsh\插件开发`. The drive colon is dropped by the encoding, so it is put
 * back here; the leading and trailing `--` are the separators of a rooted path.
 *
 * Best-effort and deliberately not authoritative: `-` is also a legal path
 * character, so `E:\dsh-workspace` and `E:\dsh\workspace` both decode from
 * plausible slugs. The session event itself carries the real `cwd`
 * (`{type:'session', cwd:'E:\\dsh\\插件开发'}`), so the slug is only a label
 * and every number in this plugin comes from the log, never from the decode.
 */
export function slugToPath(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return null
  let s = slug
  if (s.startsWith('--') && s.endsWith('--')) s = s.slice(2, -2)
  const out = []
  let i = 0
  while (i < s.length) {
    if (s[i] === '~') {
      const hex = s.slice(i + 1, i + 5)
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        out.push(String.fromCharCode(parseInt(hex, 16)))
        i += 5
        continue
      }
    }
    out.push(s[i] === '-' ? '\\' : s[i])
    i += 1
  }
  const path = out.join('')
  // the encoding drops the drive colon: `--E-dsh--` is `E:\dsh`, not `E\dsh`
  if (/^[A-Za-z]\\/.test(path)) return `${path[0]}:${path.slice(1)}`
  return /^[A-Za-z]:/.test(path) ? path : null
}

// =====================================================================
// One session's entry cost
// =====================================================================

// The line items of the entry bill. `kind` is the event field each is read from.
const ITEMS = {
  systemPrompt: { label: 'system prompt', kind: 'system' },
  skillCatalog: { label: 'skill catalog', kind: 'skill-catalog' },
  agentsMd: { label: 'AGENTS.md', kind: 'agent-instructions' },
  toolSchemas: { label: 'tool schemas', kind: 'tools' },
  runtimeContext: { label: 'runtime snapshot', kind: 'runtime-context' },
  modelSelection: { label: 'model notice', kind: 'model-selection' },
  timeContext: { label: 'time context', kind: 'time-context' },
}

function blankTurn(turn) {
  const t = { turn, userChars: 0, userText: '', skillCount: 0, toolCount: 0, calls: 0 }
  for (const key of Object.keys(ITEMS)) t[key] = { chars: 0, tokens: 0 }
  return t
}

/**
 * Keep the largest copy of an injected item on this turn.
 *
 * DSH re-injects a fresh copy whenever the underlying content changes — a
 * session whose AGENTS.md was edited mid-run pays the new size. The largest
 * copy is what the model had to hold, so that is what is measured.
 */
function bump(t, key, chars, tokens) {
  if (chars > t[key].chars) {
    t[key].chars = chars
    t[key].tokens = tokens
  }
}

/** The chars injected on one turn. */
export function turnInjected(t) {
  if (!t) return 0
  return Object.keys(ITEMS).reduce((a, k) => a + t[k].chars, 0)
}

/** True when a turn carries any one-off entry item (i.e. it is an entry). */
export function isEntryTurn(t) {
  return t.systemPrompt.chars > 0 || t.skillCatalog.chars > 0 || t.agentsMd.chars > 0 || t.toolSchemas.chars > 0
}

/**
 * The entry cost of one session, measured from its log.
 *
 * "Cold start" is turn 1, which is where the entry tax is paid: the system
 * prompt, the skill catalog, AGENTS.md and the tool schemas all land there,
 * and nothing of the user's request has been read yet. Each item is counted at
 * its largest observed copy, because DSH re-injects a fresh one whenever the
 * underlying content changes — a session whose AGENTS.md was edited mid-run
 * pays the new size, and the largest copy is what the model had to hold.
 *
 * The tool schemas come from `request/header`: `header.tools` is the full JSON
 * Schema list sent with every request, which is the single largest and least
 * visible line item (66 KB for 71 tools on the measured machine).
 */
export function measureSession(events, { slug = null } = {}) {
  const turns = new Map()
  let turn = 0
  for (const ev of events) {
    if (ev.type === 'turn/start' && ev.data?.turn != null) turn = ev.data.turn
    if (!turns.has(turn)) turns.set(turn, blankTurn(turn))
    const t = turns.get(turn)
    if (ev.type === 'system/message') {
      const text = eventText(ev)
      bump(t, 'systemPrompt', text.length, estimateTokens(text))
    } else if (ev.type === 'user/message') {
      const kind = ev.data?.source?.kind
      const text = eventText(ev)
      if (kind === 'skill-catalog') {
        bump(t, 'skillCatalog', text.length, estimateTokens(text))
        t.skillCount = Math.max(t.skillCount, (ev.data?.source?.entries || []).length)
      } else if (kind === 'agent-instructions') bump(t, 'agentsMd', text.length, estimateTokens(text))
      else if (kind === 'runtime-context') bump(t, 'runtimeContext', text.length, estimateTokens(text))
      else if (kind === 'model-selection') bump(t, 'modelSelection', text.length, estimateTokens(text))
      else if (kind === 'time-context') bump(t, 'timeContext', text.length, estimateTokens(text))
      else if (kind === 'user' && text.length > t.userChars) {
        t.userChars = text.length
        t.userText = text
      }
    } else if (ev.type === 'request/header') {
      const tools = ev.data?.header?.tools
      if (Array.isArray(tools)) {
        const json = JSON.stringify(tools)
        bump(t, 'toolSchemas', json.length, estimateTokens(json))
        t.toolCount = Math.max(t.toolCount, tools.length)
      }
    } else if (ev.type === 'tool/call') {
      t.calls += 1
    }
  }

  const ordered = [...turns.values()].filter((t) => t.turn > 0).sort((a, b) => a.turn - b.turn)
  const first = ordered[0] ?? null
  const session = events.find((e) => e.type === 'session')

  // Steady state: the per-turn floor once the one-off entry items are gone.
  // A turn that carries an entry item is a re-entry (a compaction re-injects
  // the catalog and AGENTS.md), not the baseline.
  const steadyTurns = ordered.filter((t) => !isEntryTurn(t))
  const steady = steadyTurns.length > 0 ? Math.min(...steadyTurns.map(turnInjected)) : null

  // Turns until steady state: the first turn whose injected total is within
  // one small block of the recurring floor.
  let steadyStateTurn = null
  if (steady != null) {
    const floor = steady + 512
    for (const t of ordered) {
      if (turnInjected(t) <= floor) {
        steadyStateTurn = t.turn
        break
      }
    }
  }

  // The cold start is the *peak* injected turn, and the line items are read
  // from that same turn so the breakdown adds up to the total instead of
  // mixing sizes taken from different turns. Turn 1 is the peak in every
  // session observed on a real machine; a session whose AGENTS.md was
  // rewritten mid-run can peak later, and that peak is what was held.
  let coldTurn = null
  for (const t of ordered) {
    if (coldTurn == null || turnInjected(t) > turnInjected(coldTurn)) coldTurn = t
  }
  const coldStart = coldTurn ? turnInjected(coldTurn) : 0
  const coldTokens = coldTurn ? Object.keys(ITEMS).reduce((a, key) => a + coldTurn[key].tokens, 0) : 0

  return {
    slug,
    sessionId: session?.id ?? null,
    cwd: session?.cwd ?? null,
    createdAt: session?.createdAt ?? null,
    delegationDepth: session?.delegationDepth ?? null,
    turns: ordered.length,
    coldStartTurn: coldTurn?.turn ?? null,
    coldStartChars: coldStart,
    coldStartTokens: coldTokens,
    steadyStateChars: steady,
    steadyStateTurn,
    entryOverheadChars: steady == null ? coldStart : Math.max(0, coldStart - steady),
    items: coldTurn ? itemBreakdown(coldTurn) : {},
    firstUserChars: ordered[0]?.userChars ?? 0,
    // turns that carry an entry item: turn 1 plus one per compaction that
    // rebuilt the surface. A compacted session never gets cheaper.
    entryTurns: ordered.filter(isEntryTurn).length,
    calls: ordered.reduce((a, t) => a + t.calls, 0),
  }
}

function itemBreakdown(t) {
  const out = {}
  for (const [key, spec] of Object.entries(ITEMS)) {
    if (t[key].chars > 0) {
      out[spec.kind] = { label: spec.label, chars: t[key].chars, tokens: t[key].tokens }
    }
  }
  if (t.toolCount > 0) out.tools.toolCount = t.toolCount
  if (t.skillCount > 0) out['skill-catalog'].skillCount = t.skillCount
  return out
}

// =====================================================================
// Workspace aggregation
// =====================================================================

/**
 * Every session log under a sessions root, keeping the workspace slug.
 *
 * The layout is `<sessions>/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd`
 * — a workspace level sits between the root and the session, so a flat scan of
 * the root finds nothing.
 */
export function listSessions(root, limit) {
  if (!root || !existsSync(root)) return []
  const out = []
  const walk = (dir, workspace, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      const log = join(full, 'session.v4.jsonl.zstd')
      if (existsSync(log)) {
        let mtime = 0
        try {
          mtime = statSync(log).mtimeMs
        } catch {}
        out.push({ workspace, name: e.name, file: log, mtime })
        continue
      }
      walk(full, e.name, depth + 1)
    }
  }
  walk(root, '(root)', 0)
  out.sort((a, b) => b.mtime - a.mtime || b.workspace.localeCompare(a.workspace) || b.name.localeCompare(b.name))
  return typeof limit === 'number' ? out.slice(0, Math.max(1, limit)) : out
}

/** Per-workspace roll-up: what it costs to enter, and how often it is entered. */
export function aggregateWorkspaces(sessions) {
  const byWs = new Map()
  for (const s of sessions) {
    if (!s || s.turns === 0) continue
    if (!byWs.has(s.workspace)) byWs.set(s.workspace, [])
    byWs.get(s.workspace).push(s)
  }
  const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b)
    if (sorted.length === 0) return 0
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }
  const out = []
  for (const [workspace, rows] of byWs) {
    const cold = rows.map((r) => r.coldStartChars)
    const times = rows.map((r) => r.createdAt).filter((t) => typeof t === 'number')
    out.push({
      workspace,
      path: slugToPath(workspace) ?? rows.map((r) => r.cwd).find(Boolean) ?? null,
      sessions: rows.length,
      events: rows.reduce((a, r) => a + (r.events ?? 0), 0),
      // median, not mean: one 26k-event session must not define a workspace
      entryCostChars: median(cold),
      entryCostTokens: median(rows.map((r) => r.coldStartTokens)),
      entryCostMinChars: Math.min(...cold),
      entryCostMaxChars: Math.max(...cold),
      skills: median(rows.map((r) => r.items?.['skill-catalog']?.skillCount ?? 0)),
      tools: median(rows.map((r) => r.items?.tools?.toolCount ?? 0)),
      agentsMdChars: median(rows.map((r) => r.items?.['agent-instructions']?.chars ?? 0)),
      steadyStateChars: median(rows.map((r) => r.steadyStateChars ?? 0)),
      steadyStateTurn: median(rows.map((r) => r.steadyStateTurn ?? 0)),
      totalTurns: rows.reduce((a, r) => a + r.turns, 0),
      entryTurns: rows.reduce((a, r) => a + r.entryTurns, 0),
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
    })
  }
  return out.sort((a, b) => b.entryCostChars - a.entryCostChars)
}

// =====================================================================
// Visit frequency and the keep-warm / archive decision
// =====================================================================

/** Day count for a span, never zero (a same-day pair is one day). */
function daysBetween(from, to) {
  if (from == null || to == null) return 0
  return Math.max(1, Math.round((to - from) / 86_400_000))
}

/**
 * Visit frequency, measured rather than guessed.
 *
 * `windowDays` is the window the caller supplies (the span of sessions that
 * exist), so the rate is "entries per day inside the observed window" — not
 * per day since the beginning of time. A workspace last touched three weeks
 * ago with 34 sessions before that is hot, not cold.
 */
export function visitFrequency(ws, { now = null, windowDays = null } = {}) {
  const first = ws.firstSeen
  const last = ws.lastSeen
  if (first == null || last == null) return { sessions: ws.sessions ?? 0, spanDays: 0, perDay: 0, recencyDays: null, lastSeen: null }
  const end = now ?? last
  const span = windowDays != null ? Math.max(1, windowDays) : daysBetween(first, last)
  return {
    sessions: ws.sessions ?? 0,
    spanDays: span,
    perDay: span > 0 ? (ws.sessions ?? 0) / span : 0,
    recencyDays: Math.max(0, Math.round((end - last) / 86_400_000)),
    lastSeen: last,
  }
}

/**
 * keep-warm / archive recommendation.
 *
 * The economics: a workspace costs `entryCost` every time you enter it, and
 * that is only worth paying if you enter it often enough. So the decision
 * variable is entryCost x visitsPerDay, and the verdict is the one a human
 * makes by feel — except it is derived from the log.
 *
 * The thresholds are deliberately coarse and both directions are reported
 * with their numbers, so a reader can disagree with the label and still keep
 * the evidence.
 */
export function recommendWorkspaces(workspaces, { now = null, windowDays = null, warmPerDay = 0.5, coldPerDay = 0.02, staleDays = 30 } = {}) {
  return workspaces
    .map((ws) => {
      const freq = visitFrequency(ws, { now, windowDays })
      const kCost = ws.entryCostChars / 1000
      let verdict
      let why
      if (freq.recencyDays != null && freq.recencyDays > staleDays) {
        verdict = 'archive'
        why = `last entered ${freq.recencyDays} days ago — nothing to keep warm`
      } else if (freq.perDay >= warmPerDay) {
        verdict = 'keep-warm'
        why = `${freq.perDay.toFixed(2)} entries/day at ~${kCost.toFixed(1)}K entry cost`
      } else if (freq.perDay <= coldPerDay) {
        verdict = 'archive'
        why = `${freq.perDay.toFixed(2)} entries/day — too rare to justify ~${kCost.toFixed(1)}K per entry`
      } else {
        verdict = 'watch'
        why = `${freq.perDay.toFixed(2)} entries/day at ~${kCost.toFixed(1)}K per entry — in between`
      }
      return { ...ws, frequency: freq, costPerDayChars: Math.round(kCost * freq.perDay * 1000), verdict, why }
    })
    .sort((a, b) => b.costPerDayChars - a.costPerDayChars)
}

// =====================================================================
// What makes a workspace expensive
// =====================================================================

/**
 * Attribute an entry cost to its causes, by correlation across workspaces.
 *
 * The three candidate causes are the ones worth naming — size of AGENTS.md,
 * number of skills, tool count. Reporting a correlation as a cause when it is
 * really a profile fingerprint would be the classic mistake here: on one
 * machine every workspace with 59 skills has the same AGENTS.md and the same
 * tool set, because they are the same profile. So each factor is reported with
 * the spread it actually has, and a factor with no spread is named as such
 * instead of being sold as an insight.
 */
export function attributeCost(rows) {
  if (rows.length < 3) return { factors: [], biggestItem: null, note: 'need at least 3 workspaces to attribute a cost' }
  const spread = (key) => {
    const xs = rows.map((r) => r[key]).filter((n) => typeof n === 'number' && n > 0)
    if (xs.length === 0) return null
    return { min: Math.min(...xs), max: Math.max(...xs), distinct: new Set(xs).size }
  }
  const pearson = (a, b) => {
    const n = Math.min(a.length, b.length)
    if (n < 3) return null
    const ma = a.reduce((s, x) => s + x, 0) / n
    const mb = b.reduce((s, x) => s + x, 0) / n
    let num = 0
    let da = 0
    let db = 0
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma
      const y = b[i] - mb
      num += x * y
      da += x * x
      db += y * y
    }
    const den = Math.sqrt(da * db)
    return den === 0 ? null : num / den
  }
  const cost = rows.map((r) => r.entryCostChars)
  const factors = [
    { key: 'skills', label: 'skill count', spread: spread('skills') },
    { key: 'tools', label: 'tool count', spread: spread('tools') },
    { key: 'agentsMdChars', label: 'AGENTS.md size', spread: spread('agentsMdChars') },
  ].map((f) => {
    const r = pearson(rows.map((x) => x[f.key]), cost)
    // "no spread" means the factor takes one or two values across the
    // workspaces, so it cannot be the cause of a difference: it is a property
    // of the profile they all share, not of the project.
    const noSpread = f.spread != null && f.spread.distinct <= 2
    return {
      ...f,
      collinear: noSpread,
      r: r == null ? null : Math.round(r * 100) / 100,
      verdict: r == null ? 'unknown' : noSpread ? 'no spread — a profile fingerprint, not a per-workspace cause' : Math.abs(r) > 0.8 ? 'strong' : Math.abs(r) > 0.5 ? 'moderate' : 'weak',
    }
  })
  // What actually separates the workspaces: the largest single line item.
  const biggest = ['system', 'skill-catalog', 'agent-instructions', 'tools']
    .map((k) => ({ key: k, chars: Math.max(...rows.map((r) => r.items?.[k]?.chars ?? 0)) }))
    .sort((a, b) => b.chars - a.chars)[0]
  return {
    factors,
    biggestItem: biggest,
    note: factors.every((f) => f.collinear) ? 'every candidate factor has almost no spread across these workspaces: the entry cost is a property of the profile, not of the project' : null,
  }
}

// =====================================================================
// The audit for one workspace
// =====================================================================

/**
 * Per-session entry cost with a verdict.
 *
 * The one distinction worth flagging that a ranking hides: a workspace whose
 * entry cost is dominated by tool schemas pays it on *every* request, while
 * one dominated by the skill catalog pays it once per session. That changes
 * what you would fix, so it is reported rather than summed away.
 */
export function auditWorkspace(entry) {
  const items = entry.items ?? {}
  const total = entry.coldStartChars || 1
  const tools = items.tools?.chars ?? 0
  const onceOnly = (items['skill-catalog']?.chars ?? 0) + (items['agent-instructions']?.chars ?? 0)
  const findings = []

  if (tools / total > 0.5) {
    findings.push({
      rule: 'tool-schema-dominated',
      severity: 'warn',
      title: `${Math.round((tools / total) * 100)}% of the entry cost is tool schemas (${tools} chars for ${items.tools?.toolCount ?? '?'} tools)`,
      detail:
        'Tool schemas are re-sent with every request, not once per session, so this cost recurs for the whole session. A workspace that looks expensive mostly because of its tool set stays expensive no matter how short the visit is.',
      data: { tools, total, toolCount: items.tools?.toolCount ?? null },
    })
  }
  if (onceOnly / total > 0.5) {
    findings.push({
      rule: 'catalog-dominated',
      severity: 'info',
      title: `${Math.round((onceOnly / total) * 100)}% of the entry cost is the skill catalog plus AGENTS.md`,
      detail:
        'This is a one-off charge per session, so it is amortised by long visits and wasted by short ones. It is also the part a plugin author controls directly.',
      data: { skillCatalog: items['skill-catalog']?.chars ?? 0, agentsMd: items['agent-instructions']?.chars ?? 0, skillCount: items['skill-catalog']?.skillCount ?? null },
    })
  }
  if (entry.firstUserChars > 0 && entry.coldStartChars > entry.firstUserChars * 100) {
    findings.push({
      rule: 'entry-dwarfs-request',
      severity: 'warn',
      title: `the first user turn is ${entry.firstUserChars} chars but the entry cost is ${entry.coldStartChars} chars (${Math.round(entry.coldStartChars / entry.firstUserChars)}x)`,
      detail:
        'The machine reads more harness boilerplate than user intent before the first token of the request. For a two-word greeting this is the whole ratio; for a long task brief it is less meaningful, which is why the raw numbers are here.',
      data: { firstUserChars: entry.firstUserChars, coldStartChars: entry.coldStartChars },
    })
  }
  if (entry.entryTurns > 1) {
    findings.push({
      rule: 're-entry-tax',
      severity: 'info',
      title: `the entry items were injected on ${entry.entryTurns} turns of this session`,
      detail:
        'Every compaction re-injects the skill catalog and AGENTS.md, so a long session pays the entry tax again each time it compacts. This is not waste — it is how the surface is rebuilt — but it is why a compacted session never gets cheaper.',
      data: { entryTurns: entry.entryTurns, turns: entry.turns },
    })
  }
  return findings
}
