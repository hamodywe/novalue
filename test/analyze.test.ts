import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  analyze, checkNoValuesFile, checkNullDefaults, checkUnread, checkUnresolved,
  findUnread, findUnresolved,
} from '../src/analyze.ts';
import {
  covers, distinctPaths, enclosingExpression, inComment, readReferences,
} from '../src/chart/references.ts';
import { findCharts, readDefinitions } from '../src/scan/chart.ts';
import type { Chart, ValueDefinition, ValueReference } from '../src/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLANK = path.join(REPO_ROOT, 'examples', 'blank');
const FILLED = path.join(REPO_ROOT, 'examples', 'filled');

const ids = (findings: readonly { ruleId: string }[]) => new Set(findings.map((f) => f.ruleId));

const chart = (overrides: Partial<Chart> = {}): Chart => ({
  directory: '.', name: 'test', dependencies: [], templates: ['templates/a.yaml'],
  valuesFiles: ['values.yaml'], hasSchema: false, ...overrides,
});

const definition = (
  valuePath: string,
  overrides: Partial<ValueDefinition> = {},
): ValueDefinition => ({
  path: valuePath, file: 'values.yaml', line: 1, isNull: false, isBranch: false, ...overrides,
});

const reference = (
  valuePath: string,
  overrides: Partial<ValueReference> = {},
): ValueReference => ({
  path: valuePath, file: 'templates/a.yaml', line: 1, required: false, guarded: false,
  context: '', ...overrides,
});

describe('reading references from a template', () => {
  it('finds a dotted path', () => {
    const found = readReferences('image: {{ .Values.image.tag }}\n', 'a.yaml');
    assert.deepEqual(found.map((r) => r.path), ['image.tag']);
  });

  it('finds several on one line', () => {
    const found = readReferences('image: "{{ .Values.image.repo }}:{{ .Values.image.tag }}"\n', 'a.yaml');
    assert.deepEqual(found.map((r) => r.path), ['image.repo', 'image.tag']);
  });

  it('marks a reference wrapped in required', () => {
    const found = readReferences('t: {{ required "needed" .Values.token }}\n', 'a.yaml');
    assert.equal(found[0]?.required, true);
  });

  it('marks a reference given a default', () => {
    const found = readReferences('r: {{ .Values.region | default "eu" }}\n', 'a.yaml');
    assert.equal(found[0]?.guarded, true);
  });

  it('does not credit a guard from a neighbouring action on the same line', () => {
    // `default` applies within one action. Reading the whole line would
    // suppress a real finding standing next to a guarded one.
    const found = readReferences('a: {{ .Values.x | default "1" }} b: {{ .Values.y }}\n', 'a.yaml');
    assert.equal(found.find((r) => r.path === 'y')?.guarded, false);
  });

  it('treats a value inside an if block as guarded', () => {
    const found = readReferences('{{- if .Values.ingress.enabled }}\nhost: {{ .Values.ingress.host }}\n{{- end }}\n', 'a.yaml');
    assert.equal(found.find((r) => r.path === 'ingress.host')?.guarded, true);
  });

  it('stops guarding after the block ends', () => {
    const source = '{{- if .Values.a }}\nx: {{ .Values.b }}\n{{- end }}\ny: {{ .Values.c }}\n';
    const found = readReferences(source, 'a.yaml');
    assert.equal(found.find((r) => r.path === 'c')?.guarded, false);
  });

  it('ignores a reference in a YAML comment', () => {
    // Templates are full of comments documenting the values above them.
    const found = readReferences('# .Values.image.tag is set below\ntag: {{ .Values.image.tag }}\n', 'a.yaml');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 2);
  });

  it('does not treat a hash inside an action as a comment', () => {
    const found = readReferences('a: {{ .Values.x }} # trailing note\n', 'a.yaml');
    assert.equal(found.length, 1);
  });

  it('takes the enclosing action, not the whole line', () => {
    assert.equal(enclosingExpression('a: {{ .Values.x }} b', 10), '{{ .Values.x }}');
  });

  it('knows what is inside a comment', () => {
    assert.equal(inComment('# .Values.x', 5), true);
    assert.equal(inComment('a: {{ .Values.x }}', 10), false);
    assert.equal(inComment('a: {{ .Values.x }} # note .Values.y', 30), true);
  });
});

