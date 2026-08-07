# Rules

Every check `novalue` performs, what it means, why it is worth reporting, and how to fix it.

Severities: **error** — a manifest will be rendered with a blank field. **warning** — nothing breaks, but the configuration is not doing what it appears to. **info** — a note about coverage of the analysis.

## The behaviour all of this rests on

Helm renders a missing value as the **empty string**. There is no error, no warning, and no exit code. That is not a bug — it is what makes optional values possible — but it means the difference between a value you set and a value you thought you set is invisible until something downstream rejects the result.

Two directions follow from it, and both are silent:

- a template reads a value nothing defines → a blank field in the manifest;
- a values file defines a key nothing reads → an override that changes nothing.

`helm lint` reports neither. `helm template` renders the blank field and prints it without comment.

---

## `value-renders-as-nothing` — error

A template reads `.Values.x` and no values file defines it, nothing guards it, and it does not belong to a subchart.

```yaml
image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"    # tag undefined
```

**Why it matters.** The render succeeds and produces `image: "myapp:"`. Kubernetes may reject it, or may not: an Ingress rule with an empty `host` is accepted and matches nothing, an env var with an empty value is accepted and breaks at run time, an empty `storageClassName` silently means "default". Every one of those is discovered in a cluster, hours later, by somebody who was not looking at the template.

**How coverage is decided.** Deliberately asymmetric:

- a definition of `resources.limits.cpu` **does** satisfy a read of `resources`, because `{{ toYaml .Values.resources }}` reads the whole subtree and a leaf under it makes that subtree real;
- a definition of `image` does **not** satisfy a read of `image.tag`. The parent existing says nothing about the child, and treating it as coverage hides the commonest case — which it did until the fixture caught it.

**What is never reported.** A reference wrapped in `required`, one given a `default`, one inside an `if`/`with` block, anything under a declared dependency's name, and anything under `global`.

**Fix.** Add the key to `values.yaml` with a sensible default, or wrap the reference in `required "…"` so an unset install fails the render instead of deploying a blank field.

---

## `null-value-read-unguarded` — error

A key is defined as `null` and read without a `default` or `required`.

```yaml
ingressHost: null
```

**Why it matters.** This is the sharpest version of the same bug, because the key **is** in `values.yaml`. Somebody asking "is that value set?" opens the file, finds it, confirms it, and moves on. It renders exactly like a key that was never there.

Charts written this way usually mean "the installer must supply this", which is a reasonable intention with no enforcement behind it — `required` is how that intention is expressed in a way Helm acts on.

**Fix.** Give the key a real default, or wrap the reference in `required "…"`.

---

## `value-never-read` — warning

A key is defined in a values file and no template reads it.

**Why it matters.** Nothing goes wrong at install time — Helm accepts any key you give it. That is precisely the problem: a misspelled override is indistinguishable from a working one.

```bash
helm upgrade app ./chart --set repicaCount=5
```

reports success, changes nothing, and leaves somebody certain they have scaled the deployment. The same key sitting in a `values.prod.yaml` behaves identically, and is reviewed and approved by people who reasonably assume Helm would have said something.

**Why it is only a warning.** An unread key breaks nothing on its own, and a chart may legitimately carry keys read by a subchart or by tooling outside Helm.

**Not reported.** Branch keys are not counted separately from their leaves — a defined `image` whose `image.tag` is read is read. Anything under a declared dependency's name is left to that dependency.

**Fix.** Remove the dead keys, and add a `values.schema.json` with `additionalProperties: false` so a misspelled override is rejected rather than ignored.

---

## `no-values-file` — warning

The templates read values and the chart has no `values.yaml` at all.

**Why it matters.** Every reference resolves to nothing unless the installer supplies it, and nothing in the chart says which keys that is. The first install renders a set of manifests with blank fields, and the only way to discover the required keys is to read every template.

**Fix.** Add a `values.yaml` documenting every key the templates read, with defaults where there is a sensible one. It is the chart's interface, and it is worth writing even when every value is overridden in practice.

---

## Deliberate non-findings

Cases where `novalue` stays quiet on purpose.

| Situation | Why nothing is reported |
|---|---|
| `{{ required "…" .Values.x }}` | Fails the render loudly, which is the fix this tool recommends. |
| `{{ .Values.x \| default "y" }}` | An explicit fallback. Optional by design. |
| A reference inside `{{- if .Values.x }}` | The idiomatic way to make a value optional. |
| `.Values.postgresql.…` with `postgresql` a declared dependency | The subchart supplies its own defaults. Reporting it would fire on every chart with a dependency. |
| `.Values.global.…` | Populated by the parent chart at install time. |
| A `.Values.x` inside a comment | Documenting a value is not reading it. Both YAML and Helm comments are skipped. |
| A defined branch whose leaves are read | Counting both would double-report one key. |
| A key defined only in a file passed with `--values` | That is what the flag is for. |

The bias throughout is toward under-reporting. A missed finding costs one blank field. A false positive costs the user's trust in every other finding, and then the check gets removed from the pipeline — which is worse than never having run it, because the chart now looks reviewed.
