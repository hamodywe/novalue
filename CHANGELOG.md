# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-08

First release.

### Added

- Reads every `.Values.…` a chart's templates reference, and every key its values files define, and reports the gap in both directions.
- `value-renders-as-nothing` — the headline: a template reads a value nothing defines, so Helm renders the empty string and the manifest ships with a blank field.
- `null-value-read-unguarded` — the sharpest version, where the key *is* in `values.yaml` as a `null`, so anybody checking finds it and concludes the chart is fine.
- `value-never-read` — the same silence in reverse: Helm accepts any key, so `--set repicaCount=5` reports success and changes nothing.
- `no-values-file` — templates that read values from a chart with no `values.yaml`.
- Guard detection for `required`, `default`, `hasKey`, `coalesce` and surrounding `if`/`with`/`range` blocks, scoped to the enclosing `{{ … }}` action rather than the line — a guard on one action must not excuse a bare reference beside it.
- Subchart awareness: values under a declared dependency's name, and under `global`, are supplied elsewhere and are never reported in either direction.
- Comment handling for both YAML `#` and Helm's own comment action, so documenting a value does not count as reading it.
- `--values`, `--json`, `--verbose` and `--fail-on` flags; exit `1` on findings, `2` on bad usage.
- Two fixtures, `examples/blank` and `examples/filled` — the same chart reading the same eleven values, with two different values files. The second is asserted to produce zero findings, so the silence is a property of the chart being correct rather than of a chart that reads less.
- 63 tests, run directly against the TypeScript sources with `node --test`.

### Notes

- Zero runtime dependencies. Read-only, offline, deterministic — no cluster is contacted, no Helm binary is needed, and nothing is rendered or executed.
- The coverage rule is deliberately asymmetric: a leaf satisfies a whole-subtree read, but a parent does not satisfy a missing child. Treating a defined `image` as covering `image.tag` hid the commonest form of this bug until the fixture caught it.

[Unreleased]: https://github.com/hamodywe/novalue/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hamodywe/novalue/releases/tag/v0.1.0
