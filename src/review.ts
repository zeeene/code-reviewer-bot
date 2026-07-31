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
const ReviewSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["approve", "comment", "request_changes"]),
  comments: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive(),
        severity: z.enum(["critical", "warning", "suggestion"]),
        comment: z.string(),
      })
    )
    .default([]),
  // In-character closing line — the one place humor is allowed (see SYSTEM_PROMPT).
  signoff: z.string().default(""),
})
export type Review = z.infer<typeof ReviewSchema>

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/review.test.ts)
// ---------------------------------------------------------------------------

// Pull the first JSON object out of a model reply, tolerating markdown fences.
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return JSON.parse((fenced ? fenced[1] : text).trim())
}

// Lines the GitHub review API accepts inline comments on: new-side lines
// (additions and context) that appear in the diff. Keyed as "file:line".
// Anything the model flags outside this set gets folded into the summary,
// because createReview 422s on out-of-diff anchors.
export function diffAnchors(diff: string): Set<string> {
  const anchors = new Set<string>()
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
      anchors.add(`${file}:${line}`)
      line++
    }
  }
  return anchors
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

  console.log(`Reviewing PR #${pr.number} with ${model} (prompt ~${userContent.length} chars)`)
  const review = await callModel(model, apiKey, userContent)

  // Split comments: anchorable ones go inline, the rest into the summary.
  const anchors = diffAnchors(diff)
  const inline: { path: string; line: number; side: "RIGHT"; body: string }[] = []
  const overflow: string[] = []
  for (const c of review.comments) {
    const body = `**${c.severity}**: ${c.comment}`
    if (anchors.has(`${c.file}:${c.line}`)) inline.push({ path: c.file, line: c.line, side: "RIGHT", body })
    else overflow.push(`- \`${c.file}:${c.line}\` ${body}`)
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
