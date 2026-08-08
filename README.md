# novalue

**Finds the Helm values that render as nothing.**

Helm renders a missing value as the empty string. Not an error, not a warning:

```yaml
image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
```

With no `tag` in `values.yaml`, that becomes:

```yaml
image: "myapp:"
```

Valid YAML. A valid manifest. A pod that never starts. And the failure surfaces in a cluster — as an image that cannot be pulled, or an Ingress rule with no host that quietly matches nothing — a long way from the template that caused it.

The same silence works in reverse. Helm accepts **any** key you give it, so a typo in a values file is not a typo as far as Helm is concerned:

```bash
helm upgrade app ./chart --set repicaCount=5     # reports success, changes nothing
```

`helm lint` passes. `helm template` renders happily and prints the blank field without comment. `values.schema.json` with `additionalProperties: false` catches the second direction if you have one, and most charts do not.

```
$ npx novalue .

17 values read · 11 defined · 6 render as nothing
  ███████████████████▍           65% of what the templates read exists

  blank · 4 templates · 10 keys defined · 3 never read

error   value-renders-as-nothing templates/autoscaling.yaml:10
  6 values the templates read are defined nowhere
  fix: Add these keys to values.yaml with a sensible default, or wrap the
       reference in `required "…"`. A `values.schema.json` would also catch
       the typo direction.
    templates/autoscaling.yaml:10 — .Values.autoscaling.minReplicas — minReplicas: {{ .Values.autoscaling.minReplicas }}
    templates/autoscaling.yaml:24 — .Values.ingress.className — controller: {{ .className }}
    templates/deployment.yaml:12 — .Values.image.tag — image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
    templates/deployment.yaml:17 — .Values.apiUrl — value: {{ .Values.apiUrl }}

error   null-value-read-unguarded values.yaml:15
  1 value is defined as null and read without a default
```

---

## Install

```bash
npx novalue .                  # no install
npm install --save-dev novalue
```

Node 20.10 or newer. **Zero runtime dependencies.** No cluster, no Helm binary, no network — nothing is rendered or executed.

## Quick start

```bash
novalue .                              # scan the chart
novalue ./charts/api                   # a chart in a subdirectory
novalue . --values values.prod.yaml    # also count what production supplies
novalue . --verbose                    # list every value that renders blank
novalue . --json                       # machine-readable
```

Exit code `1` when something at or above the threshold is found, `0` when clean, `2` on bad usage. In CI, beside `helm lint`:

```yaml
- run: helm lint ./chart
- run: npx novalue ./chart
```

### Options

| Flag | Meaning |
|---|---|
| `--values <file>` | An extra values file, as supplied at install (repeatable) |
| `--json` | JSON report on stdout, verdict on stderr |
| `--verbose` | List every value that will render as nothing |
| `--fail-on <level>` | `error` (default), `warning`, or `info` |
| `-h, --help` / `-v, --version` | |

---

## What it checks

| Rule | Severity | What it means |
|---|---|---|
| `value-renders-as-nothing` | error | A template reads a value nothing defines and nothing guards. |
| `null-value-read-unguarded` | error | Defined as `null`, read without a default. Present, and still blank. |
| `value-never-read` | warning | Defined and no template reads it — what a typo looks like from the other side. |
| `no-values-file` | warning | Templates read values and the chart has no `values.yaml`. |

Full reasoning and the fix for each is in [`docs/rules.md`](docs/rules.md).

### The `null` one is the sharpest

```yaml
ingressHost: null
```

This is *in* `values.yaml`. Somebody wondering whether the key is set finds it, confirms it, and moves on. It renders exactly like a key that was never there — an Ingress rule with an empty host, which matches nothing and reports no error.

### What counts as guarded

A reference is **not** reported when the chart already handles the missing case:

```yaml
{{ required "apiToken is required" .Values.apiToken }}   # fails the render, loudly
{{ .Values.region | default "eu-west-1" }}               # explicit fallback
{{- if .Values.ingress.enabled }} … {{- end }}           # `ingress.enabled` is optional by design
```

`required` is the fix this tool recommends, so a chart already using it is a chart doing the right thing.

A block guards **the key it tests**, and that key's parents — not everything inside it:

```yaml
{{- if .Values.autoscaling.enabled }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}    # reported: nothing proved this exists
{{- end }}
```

