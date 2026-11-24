# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Noman7860000/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Noman7860000/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies a patch to a working tree. One tool, four formats — the
patch format is detected automatically, or forced with `--format`:

- **unified** diffs (`diff --git` / `---` + `+++` hunks)
- **search-replace** blocks (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`)
- **v4a** patches (`*** Begin Patch` … `*** End Patch`)
- **json** edit lists (one JSON array, or one edit object per line)

Matching works in three tiers — exact, then trailing whitespace ignored,
then leading and trailing whitespace ignored — and a match at a higher
tier re-indents the new lines to the file's own indentation. `--strict`
restricts matching to exact only.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file path, or `-` / omitted to read the patch from stdin.
`--check` reports what would change without writing anything.

Exit codes: `0` success, `1` one or more edits failed, `2` usage error,
no patch, unknown format, or parse error. On success, one line per
changed path (`A` added, `D` deleted, `M` modified, `R <old> -> <new>`
for moves, in UTF-8 byte order), then `ok: <n> file(s)`. On failure, one
`error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits` — and no file is written at all: edits apply
in patch order to the tree as earlier edits left it, a failed edit
changes nothing, and when any edit failed, nothing is written.

## Formats

**Unified.** Sections start at `diff --git a/<X> b/<Y>` or at a `--- ` +
`+++ ` pair. Creation is when the old side is `/dev/null` or `new file
mode`; deletion when the new side is `/dev/null` or `deleted file mode`;
a move when old and new paths differ. Hunks apply in order; a hunk with
a non-empty old side replaces the occurrence nearest to its stated line
(ties go to the earlier one), and a hunk with an empty old side inserts
after the stated line. A `\` line after a hunk's last context or `+`
line means the result does not end with a line break.

**Search-replace.** A block's path is the nearest non-blank, non-fence
line before its `<<<<<<< SEARCH` (or the previous block's path). An
empty old side creates the file; otherwise the old lines must occur
exactly once at the first matching tier, or the edit fails as
`ambiguous` / `no-match`.

**V4A.** `*** Add File:`, `*** Delete File:` and `*** Update File:`
sections. Updates take `*** Move to:` and chunks that start at an `@@`
anchor line or at the first body line; `*** End of File` anchors a
chunk to the end of the file. Chunks apply in order with a cursor that
moves past what each chunk writes.

**JSON.** `create` writes `file_text` byte for byte; `str_replace`
replaces `old_str` with `new_str` (exactly one occurrence, overlapping
positions counted; CRLF files are converted to LF for the match and
back again); `insert` inserts `new_str`'s lines after `insert_line`
(`0` is the top of the file).

## Files

- `main.ts` — the whole tool (Node 22, standard library only)
- `runner.ts` — the kit's trial runner, kept as shipped
- `SPEC.md` — the specification this implements
- `LICENSE` — MIT
