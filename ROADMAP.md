# Roadmap

What is planned, what is being considered, and what will not be built. Dated
items are intentions, not commitments.

## Shipped — 0.1.0

- References read from templates, definitions read from values files, and the
  gap reported in both directions.
- Guard detection for `required`, `default`, `hasKey`, `coalesce` and
  surrounding `if`/`with`/`range` blocks.
- Subchart and `global` awareness, and comment handling for both YAML and Helm
  comment forms.

## Next

**`values.schema.json` as a third source of truth.** A chart with a schema has
already declared its interface, and comparing it against both the templates and
the values file would catch a fourth mismatch: a key the schema requires that no
template reads. It is also the fix this tool recommends most often, so
understanding it is overdue.

**Multiple charts in one run.** A repository with several charts is reported on
for the first, with a warning. Reporting on all of them, grouped, is mostly
output work.

**Named template awareness.** A `.Values` reference inside `_helpers.tpl` counts
as read even if nothing includes that helper. Following `include` and `template`
calls would make both directions more accurate.

**`--set` arguments.** Accepting the same `--set key=value` syntax Helm takes
would let a pipeline check exactly the invocation it is about to run.

**SARIF output.** So findings land as annotations on the pull request that
introduced them, next to the diff, rather than in a log nobody opens.

## Considered

**Rendering the chart to check the result.** It would resolve every reference
exactly, including the ones built by string concatenation. It also means running
the chart's own logic, and this tool's guarantee is that it is safe to point at
a chart you have not read. If it happens it will be an opt-in mode that shells
out to `helm template`, clearly marked.

**Reading `Chart.lock` to resolve subchart defaults.** It would let the tool say
something about values under a dependency's name rather than skipping them. It
means fetching or vendoring the dependency, which is a network operation.

**Judging whether a default is a *good* default.** Out of scope, and not
decidable.

## Not planned

**Rendering by default.** No Helm binary, no cluster, nothing executed.

**Linting Kubernetes manifests.** `kube-linter`, `kubeconform` and `checkov` do
that well. This tool answers a question about the chart, not about the output.

**Fixing files in place.** Read-only is a design constraint, not a missing
feature.

**Runtime dependencies.** There will not be any.

---

Requests and disagreements belong in
[issues](https://github.com/hamodywe/novalue/issues). A real chart this tool
judged wrongly — especially one where `helm template` disagrees with it — will
move an item up this list faster than anything else.
