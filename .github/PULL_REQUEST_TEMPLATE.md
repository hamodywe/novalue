# What and why

<!-- What changes, and what problem it solves. The why matters more than the what. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` is clean
- [ ] `node src/cli.ts examples/filled` is still **silent** — that fixture reads
      the same eleven values as the broken one, so a rule firing on it fires everywhere
- [ ] `node src/cli.ts examples/blank` still finds every mechanism
- [ ] No runtime dependencies added
- [ ] Nothing is rendered and nothing is executed
- [ ] No values-file content can reach the report — key paths only
- [ ] Docs updated (`README.md`, `docs/rules.md`, `CHANGELOG.md`) if behaviour changed

## If this changes reference detection

- [ ] `default` and `required` are still scoped to their action, not the line
- [ ] A defined parent still does **not** cover a missing child
- [ ] A leaf still covers a whole-subtree read
- [ ] Comments — YAML and Helm — are still not counted as reads
- [ ] There is a test that states the rule in words

## If this adds or changes a check

- [ ] The finding states a **one-line fix**
- [ ] Severity matches certainty — a blank field is an error, a dead key is a warning
- [ ] There is a fixture for it, and a case that must *not* fire
- [ ] Subchart and `global` values are still left alone
