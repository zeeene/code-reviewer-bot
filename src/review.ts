// AI PR reviewer: one OpenRouter call per PR, one GitHub review posted back.
//
// Flow: read Action event → fetch diff → gather context (changed-file contents
// + repo tree) → ask the model for a structured review → post it, with each
// comment anchored inline only if its line actually appears in the diff.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Octokit } from "@octokit/rest"
import { z } from "zod"
import {
  BOT_NAME,
  DEFAULT_MODEL,
  FILE_CAP,
  MAX_MODEL_ATTEMPTS,
  OPENROUTER_URL,
  SKIP_FILES,
  SYSTEM_PROMPT,
  TOTAL_CAP,
  TREE_MAX_LINES,
} from "./config.ts"

// Shape the model must return; anything else triggers a retry (see callModel).
export const ReviewSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["approve", "comment", "request_changes"]),
  comments: z
    .array(
      z.object({
        file: z.string(),
        // null = no single natural line (architectural / deleted-code issues)
        line: z.number().int().positive().nullable().default(null),
        // exact copy of the flagged line, used to verify/repair the anchor
        line_content: z.string().nullable().default(null),
        severity: z.enum(["critical", "warning", "suggestion"]),
        trigger: z.string().default(""),
        comment: z.string(),
        // Which reviewer flagged it; only meaningful in the primary's merged
        // output when a secondary model ran (see secondaryFindingsSection).
        source: z.enum(["primary", "secondary", "both"]).default("primary"),
      })
    )
    .default([]),
  // In-character closing line — the one place humor is allowed (see SYSTEM_PROMPT).
  signoff: z.string().default(""),
})
export type Review = z.infer<typeof ReviewSchema>
type ReviewComment = Review["comments"][number]

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/review.test.ts)
// ---------------------------------------------------------------------------

// Pull the JSON object out of a model reply, tolerating a <scratch> reasoning
// block (see SYSTEM_PROMPT) and markdown fences. Falls back to the outermost
// {...} span for models that wrap the JSON in stray prose.
export function extractJson(text: string): unknown {
  const scratchEnd = text.lastIndexOf("</scratch>")
  if (scratchEnd !== -1) text = text.slice(scratchEnd + "</scratch>".length)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) text = fenced[1]
  text = text.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start === -1 || end <= start) throw new Error("no JSON object found in reply")
    return JSON.parse(text.slice(start, end + 1))
  }
}

// New-side lines the GitHub review API accepts inline comments on (additions
// and context), with their text: Map<file, Map<line, content>>. Content is
// kept so a mis-numbered comment can be re-anchored via line_content.
// Anything unanchorable folds into the summary, because createReview 422s on
// out-of-diff anchors.
export function diffNewLines(diff: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>()
  let file = ""
  let line = 0 // 0 = not inside a hunk yet
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      // New file header; "+++ /dev/null" means the file was deleted.
      file = raw.startsWith("+++ b/") ? raw.slice(6) : ""
      line = 0
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!file || line === 0) continue
    // "+" and " " lines exist on the new side; "-" lines don't advance it.
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      if (!files.has(file)) files.set(file, new Map())
      files.get(file)!.set(line, raw.slice(1))
      line++
    }
  }
  return files
}

// Resolve a comment to a commentable line: trust `line` if it's in the diff;
// otherwise try to find `line_content` among the file's diff lines (closest
// match to the claimed line wins ties). Returns null when unanchorable.
export function anchorComment(c: ReviewComment, newLines: Map<string, Map<number, string>>): number | null {
  const lines = newLines.get(c.file)
  if (!lines) return null
  if (c.line !== null && lines.has(c.line)) return c.line
  const target = c.line_content?.trim()
  if (!target) return null
  const matches = [...lines].filter(([, text]) => text.trim() === target).map(([n]) => n)
  if (matches.length === 0) return null
  if (c.line === null) return matches[0]
  return matches.reduce((a, b) => (Math.abs(b - c.line!) < Math.abs(a - c.line!) ? b : a))
}

