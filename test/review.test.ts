import { test } from "node:test"
import assert from "node:assert/strict"
import { diffNewLines, anchorComment, changedFiles, extractJson } from "../src/review.ts"

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1
+const y = 2
 const z = 3
 export { x, z }
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-old
-old2
`

test("diffNewLines maps additions and context on the new side with content", () => {
  const files = diffNewLines(DIFF)
  const a = files.get("src/a.ts")!
  assert.equal(a.get(1), "const x = 1") // context
  assert.equal(a.get(2), "const y = 2") // addition
  assert.equal(a.get(4), "export { x, z }") // context after addition
  assert.ok(!a.has(5)) // past the hunk
  assert.ok(!files.has("gone.ts")) // deleted file has no new side
})

test("changedFiles skips deleted files", () => {
  assert.deepEqual(changedFiles(DIFF), ["src/a.ts"])
})

const base = { severity: "warning" as const, trigger: "", comment: "c", line_content: null, line: null }

test("anchorComment trusts a valid line, repairs via line_content, else null", () => {
  const files = diffNewLines(DIFF)
  // valid line passes through
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 2 }, files), 2)
  // wrong line, repaired by exact content match
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 99, line_content: "const y = 2" }, files), 2)
  // null line with content match
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line_content: "  const z = 3  " }, files), 3)
  // unanchorable: bad line, no matching content
  assert.equal(anchorComment({ ...base, file: "src/a.ts", line: 99, line_content: "nope" }, files), null)
  // unknown file
  assert.equal(anchorComment({ ...base, file: "other.ts", line: 1 }, files), null)
})

test("extractJson handles scratch blocks, fences, bare JSON, and stray prose", () => {
  assert.deepEqual(extractJson('<scratch>{"fake":1} thinking...</scratch>\n{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson(' {"a":1} '), { a: 1 })
  assert.deepEqual(extractJson('Here is the review:\n{"a":1}\nDone.'), { a: 1 })
})
