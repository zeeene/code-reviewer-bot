# LGTM-9000

AI code review on pull requests. One OpenRouter API call per PR: the diff plus the
full contents of changed files go in, one GitHub review with inline comments comes out.
No server, no agent framework.

> _I'm sorry, Dave. I'm afraid I can't approve this._

## When it reviews

- PR **opened** (unless it's a draft)
- Draft PR marked **ready for review**
- On request: comment **`/review`** (or **`/lgtm9000`**) on any PR

It does **not** re-review on every push — ask with `/review` when you want a fresh pass.
Old bot reviews are collapsed as outdated when a new one posts.
Add the **`no-ai-review`** label to a PR to keep the bot out entirely.

## Use in any repo

Add `.github/workflows/review.yml`:

```yaml
name: lgtm-9000
on:
  pull_request:
    types: [opened, ready_for_review]
  issue_comment:
    types: [created]
concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    if: >
      (github.event_name == 'pull_request' &&
       github.event.pull_request.draft == false &&
       !contains(github.event.pull_request.labels.*.name, 'no-ai-review')) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       !contains(github.event.issue.labels.*.name, 'no-ai-review') &&
       (contains(github.event.comment.body, '/review') ||
        contains(github.event.comment.body, '/lgtm9000')))
    runs-on: self-hosted # or ubuntu-latest — the action handles Node setup either way
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/head', github.event.issue.number) || '' }}
      - uses: sendernet/lgtm-9000@main
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          # model: qwen/qwen3.7-flash   # any OpenRouter model id
          # extra-instructions: |       # optional project-specific review guidance
          #   This is a payments service; scrutinize idempotency and rounding.
```

Then add an `OPENROUTER_API_KEY` secret (repo → Settings → Secrets → Actions).

## Local dry run

```bash
DRY_RUN=1 GITHUB_EVENT_PATH=event.json GITHUB_TOKEN=$(gh auth token) OPENROUTER_API_KEY=sk-... npm run review
```

`event.json` needs `pull_request.{number,title,head.sha}` and `repository.full_name`.

## Test

```bash
npm test
```