// Section appended to the primary model's user message when a secondary model
// reviewed first: the primary must review independently in <scratch>, then
// merge in only the secondary findings that are new and real, tagging origins
// via the `source` field.
export function secondaryFindingsSection(secondary: Review, secondaryModel: string): string {
  return [
    `\n\n## Second reviewer's findings (model: ${secondaryModel})`,
    "IMPORTANT: First complete your OWN independent review in your <scratch> block, WITHOUT consulting the list below. Only then compare against these findings:",
    '- A finding below that duplicates one of yours (same underlying issue, even if worded or located slightly differently): keep YOUR version, set its `source` to "both".',
    '- A finding below that is genuinely new AND that you verify is a real issue: include it as your own comment (re-anchor file/line/line_content yourself), set `source` to "secondary".',
    "- A finding below that is wrong or not worth raising: drop it silently.",
    '- Your own findings not in the list: `source` "primary".',
    "Recompute summary and verdict over the final merged comment set.",
    "```json",
    JSON.stringify(secondary.comments, null, 2),
    "```",
  ].join("\n")
}

// Changed files with a new side (i.e. not deleted), from the diff itself —
// saves a listFiles API call.
export function changedFiles(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]))]
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

async function callModel(model: string, apiKey: string, userContent: string): Promise<Review> {
  // Base prompt stays project-agnostic; repos add domain context via the
  // extra-instructions action input.
  const extra = process.env.EXTRA_INSTRUCTIONS?.trim()
  const systemPrompt = extra ? `${SYSTEM_PROMPT}\n\nProject-specific guidance:\n${extra}` : SYSTEM_PROMPT
  let messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
    const text = (await res.json()).choices?.[0]?.message?.content ?? ""
    try {
      return ReviewSchema.parse(extractJson(text))
    } catch (e) {
      // Malformed JSON: feed the error back and let the model correct itself.
      lastError = e
      messages = [
        ...messages,
        { role: "assistant", content: text },
        { role: "user", content: `That was not valid JSON for the schema (${e}). Reply with ONLY the JSON object.` },
      ]
    }
  }
  throw new Error(`Model did not return valid review JSON after ${MAX_MODEL_ATTEMPTS} attempts: ${lastError}`)
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