describe('coverage between defined and referenced paths', () => {
  it('matches an exact path', () => {
    assert.equal(covers('image.tag', 'image.tag'), true);
  });

  it('lets a leaf satisfy a whole-subtree read', () => {
    // `{{ toYaml .Values.resources }}` is satisfied by resources.limits.cpu.
    assert.equal(covers('resources.limits.cpu', 'resources'), true);
  });

  it('does not let a parent satisfy a missing child', () => {
    // The bug the fixture caught: `image` existing says nothing about
    // `image.tag`, and treating it as coverage hides the commonest case.
    assert.equal(covers('image', 'image.tag'), false);
    assert.equal(covers('image.repository', 'image.tag'), false);
  });

  it('lists distinct paths in a stable order', () => {
    assert.deepEqual(distinctPaths([reference('b'), reference('a'), reference('b')]), ['a', 'b']);
  });
});

describe('reading values files', () => {
  it('records leaves and branches as dotted paths', () => {
    const found = readDefinitions('image:\n  repo: myapp\n  tag: "1"\n', 'values.yaml');
    const paths = found.map((d) => d.path);

    assert.ok(paths.includes('image'));
    assert.ok(paths.includes('image.repo'));
    assert.equal(found.find((d) => d.path === 'image')?.isBranch, true);
  });

  it('marks a null so it can be told from an absent key', () => {
    const found = readDefinitions('host: null\n', 'values.yaml');
    assert.equal(found[0]?.isNull, true);
  });

  it('records line numbers for reporting', () => {
    const found = readDefinitions('a: 1\nb: 2\n', 'values.yaml');
    assert.equal(found.find((d) => d.path === 'b')?.line, 2);
  });

  it('finds a chart on disk with its dependencies', async () => {
    const found = await findCharts(BLANK);
    assert.equal(found[0]?.name, 'blank');
    assert.deepEqual(found[0]?.dependencies, ['postgresql']);
    assert.equal(found[0]?.templates.length, 3);
  });
});

describe('finding values that render as nothing', () => {
  it('reports an undefined reference', () => {
    const found = findUnresolved([reference('image.tag')], [definition('image.repo')], chart());
    assert.equal(found.length, 1);
  });

  it('accepts one that is defined', () => {
    assert.deepEqual(findUnresolved([reference('image.tag')], [definition('image.tag')], chart()), []);
  });

  it('accepts one wrapped in required, which fails loudly instead', () => {
    assert.deepEqual(findUnresolved([reference('token', { required: true })], [], chart()), []);
  });

  it('accepts one with a default', () => {
    assert.deepEqual(findUnresolved([reference('region', { guarded: true })], [], chart()), []);
  });

  it('leaves a subchart value to the subchart', () => {
    // `.Values.postgresql.auth.password` is supplied by the dependency's own
    // defaults; reporting it would fire on every chart that has a dependency.
    const found = findUnresolved(
      [reference('postgresql.auth.password')],
      [],
      chart({ dependencies: ['postgresql'] }),
    );
    assert.deepEqual(found, []);
  });

  it('leaves .Values.global alone, which the parent chart supplies', () => {
    assert.deepEqual(findUnresolved([reference('global.imageRegistry')], [], chart()), []);
  });
});

describe('finding values nothing reads', () => {
  it('reports a key no template mentions', () => {
    const found = findUnread([reference('replicaCount')], [definition('repicaCount')], chart());
    assert.deepEqual(found.map((d) => d.path), ['repicaCount']);
  });

  it('counts a key read as part of a subtree', () => {
    const found = findUnread([reference('resources')], [definition('resources.limits.cpu')], chart());
    assert.deepEqual(found, []);
  });

  it('does not report a branch separately from its leaves', () => {
    const definitions = [definition('image', { isBranch: true }), definition('image.tag')];
    assert.deepEqual(findUnread([reference('image.tag')], definitions, chart()), []);
  });

  it('leaves subchart values alone', () => {
    const found = findUnread([], [definition('postgresql.auth.password')], chart({ dependencies: ['postgresql'] }));
    assert.deepEqual(found, []);
  });
});