`enabled` being true says nothing about `minReplicas`. The sibling of a tested key is exactly what renders blank, so treating the whole block as covered is how a chart with empty fields gets a clean report.

### Values read through `with`

`with` rebinds the dot, so a reference can read a value without the string `.Values.` appearing on the line at all:

```yaml
{{- with .Values.ingress }}
  - host: {{ .hostname }}        # this is .Values.ingress.hostname
    class: {{ .className }}      # and this is .Values.ingress.className
{{- end }}
```

Both are resolved against the enclosing scope, nested `with` blocks included. Inside `range` the dot is an *element* of a collection, not a values path — `{{ .name }}` there is a field of the item being iterated, and is deliberately not resolved, because inventing `.Values.name` from it would be a finding about a key that does not exist.

---

## Try it

Two fixtures ship with the repo: the same chart, with two values files.

```bash
git clone https://github.com/hamodywe/novalue && cd novalue
node src/cli.ts examples/blank     # three findings, exit 1
node src/cli.ts examples/filled    # silent, exit 0
```

`examples/filled` reads exactly the same eleven values as `examples/blank` — same templates, same subchart, same `required` and `default` calls. The only difference is the values file. That is deliberate: the silence is a property of the chart being correct, not of a chart that reads less. A check that fires on a chart doing everything right fires everywhere, and then people turn it off.

## How it works

```
Chart.yaml   ──> chart name, and the dependencies whose values are theirs, not yours
templates/   ──> every .Values.… a template reads, with required / default / if noted
values.yaml  ──> every key defined, leaves and branches, with nulls marked
                          │
                          ▼
        read but not defined  →  renders as the empty string
        defined but not read  →  what a misspelled override looks like
```

Templates are scanned as text, because a Helm template is not YAML until it is rendered — parsing it as YAML fails on every chart, and rendering it means executing the chart's own logic. Comments are skipped, both the YAML kind and Helm's own, so documenting a value does not count as reading it.

The coverage rule is deliberately asymmetric: a leaf satisfies a whole-subtree read (`{{ toYaml .Values.resources }}` is fine if `resources.limits.cpu` exists), but a parent does **not** satisfy a missing child. `image` being defined says nothing about `image.tag` — and treating it as coverage hid the single most common form of this bug until the fixture caught it.

## Limitations

Stated plainly, because a tool that overstates its coverage is worse than no tool.

- **Nothing is rendered.** A value referenced only inside a `define` block that is never included, or built by string concatenation, is judged on how it looks rather than on what Helm would do.
- **Subchart values are not resolved.** Anything under a declared dependency's name — or under `global` — is assumed supplied by that chart's own defaults and is never reported, in either direction.
- **`--set` and `-f` at install time are invisible.** A key supplied only on the command line looks undefined here. Pass the values file with `--values`, or use `required` in the template, which is better anyway.
- **Guard detection is lexical.** A block guards the paths named in its own test; `default`/`required`/`hasKey` guard within their action. A guard expressed some other way — a variable assigned earlier, a helper that checks the key — may produce a false positive.
- **Scope is followed for `with`, not for variables.** `{{- with .Values.a }}{{ .b }}{{- end }}` resolves to `a.b`. A scope captured into a variable (`{{- $cfg := .Values.a }}{{ $cfg.b }}`) is not followed, so those reads are invisible.
- **One chart per run.** A repository with several is reported on for the first, with a warning naming the count.
- **Named templates are read like any other file.** A `.Values` reference inside `_helpers.tpl` counts as read even if nothing includes that helper.

## FAQ

**Doesn't `helm lint` catch this?**
No. `helm lint` checks chart structure and renders the templates; a blank field renders perfectly well. Nothing in Helm treats a missing value as a problem, which is the whole design — it is what makes optional values possible.

**Isn't `values.schema.json` the answer?**
For the typo direction, yes, and this tool recommends it. A schema with `additionalProperties: false` rejects `repicaCount`. It does not help with the other direction: a schema describes what values *may* be supplied, not what the templates *require*.

**We supply everything through a GitOps values file.**
Pass it with `--values`. What the chart's own `values.yaml` omits is still worth knowing, because it is what anyone installing the chart without your file will get.

**Will it change my files?**
No. It reads, it reports, it exits. There is no write path in the codebase.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A chart this tool judged wrongly is the most useful thing you can send.

## License

[MIT](LICENSE)
