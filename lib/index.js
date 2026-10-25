// dsh-workspace-switch-cost: agent tools over the entry-cost pipeline.
//
// Three tools, one question each:
//   wsc_audit     — what does entering THIS workspace cost, and how long until
//                   the session stops paying for the entry?
//   wsc_compare   — which workspaces are expensive to enter, which are cheap,
//                   and what actually makes the difference?
//   wsc_recommend — given entry cost x visit frequency, keep warm or archive?
//
// Every number comes from the session event log. No LLM is called, so a wrong
// answer is a rule bug with a name rather than a hallucination about cost.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import {
  aggregateWorkspaces,
  attributeCost,
  auditWorkspace,
  estimateTokens,
  listSessions,
  loadSession,
  measureSession,
  recommendWorkspaces,
  slugToPath,
} from './engine.js'

export const name = 'workspace-switch-cost'
export const inject = ['tools']

const Config = {
  // Where DSH keeps session logs.
  sessionsDir: '',
  // Cap the number of sessions a sweep will read, so a large history cannot
  // hang the tool. Override with a bigger number for the full sweep.
  maxSessions: 60,
}

const OUTPUT_SCHEMA = { type: 'json' }
const outRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** Resolve the sessions dir: explicit arg, config, or the default per-profile layout. */
function resolveSessionsDir(dir) {
  if (dir) return dir
  if (Config.sessionsDir) return Config.sessionsDir
  return join(homedir(), '.dsh', 'sessions')
}

/** A session file from either a file path or a session directory. */
function sessionFile(p) {
  if (!p) return null
  if (existsSync(p) && p.endsWith('.zstd')) return p
  const nested = join(p, 'session.v4.jsonl.zstd')
  return existsSync(nested) ? nested : null
}

/** Measure every session under a root, newest first, capped by `limit`. */
function measureAll(root, limit) {
  const sessions = listSessions(root, limit)
  const measured = []
  let skipped = 0
  for (const s of sessions) {
    const { events, error } = loadSession(s.file)
    if (error || events.length === 0) {
      skipped += 1
      continue
    }
    const m = measureSession(events, { slug: s.workspace })
    if (m.turns === 0) {
      skipped += 1
      continue
    }
    // `measureSession` reports the workspace as `slug`; the aggregation layer
    // keys on `workspace`. Emit both so neither side has to know the other's
    // spelling — the mismatch silently produced `workspace: undefined` in the
    // comparison table.
    measured.push({ ...m, workspace: m.slug, name: s.name, file: s.file, mtime: s.mtime, events: events.length })
  }
  return { measured, skipped, scanned: sessions.length }
}

const k = (n) => `${(n / 1000).toFixed(1)}K`

