# Contributing

Thanks for taking the time. The most valuable contribution to this project is a
**chart this tool judged wrongly** — a value it said renders blank that is
supplied some way the scan cannot see, or one it approved of that turned out
empty in a cluster.

## Getting set up

```bash
git clone https://github.com/hamodywe/novalue
cd novalue
npm install          # devDependencies only — there are no runtime dependencies
npm test
npm run typecheck
```

Node 22.18 or newer is needed for development, because the test suite runs the
TypeScript sources directly using Node's built-in type stripping. The published
package is compiled and supports Node 20.10; CI verifies that by running the
built CLI on 20.10 rather than assuming it.

Useful while working:

```bash
node src/cli.ts examples/blank --verbose   # the broken fixture
node src/cli.ts examples/filled            # the correct one, must be silent
```

Helm is **not** required to develop or run this. Nothing is rendered.

## Reporting a wrong verdict

Include the template lines, the values file, and how the chart is installed —
`--set` and `-f` at install time are invisible to a repository scan, and half
the disagreements come from there.

`helm template` settles the rest immediately, because it shows what Helm really
produces:

```bash
helm template ./chart | grep -n 'image:'
```

If `helm template` renders a value and this tool says it is undefined, that is a
bug here.

## The bar for a new check

A check earns its place if it can answer all four:

1. **Will a manifest provably contain a blank field, or is it only suspicious?**
   Provably is an error. Suspicious is a warning. Nothing is reported on a hunch.
2. **Does `helm lint` or a `values.schema.json` already say it?** If a schema
   with `additionalProperties: false` would catch it, recommend the schema
   rather than adding a rule.
3. **What is the one-line fix?** Every finding prints a specific remediation. If
   the fix cannot be stated in a sentence, the check is not ready.
4. **Does it stay silent on `examples/filled`?** That fixture reads the same
   eleven values as the broken one. A rule that fires on it fires on every
   correct chart.

When in doubt, under-report.

## Working on reference detection

`src/chart/references.ts` is scanning text, not parsing a language, and that is
deliberate: a Helm template is not YAML until it is rendered, and rendering it
means executing the chart's own logic. Three behaviours are load-bearing and
each has a test:

- **`default` and `required` are scoped to their action**, not to the line. A
  line can hold several actions, and crediting a guard from a neighbouring one
  would suppress a real finding.
- **A parent does not cover a missing child.** `image` being defined says
  nothing about `image.tag`. The reverse *does* hold: a leaf makes a
  whole-subtree read real.
- **Comments are not reads.** Both YAML `#` and Helm's own comment action.
  Charts document their values constantly, and reporting prose as a reference
  would fire on the best-documented charts first.

## Adding a guard form

If a chart pattern makes a missing value safe and this tool does not know about
it, that is a false positive worth fixing. Add it to `GUARDS`, add a test that
states what the pattern does, and say in the pull request why the value cannot
render blank under it.

## Tests

`node --test` over `test/*.test.ts`. Three conventions matter:

- **CLI tests spawn a subprocess.** Never capture output by replacing
  `process.stdout.write` — the test runner writes to the same stream, and the
  result is a suite that reports passing while swallowing failures.
- **`src/cli.ts` only runs when it is the entry point.** The tests import
  `parseArgs` from it; without that guard the import executes the CLI against
  the test runner's own arguments and fails the suite while every assertion
  passes.
- **Every fixture has a correct twin.** `examples/blank` and `examples/filled`
  are the same chart with two values files, and the second is asserted to
  produce zero findings.

## Style

- TypeScript, strict, ESM.
- **Zero runtime dependencies.** This is not negotiable — the tool runs in CI on
  other people's repositories.
- Comments explain *why*. What the code does should be legible from the code.
- Read-only and offline. No cluster, no Helm binary, nothing rendered.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): subject` — imperative, lowercase, no trailing period. The body
explains why.

```
fix(references): stop a defined parent covering a missing child

A chart defining `image` but not `image.tag` was reported as clean, which
is the commonest form of this bug and the one the tool exists to find.
```

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