describe('the checks', () => {
  it('reports unresolved references as an error', () => {
    const findings = checkUnresolved([reference('image.tag')], chart());
    assert.equal(findings[0]?.ruleId, 'value-renders-as-nothing');
    assert.equal(findings[0]?.severity, 'error');
  });

  it('recommends a schema when the chart has none', () => {
    assert.match(checkUnresolved([reference('x')], chart({ hasSchema: false }))[0]?.fix ?? '', /schema/);
    assert.doesNotMatch(checkUnresolved([reference('x')], chart({ hasSchema: true }))[0]?.fix ?? '', /schema\.json/);
  });

  it('reports a null read without a guard', () => {
    const findings = checkNullDefaults([reference('host')], [definition('host', { isNull: true })]);
    assert.equal(findings[0]?.ruleId, 'null-value-read-unguarded');
  });

  it('accepts a null that is only read with a default', () => {
    const findings = checkNullDefaults(
      [reference('host', { guarded: true })],
      [definition('host', { isNull: true })],
    );
    assert.deepEqual(findings, []);
  });

  it('reports unread values as a warning, not an error', () => {
    const findings = checkUnread([definition('repicaCount')], chart());
    assert.equal(findings[0]?.severity, 'warning', 'nothing breaks at install time');
  });

  it('reports a chart with templates and no values file', () => {
    const findings = checkNoValuesFile(chart({ valuesFiles: [] }), [reference('x')]);
    assert.equal(findings[0]?.ruleId, 'no-values-file');
  });

  it('says nothing about a chart that reads no values', () => {
    assert.deepEqual(checkNoValuesFile(chart({ valuesFiles: [] }), []), []);
  });
});

describe('the blank fixture', () => {
  it('finds every mechanism', async () => {
    const rules = ids((await analyze({ root: BLANK })).findings);
    for (const id of ['value-renders-as-nothing', 'null-value-read-unguarded', 'value-never-read']) {
      assert.ok(rules.has(id), `missing ${id}`);
    }
  });

  it('catches the missing image tag', async () => {
    const report = await analyze({ root: BLANK });
    assert.ok(report.unresolved.some((entry) => entry.path === 'image.tag'));
  });

  it('does not blame the subchart or the guarded references', async () => {
    const report = await analyze({ root: BLANK });
    const paths = new Set(report.unresolved.map((entry) => entry.path));

    assert.equal(paths.has('postgresql.auth.password'), false, 'the subchart supplies its own');
    assert.equal(paths.has('apiToken'), false, 'wrapped in required');
    assert.equal(paths.has('region'), false, 'has a default');
  });

  it('counts three of eleven references as unresolved', async () => {
    const { summary } = await analyze({ root: BLANK });
    assert.equal(summary.references, 11);
    assert.equal(summary.unresolved, 3);
  });
});

describe('the filled fixture', () => {
  it('stays completely silent', async () => {
    // A rule that fires on a chart doing everything right fires everywhere.
    const report = await analyze({ root: FILLED });
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.unresolved, 0);
  });

  it('reads the same number of values as the broken one', async () => {
    // The fixtures are the same chart, so silence is a property of the values
    // file rather than of a chart that reads less.
    const filled = await analyze({ root: FILLED });
    const blank = await analyze({ root: BLANK });
    assert.equal(filled.summary.references, blank.summary.references);
  });

  it('produces the same report twice', async () => {
    assert.equal(
      JSON.stringify(await analyze({ root: FILLED })),
      JSON.stringify(await analyze({ root: FILLED })),
    );
  });
});

describe('a directory with no chart', () => {
  it('says so rather than reporting clean', async () => {
    const report = await analyze({ root: path.join(REPO_ROOT, 'src') });
    assert.equal(report.summary.chart, null);
    assert.ok(report.warnings.some((warning) => warning.includes('no Helm chart')));
  });
});