function renderEntry(entry, title) {
  const lines = ['', `${title}`, '']
  lines.push(`  workspace   ${entry.slug}${entry.cwd ? `  (${entry.cwd})` : ''}`)
  lines.push(`  session     ${entry.sessionId ?? entry.name ?? '-'}`)
  lines.push(`  cold start  ${entry.coldStartChars} chars / ~${entry.coldStartTokens} tokens`)
  if (entry.steadyStateChars != null) {
    lines.push(`  steady      ${entry.steadyStateChars} chars/turn, reached at turn ${entry.steadyStateTurn} of ${entry.turns}`)
    lines.push(`  overhead    ${entry.entryOverheadChars} chars (${Math.round((entry.entryOverheadChars / (entry.coldStartChars || 1)) * 100)}% of the entry)`)
  }
  lines.push(`  first turn  ${entry.firstUserChars} chars of user text`)
  lines.push('')
  lines.push('  line items:')
  for (const [kind, item] of Object.entries(entry.items ?? {})) {
    const extra = item.skillCount != null ? `, ${item.skillCount} skills` : item.toolCount != null ? `, ${item.toolCount} tools` : ''
    lines.push(`    ${item.label.padEnd(16)} ${String(item.chars).padStart(7)} chars  ~${String(item.tokens).padStart(6)} tok${extra}`)
  }
  const findings = auditWorkspace(entry)
  if (findings.length > 0) {
    lines.push('')
    for (const f of findings) lines.push(`  [${f.severity}] ${f.rule}: ${f.title}`)
  } else {
    lines.push('')
    lines.push('  nothing to flag')
  }
  lines.push('')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }

  const tools = [
    {
      name: 'wsc_audit',
      description:
        'Measure what it costs to enter one workspace: the cold-start context injected before the first token of the user request (system prompt + skill catalog + AGENTS.md + tool schemas + runtime snapshot), how many turns until the session reaches its steady-state per-turn baseline, and how much of the entry is a one-off charge versus a per-request one. Reads the raw session event log; deterministic, no LLM. Returns {ok, entry, findings, report}.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Path to a session.v4.jsonl.zstd file or a session directory. Omit to audit the newest session in each workspace.' },
          workspace: { type: 'string', description: 'Workspace slug (e.g. --E-dsh--) or a substring of the workspace path. Used with `session` omitted.' },
          dir: { type: 'string', description: 'Sessions root. Defaults to ~/.dsh/sessions.' },
        },
      },
      async execute(args) {
        let file = args.session ? sessionFile(args.session) : null
        let slug = args.workspace ?? null
        // an explicit session path that does not resolve is an error, not a
        // silent fallback to "the newest session" — otherwise a typo audits
        // the wrong workspace and the caller never knows.
        if (args.session && !file) return { ok: false, error: `no session.v4.jsonl.zstd at ${args.session}` }
        if (file && !slug) {
          // The workspace slug is the directory two levels above the log
          // (<sessions>/<slug>/<session-id>/session.v4.jsonl.zstd). Deriving it
          // from the path means an explicit `session` still reports which
          // workspace it belongs to, instead of claiming `slug: null`.
          const parts = file.replace(/\\/g, '/').split('/')
          const slugAt = parts.length - 3
          if (slugAt >= 0 && parts[slugAt]) slug = parts[slugAt]
        }
        if (!file) {
          const root = resolveSessionsDir(args.dir)
          const sessions = listSessions(root, cfg.maxSessions)
          const want = slug ? slug.toLowerCase() : null
          const hit = want
            ? sessions.find((s) => s.workspace.toLowerCase().includes(want) || (slugToPath(s.workspace) ?? '').toLowerCase().includes(want))
            : sessions[0]
          if (!hit) return { ok: false, error: `no session found${want ? ` for workspace ${slug}` : ''} under ${root}` }
          file = hit.file
          // the requested slug is what the caller asked about, so it wins over
          // the slug of whichever session happened to be newest
          slug = slug ?? hit.workspace
        }
        const { events, error } = loadSession(file)
        if (error) return { ok: false, error }
        if (events.length === 0) return { ok: false, error: 'session log is empty' }
        const entry = measureSession(events, { slug })
        if (entry.turns === 0) return { ok: false, error: `no turns recorded in ${file}` }
        const findings = auditWorkspace(entry)
        return { ok: true, entry: { ...entry, name: file.split(/[\\/]/).slice(-2, -1)[0] }, findings, report: renderEntry({ ...entry, name: file }, `workspace entry cost · ${entry.cwd ?? entry.slug}`) }
      },
    },
    {
      name: 'wsc_compare',
      description:
        'Compare workspaces by entry cost: which are expensive to enter, which are cheap, and what makes the difference (size of AGENTS.md, number of skills, tool count). Also attributes the cost — a factor with no spread across the workspaces is a property of the profile, not of the project, and is reported as such rather than sold as an insight. Returns {ok, workspaces:[...], attribution, report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Sessions root. Defaults to ~/.dsh/sessions.' },
          limit: { type: 'integer', description: 'Max sessions to read (default 60).' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        const limit = Math.max(1, Number(args.limit) || cfg.maxSessions)
        const { measured, skipped } = measureAll(root, limit)
        if (measured.length === 0) return { ok: false, error: `no sessions with turns found under ${root}` }
        const workspaces = aggregateWorkspaces(measured)
        const attribution = attributeCost(workspaces)
        const lines = ['', 'workspace entry cost comparison', '']
        lines.push(`  ${'workspace'.padEnd(38)} ${'entry'.padStart(9)} ${'steady'.padStart(8)} ${'@turn'.padStart(6)} ${'skills'.padStart(7)} ${'tools'.padStart(6)} ${'AGENTS'.padStart(7)} ${'sess'.padStart(5)}`)
        for (const ws of workspaces) {
          lines.push(
            `  ${String(ws.workspace).padEnd(38)} ${k(ws.entryCostChars).padStart(9)} ${k(ws.steadyStateChars).padStart(8)} ${String(ws.steadyStateTurn).padStart(6)} ${String(ws.skills).padStart(7)} ${String(ws.tools).padStart(6)} ${k(ws.agentsMdChars).padStart(7)} ${String(ws.sessions).padStart(5)}`,
          )
        }
        lines.push('')
        lines.push(`  biggest single line item: ${attribution.biggestItem?.key} at ${attribution.biggestItem?.chars} chars`)
        for (const f of attribution.factors) {
          lines.push(`  ${f.label.padEnd(14)} r=${String(f.r).padStart(6)}  ${f.verdict}`)
        }
        if (attribution.note) lines.push(`  note: ${attribution.note}`)
        if (skipped > 0) lines.push(`  (${skipped} session(s) skipped: unreadable or with no turns)`)
        lines.push('')
        return { ok: true, workspaces, attribution, report: lines.join('\n') }
      },
    },
    {
      name: 'wsc_recommend',
      description:
        'Recommend which workspaces to keep warm and which to archive, from entry cost x visit frequency. A workspace that charges ~35K characters of context per entry is only worth entering often; one entered twice a month is paying the tax for nothing. Frequency is measured over the span of sessions that exist, and recency is reported separately so a dormant workspace is not called hot. Returns {ok, rows:[{workspace, entryCostChars, frequency, verdict, why}], report}.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Sessions root. Defaults to ~/.dsh/sessions.' },
          limit: { type: 'integer', description: 'Max sessions to read (default 60).' },
          windowDays: { type: 'integer', description: 'Days of history to measure frequency over. Defaults to the span of the sessions found.' },
          now: { type: 'integer', description: 'Epoch ms to treat as "now" for recency. Defaults to the newest session.' },
        },
      },
      async execute(args) {
        const root = resolveSessionsDir(args.dir)
        const limit = Math.max(1, Number(args.limit) || cfg.maxSessions)
        const { measured } = measureAll(root, limit)
        if (measured.length === 0) return { ok: false, error: `no sessions with turns found under ${root}` }
        const workspaces = aggregateWorkspaces(measured)
        const times = measured.map((m) => m.createdAt).filter((t) => typeof t === 'number')
        const now = Number(args.now) || (times.length ? Math.max(...times) : null)
        const windowDays = Number(args.windowDays) || null
        const rows = recommendWorkspaces(workspaces, { now, windowDays })
        const lines = ['', 'keep warm / archive, by entry cost x visit frequency', '']
        lines.push(`  ${'workspace'.padEnd(38)} ${'entry'.padStart(8)} ${'sess'.padStart(5)} ${'/day'.padStart(7)} ${'stale'.padStart(6)} ${'K*day'.padStart(7)}  verdict`)
        for (const r of rows) {
          lines.push(
            `  ${String(r.workspace).padEnd(38)} ${k(r.entryCostChars).padStart(8)} ${String(r.frequency.sessions).padStart(5)} ${r.frequency.perDay.toFixed(2).padStart(7)} ${String(r.frequency.recencyDays ?? '-').padStart(6)} ${(r.costPerDayChars / 1000).toFixed(1).padStart(7)}  ${r.verdict}`,
          )
        }
        lines.push('')
        for (const r of rows) lines.push(`  ${r.verdict.padEnd(11)} ${r.workspace} — ${r.why}`)
        lines.push('')
        return { ok: true, rows, report: lines.join('\n') }
      },
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render: outRender },
        timeoutMs: 300_000,
        isConcurrencySafe: () => true,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'read', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[workspace-switch-cost] ${t.name} registration skipped: ${error}`)
    }
  }
}
