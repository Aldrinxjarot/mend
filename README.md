[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Aldrinxjarot/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Aldrinxjarot/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies the edits AI models write — in every format they write them in — to a tree of
text files, changing every file or none.

Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON. mend reads all four to one specification (the kit's SPEC.md):

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The patch comes from the PATCH file, or from standard input when PATCH is absent or `-`.
- `--format` names one format (`unified`, `search-replace`, `v4a`, `json`); the default, `auto`, detects it.
- Each edit's old lines are found at the first of three matching tiers that has them: exact, trailing-whitespace
  drift, then indentation drift (with new lines re-indented to the file's own indentation). `--strict` keeps only
  the exact tier. `--check` reports what would change and writes nothing.
- Edits apply in the patch's order, each to the tree as the earlier ones left it. If any edit fails, every failure
  is reported and no file is written; if none fails, the tool prints one line per changed path (`A`, `D`, `M`, or
  `R` for a move) and an `ok:` summary.

`main.ts` is the CLI (Node 22, standard library only). `runner.ts`, kept as the make.fun kit has it, is the trial
runner: when `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it, and it runs the CLI on each check the env lists
and posts the exit code, stdout and resulting files of every run.