// Collapse earlier bot reviews (and their inline comments) as OUTDATED so a
// re-review doesn't pile up in the PR timeline. Best-effort: a failure here
// should never block posting the new review.
async function hidePreviousReviews(octokit: Octokit, owner: string, repo: string, prNumber: number) {
  const data: any = await octokit.graphql(
    `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviews(first: 50) {
            nodes {
              id isMinimized body author { login }
              comments(first: 50) { nodes { id isMinimized } }
            }
          }
        }
      }
    }`,
    { owner, repo, pr: prNumber }
  )
  const mine = data.repository.pullRequest.reviews.nodes.filter(
    (r: any) => r.author?.login === "github-actions" && !r.isMinimized && r.body.includes(BOT_NAME)
  )
  const ids = mine.flatMap((r: any) => [
    r.id,
    ...r.comments.nodes.filter((c: any) => !c.isMinimized).map((c: any) => c.id),
  ])
  for (const id of ids) {
    await octokit.graphql(
      `mutation($id: ID!) {
        minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
          minimizedComment { isMinimized }
        }
      }`,
      { id }
    )
  }
  if (ids.length) console.log(`Collapsed ${mine.length} previous review(s) as outdated`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set — run in a GitHub Action or point it at an event JSON file")
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set")
  const model = process.env.MODEL || DEFAULT_MODEL

  const event = JSON.parse(readFileSync(eventPath, "utf8"))
  const [owner, repo] = event.repository.full_name.split("/")
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

  // Two ways in: a pull_request event carries the PR inline; an issue_comment
  // event (/review command) only carries the issue number, so fetch the PR and
  // ack the request with a 👀 reaction.
  let pr = event.pull_request
  if (!pr && event.issue?.pull_request) {
    pr = (await octokit.pulls.get({ owner, repo, pull_number: event.issue.number })).data
    await octokit.reactions
      .createForIssueComment({ owner, repo, comment_id: event.comment.id, content: "eyes" })
      .catch(() => {}) // ack is cosmetic
  }
  if (!pr) throw new Error("Event has no pull_request — trigger on pull_request or PR issue_comment events")

  // The raw unified diff is both model input and the source of truth for
  // which lines can carry inline comments.
  const diff = (
    await octokit.pulls.get({ owner, repo, pull_number: pr.number, mediaType: { format: "diff" } })
  ).data as unknown as string

  // Full contents of changed files from the checked-out workspace, capped so
  // a huge PR can't blow up the prompt. Omissions are noted so the model
  // knows what it isn't seeing.
  let budget = TOTAL_CAP
  const fileSections: string[] = []
  for (const f of changedFiles(diff)) {
    if (SKIP_FILES.test(f)) continue
    const p = join(workspace, f)
    if (!existsSync(p)) continue
    let content: string
    try {
      content = readFileSync(p, "utf8")
    } catch {
      continue // unreadable (e.g. binary without a skip-list extension)
    }
    if (content.length > FILE_CAP) content = content.slice(0, FILE_CAP) + "\n… (truncated)"
    if (content.length > budget) {
      fileSections.push(`--- ${f} (contents omitted: prompt budget)`)
      continue
    }
    budget -= content.length
    fileSections.push(`--- ${f}\n${content}`)
  }

  // Repo file tree gives the model a map without agentic exploration.
  let tree = ""
  try {
    tree = execSync("git ls-files", { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .slice(0, TREE_MAX_LINES)
      .join("\n")
  } catch {
    // ponytail: no tree outside a git checkout; review works without it
  }

  const userContent = [
    `PR #${pr.number}: ${pr.title}\n${pr.body ?? ""}`,
    `## Repo file tree\n${tree}`,
    `## Diff\n\`\`\`diff\n${diff}\n\`\`\``,
    `## Full contents of changed files\n${fileSections.join("\n\n")}`,
  ].join("\n\n")

  // Two-pass review: secondary model goes first (best-effort), then the
  // primary reviews independently and merges in the secondary's novel
  // findings itself — dedup is semantic, done by the model, not by code.
  const secondaryModel = process.env.SECONDARY_MODEL?.trim() || ""
  let secondary: Review | null = null
  if (secondaryModel && secondaryModel !== model) {
    console.log(`Secondary review of PR #${pr.number} with ${secondaryModel} (prompt ~${userContent.length} chars)`)
    secondary = await callModel(secondaryModel, apiKey, userContent).catch((e) => {
      console.warn(`Secondary model ${secondaryModel} failed, continuing single-model: ${e.message}`)
      return null
    })
  }
  const primaryContent = secondary ? userContent + secondaryFindingsSection(secondary, secondaryModel) : userContent
  console.log(`Reviewing PR #${pr.number} with ${model} (prompt ~${primaryContent.length} chars)`)
  const review = await callModel(model, apiKey, primaryContent)

  // Split comments: anchorable ones go inline (repairing bad line numbers via
  // line_content), the rest into the summary.
  const newLines = diffNewLines(diff)
  const inline: { path: string; line: number; side: "RIGHT"; body: string }[] = []
  const overflow: string[] = []
  for (const c of review.comments) {
    let body = `**${c.severity}**: ${c.comment}`
    if (c.trigger) body += `\n\n_Trigger:_ ${c.trigger}`
    if (secondary) {
      const flagged = { primary: model, secondary: secondaryModel, both: `${model}, ${secondaryModel}` }[c.source]
      body += `\n\n_Flagged by: ${flagged}_`
    }
    const line = anchorComment(c, newLines)
    if (line !== null) inline.push({ path: c.file, line, side: "RIGHT", body })
    else overflow.push(`- \`${c.file}${c.line !== null ? `:${c.line}` : ""}\` ${body.replace(/\n+/g, " ")}`)
  }

  const emoji = { approve: "✅", comment: "💬", request_changes: "🛑" }[review.verdict]
  let body = `## ${emoji} ${BOT_NAME} — ${review.verdict.replace("_", " ")}\n\n${review.summary}`
  if (overflow.length) body += `\n\n### Notes on lines outside the diff\n${overflow.join("\n")}`
  if (review.signoff) body += `\n\n*${review.signoff}*`

  if (process.env.DRY_RUN) {
    console.log(JSON.stringify({ body, inline }, null, 2))
    return
  }

  await hidePreviousReviews(octokit, owner, repo, pr.number).catch((e) => console.warn(`Could not collapse old reviews: ${e.message}`))

  // ponytail: always COMMENT — APPROVE/REQUEST_CHANGES from the Actions token
  // trips org settings and blocks merges; the verdict lives in the body instead.
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pr.number,
    commit_id: pr.head.sha,
    event: "COMMENT",
    body,
    comments: inline,
  })
  console.log(`Posted review: ${inline.length} inline comment(s), ${overflow.length} in summary`)
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
