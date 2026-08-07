# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/hamodywe/novalue/security/advisories/new)
rather than as a public issue.

Expect an acknowledgement within 72 hours and an assessment within seven days.

## Supported versions

The latest minor release receives security fixes. This project is pre-1.0.

## Scope

novalue reads a Helm chart and prints text. The following are in scope:

- **Code execution while scanning.** Nothing in a scanned chart should ever be
  executed. Templates are read as text and never rendered, which matters more
  here than in most scanners: rendering a chart runs its own logic, and
  `helm template` on an untrusted chart is not a safe operation.
- **Denial of service.** A crafted template or values file that makes a scan
  hang or exhaust memory. Directory descent is depth-capped and every scan is a
  single linear pass over each file.
- **Report injection.** Terminal escape sequences in a value path or a template
  line that repaint the report and forge a clean verdict. Control characters
  are stripped and text is length-capped before printing.
- **Path traversal.** A construction that gets the walker to read outside the
  scanned directory, including through `--values`.
- **Silent under-reporting.** A chart constructed so that a value which renders
  blank is reported as defined. Because this tool is used as a gate before a
  deploy, a reliable way to produce a false clean report is worth more to an
  attacker than a crash.

## Values files hold secrets

A `values.yaml`, and far more often a `values.prod.yaml` passed with `--values`,
can contain passwords and tokens. This tool reads them and **prints key paths
only** — `database.password` appears in a report, its value never does. If you
find a path that emits a value, that is a vulnerability and worth reporting
privately.

It also makes no network requests, so nothing read from a chart is ever sent
anywhere.

## Out of scope

- **A wrong verdict.** A missed blank field or a false alarm is a correctness
  bug and a genuinely useful report, but it is not a security issue. The
  deliberate non-findings documented in `docs/rules.md` are by design.
- **The security of charts novalue scans.** Kubernetes manifest hardening is
  `kube-linter`'s and `checkov`'s job.

## This tool's posture

- **No network access.** It never contacts a registry, a cluster, or a chart
  repository.
- **No Helm binary.** Nothing is rendered, templated, or installed.
- **Read-only.** novalue never writes to the chart it scans.
- **Zero runtime dependencies.** Installing it does not widen your supply chain.
- **No install script.**
