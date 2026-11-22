# mend

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org/)
[![make.fun](https://img.shields.io/badge/make.fun-hidden--spec--cli--01-blue.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads all
four to one written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none (atomic).

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
— "Build mend, one patch tool for every AI edit format".

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-`/absent to read the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`;
  `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` applied (prints `A`/`D`/`M`/`R` lines and `ok: <n> files`),
`1` some edits failed (prints `error: <code> <path>` per failed edit and
`failed: <k> of <n> edits`, nothing written), `2` usage / patch / format error
(one `error: ...` line).

## Matching

An edit's old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: equal once trailing spaces and tabs are removed;
- tier 2: equal once leading and trailing spaces and tabs are removed
  (new lines are re-indented from the patch's indentation to the file's).

Unified hunks take the occurrence nearest the hunk's (often wrong) line number;
SEARCH/REPLACE blocks require exactly one occurrence; V4A chunks follow a cursor
and an optional anchor line.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone; nothing is installed.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — runs the kit's practice set against `main.ts`:
  `node check.ts <practice.json>`.
- `SPEC.md` — the full specification this tool implements.

## Testing

    node check.ts ../program/generator/practice.json

Practice score: **1000** (100 of 100 checks pass). An additional 88 hand-written
edge-case checks (wrong line numbers, tier-2 re-indentation, CRLF files, files
without a final line break, `\ No newline at end of file`, moves, atomicity,
parse-error line numbers, detection precedence, `--check`) all pass.

## License

MIT. See [LICENSE](LICENSE).
