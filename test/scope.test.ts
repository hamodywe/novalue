import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyze } from '../src/analyze.ts';
import { readReferences, withinAction } from '../src/chart/references.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROKEN = path.join(REPO_ROOT, 'examples', 'blank');
const FIXED = path.join(REPO_ROOT, 'examples', 'filled');

const paths = (source: string) => readReferences(source, 'a.yaml').map((r) => r.path);

/** Write a throwaway chart and analyse it. */
async function withChart<T>(
  files: Readonly<Record<string, string>>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'novalue-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const target = path.join(dir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, 'utf8');
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('with rebinds the dot', () => {
  it('resolves a field read off the scope', () => {
    // `{{- with .Values.ingress }}` then `{{ .hostname }}` reads
    // `.Values.ingress.hostname`. Searching only for `.Values.` finds nothing
    // here, and this is how a large share of real charts are written.
    const source = '{{- with .Values.ingress }}\nhost: {{ .hostname }}\n{{- end }}\n';
    assert.deepEqual(paths(source), ['ingress', 'ingress.hostname']);
  });

  it('resolves a nested field path', () => {
    const source = '{{- with .Values.image }}\nref: {{ .registry.host }}\n{{- end }}\n';
    assert.ok(paths(source).includes('image.registry.host'));
  });

  it('stacks nested with blocks', () => {
    const source = '{{- with .Values.a }}\n{{- with .b }}\nx: {{ .c }}\n{{- end }}\n{{- end }}\n';
    assert.ok(paths(source).includes('a.b.c'));
  });

  it('stops resolving once the block ends', () => {
    const source = '{{- with .Values.a }}\nx: {{ .b }}\n{{- end }}\ny: {{ .Values.c }}\n';
    const found = paths(source);

    assert.ok(found.includes('a.b'));
    assert.ok(found.includes('c'));
    assert.ok(!found.includes('a.c'), 'the scope must not leak past the end');
  });

  it('does not report a bare dot as a field', () => {
    // `{{ toYaml . }}` reads the scope whole, which the `with` already proved.
    assert.deepEqual(paths('{{- with .Values.a }}\n{{ toYaml . | nindent 2 }}\n{{- end }}\n'), ['a']);
  });

  it('leaves built-in objects alone', () => {
    const source = '{{- with .Values.a }}\nname: {{ $.Release.Name }}\n{{- end }}\n';
    assert.ok(!paths(source).some((entry) => entry.includes('Release')));
  });

  it('does not read a variable field as a scope field', () => {
    const source = '{{- with .Values.a }}\nx: {{ $top.other }}\n{{- end }}\n';
    assert.ok(!paths(source).includes('a.other'));
  });

  it('ignores a dotted word outside an action', () => {
    // Templates are YAML, and YAML is full of `example.com` and `app.kubernetes.io/name`.
    const source = '{{- with .Values.a }}\nhost: example.com\n{{- end }}\n';
    assert.deepEqual(paths(source), ['a']);
  });
});

describe('range does not rebind to a values path', () => {
  it('ignores element fields inside a range', () => {
    // `.` is an item of the list. `.name` is that item's field, not a values key.
    const source = '{{- range .Values.env }}\n- name: {{ .name }}\n{{- end }}\n';
    assert.deepEqual(paths(source), ['env']);
  });

  it('does not resolve element fields against an outer with', () => {
    const source = '{{- with .Values.a }}\n{{- range .items }}\nx: {{ .name }}\n{{- end }}\n{{- end }}\n';
    const found = paths(source);

    assert.ok(found.includes('a.items'));
    assert.ok(!found.includes('a.name'), 'a list element is not a values path');
  });

  it('resumes the outer scope after the range ends', () => {
    const source = '{{- with .Values.a }}\n{{- range .items }}\n{{- end }}\nx: {{ .title }}\n{{- end }}\n';
    assert.ok(paths(source).includes('a.title'));
  });
});

describe('guards cover what they test', () => {
  it('treats the with target itself as guarded', () => {
    const found = readReferences('{{- with .Values.a }}\n{{ toYaml . }}\n{{- end }}\n', 'a.yaml');
    assert.equal(found.find((r) => r.path === 'a')?.guarded, true);
  });

  it('does not treat a field of the with target as guarded', () => {
    // `with .Values.ingress` proves ingress is non-empty. `.hostname` may still
    // be absent, and then the rendered host is blank.
    const found = readReferences('{{- with .Values.ingress }}\nh: {{ .hostname }}\n{{- end }}\n', 'a.yaml');
    assert.equal(found.find((r) => r.path === 'ingress.hostname')?.guarded, false);
  });

  it('still honours default and required inside a block', () => {
    const source = '{{- if .Values.a }}\nx: {{ .Values.b | default "1" }}\ny: {{ required "set c" .Values.c }}\n{{- end }}\n';
    const found = readReferences(source, 'a.yaml');

    assert.equal(found.find((r) => r.path === 'b')?.guarded, true);
    assert.equal(found.find((r) => r.path === 'c')?.required, true);
  });

  it('guards every path named in a compound test', () => {
    const source = '{{- if and .Values.a .Values.b }}\nx: {{ .Values.a }}{{ .Values.b }}\n{{- end }}\n';
    const found = readReferences(source, 'a.yaml');

    assert.ok(found.filter((r) => r.line === 2).every((r) => r.guarded));
  });

  it('closes a block opened and closed on one line', () => {
    const source = '{{ if .Values.a }}x{{ end }}\ny: {{ .Values.b }}\n';
    const found = readReferences(source, 'a.yaml');
    assert.equal(found.find((r) => r.path === 'b')?.guarded, false);
  });
});

describe('withinAction', () => {
  it('is true between the braces and false outside them', () => {
    const line = 'host: {{ .hostname }} # note';
    assert.equal(withinAction(line, line.indexOf('.hostname')), true);
    assert.equal(withinAction(line, line.indexOf('# note')), false);
  });

  it('is false before any action opens', () => {
    assert.equal(withinAction('host: example.com', 5), false);
  });
});

describe('a chart written the idiomatic way', () => {
  it('finds the blank field a with block hides', async () => {
    const findings = await withChart({
      'Chart.yaml': 'apiVersion: v2\nname: p\nversion: 0.1.0\n',
      'values.yaml': 'ingress:\n  className: nginx\n',
      'templates/ing.yaml': '{{- with .Values.ingress }}\n- host: {{ .hostname }}\n{{- end }}\n',
    }, async (dir) => (await analyze({ root: dir })).unresolved.map((r) => r.path));

    assert.deepEqual(findings, ['ingress.hostname']);
  });

  it('says nothing when the same chart defines the field', async () => {
    const findings = await withChart({
      'Chart.yaml': 'apiVersion: v2\nname: p\nversion: 0.1.0\n',
      'values.yaml': 'ingress:\n  className: nginx\n  hostname: example.com\n',
      'templates/ing.yaml': '{{- with .Values.ingress }}\n- host: {{ .hostname }}\n{{- end }}\n',
    }, async (dir) => (await analyze({ root: dir })).unresolved.map((r) => r.path));

    assert.deepEqual(findings, []);
  });
});

describe('the shipped fixtures', () => {
  it('the blank chart still reports every mechanism', async () => {
    const report = await analyze({ root: BROKEN });
    const rules = new Set(report.findings.map((finding) => finding.ruleId));

    assert.ok(rules.has('value-renders-as-nothing'));
    assert.ok(report.unresolved.length > 0);
  });

  it('the filled chart reports nothing at all', async () => {
    const report = await analyze({ root: FIXED });
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), []);
  });
});
