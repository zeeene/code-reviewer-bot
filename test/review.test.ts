import { test } from "node:test"
import assert from "node:assert/strict"
import { diffAnchors, changedFiles, extractJson } from "../src/review.ts"

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

test("diffAnchors covers additions and context on the new side", () => {
  const a = diffAnchors(DIFF)
  assert.ok(a.has("src/a.ts:1")) // context
  assert.ok(a.has("src/a.ts:2")) // addition
  assert.ok(a.has("src/a.ts:4")) // context after addition
  assert.ok(!a.has("src/a.ts:5")) // past the hunk
  assert.ok(![...a].some((k) => k.startsWith("gone.ts"))) // deleted file has no new side
})

test("changedFiles skips deleted files", () => {
  assert.deepEqual(changedFiles(DIFF), ["src/a.ts"])
})

test("extractJson handles fenced and bare JSON", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson(' {"a":1} '), { a: 1 })
})
