import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyze } from '../src/analyze.ts';
import { parseArgs } from '../src/cli.ts';
import { renderJson } from '../src/report/json.ts';
import { renderTerminal } from '../src/report/terminal.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLANK = path.join(REPO_ROOT, 'examples', 'blank');
const FILLED = path.join(REPO_ROOT, 'examples', 'filled');

/**
 * Run the CLI as a real process.
 *
 * Capturing output by replacing `process.stdout.write` corrupts the test
 * runner's own output, which writes to the same stream. Spawning tests what
 * users actually run, exit code included.
 */
function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(REPO_ROOT, 'src', 'cli.ts'), ...argv],
      { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

function captureStream(): NodeJS.WriteStream {
  return { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
}

describe('argument parsing', () => {
  it('defaults to the working directory', () => {
    assert.equal((parseArgs([]) as { root: string }).root, '.');
  });

  it('collects repeated values files', () => {
    const options = parseArgs(['chart', '--values', 'prod.yaml', '--values=eu.yaml']) as
      { root: string; values: string[] };
    assert.equal(options.root, 'chart');
    assert.deepEqual(options.values, ['prod.yaml', 'eu.yaml']);
  });

  it('accepts a threshold with a space or an equals sign', () => {
    assert.equal((parseArgs(['--fail-on', 'warning']) as { failOn: string }).failOn, 'warning');
    assert.equal((parseArgs(['--fail-on=info']) as { failOn: string }).failOn, 'info');
  });

  it('returns help and version first', () => {
    assert.equal(parseArgs(['--help']), 'help');
    assert.equal(parseArgs(['-v']), 'version');
  });

  it('rejects unknown options, missing values and a second path', () => {
    assert.throws(() => parseArgs(['--nope']));
    assert.throws(() => parseArgs(['--fail-on', 'fatal']));
    assert.throws(() => parseArgs(['--values']));
    assert.throws(() => parseArgs(['a', 'b']));
  });
});

describe('reporters', () => {
  it('emits JSON that declares its schema and the counts', async () => {
    const payload = JSON.parse(renderJson(await analyze({ root: BLANK })));
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.tool.name, 'novalue');
    assert.equal(payload.summary.references, 17);
    assert.equal(payload.summary.unresolved, 6);
  });

  it('lists the unresolved references with their location', async () => {
    const payload = JSON.parse(renderJson(await analyze({ root: BLANK })));
    const tag = payload.unresolved.find((entry: { path: string }) => entry.path === 'image.tag');

    assert.notEqual(tag, undefined);
    assert.match(tag.file, /deployment\.yaml$/);
  });

  it('writes plain text when the stream is not a terminal', async () => {
    const text = renderTerminal(await analyze({ root: BLANK }), captureStream());
    assert.ok(!text.includes(String.fromCharCode(27)), 'expected no ANSI escapes');
    assert.match(text, /value-renders-as-nothing/);
  });

  it('names the template and the line', async () => {
    const text = renderTerminal(await analyze({ root: BLANK }), captureStream());
    assert.match(text, /templates\/deployment\.yaml:\d+/);
  });

  it('states plainly when every value is defined', async () => {
    const text = renderTerminal(await analyze({ root: FILLED }), captureStream());
    assert.match(text, /Every value the templates read is defined/);
  });

  it('lists every unresolved value under --verbose', async () => {
    const text = renderTerminal(await analyze({ root: BLANK }), captureStream(), { verbose: true });
    assert.match(text, /Values that will render as nothing/);
    assert.match(text, /\.Values\.image\.tag/);
  });

  it('strips escape sequences that arrive from a scanned repository', async () => {
    // Value paths and template lines are text this tool did not write. Printed
    // raw they could repaint the report and forge a clean verdict.
    const base = await analyze({ root: BLANK });
    const escape = String.fromCharCode(27);
    const hostile = {
      ...base,
      findings: [{
        ...base.findings[0]!,
        title: `image.tag${escape}[2K${escape}[1A all defined`,
        fix: `set ${escape}[31mthis${escape}[0m`,
        evidence: [{ text: `path: ${escape}[6nimage.tag` }],
      }],
    };

    const text = renderTerminal(hostile, captureStream());
    assert.ok(!text.includes(escape), 'an escape byte survived into the report');
    assert.match(text, /all defined/, 'the surrounding text should still be shown');
  });
});

describe('the command line, end to end', () => {
  it('prints the version and the help', async () => {
    const version = await run(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /novalue/);
    assert.match(help.stdout, /renders a missing value as the empty string/);
  });

  it('exits 2 on bad usage', async () => {
    const { code, stderr } = await run(['--nope']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown option/);
  });

  it('exits 1 on the blank fixture and counts the unresolved values', async () => {
    const { code, stdout, stderr } = await run([BLANK]);
    assert.equal(code, 1);
    assert.match(stdout, /17 values read/);
    assert.match(stderr, /defined nowhere/);
  });

  it('exits 0 on the filled fixture, at every threshold', async () => {
    assert.equal((await run([FILLED])).code, 0);
    assert.equal((await run([FILLED, '--fail-on', 'info'])).code, 0);
  });

  it('exits 0 where there is no chart', async () => {
    const { code } = await run([path.join(REPO_ROOT, 'src')]);
    assert.equal(code, 0);
  });

  it('accepts an extra values file, as supplied at install', async () => {
    // A key missing from values.yaml but present in the file you install with
    // is not a defect.
    const { stdout } = await run([BLANK, '--values', 'values.yaml', '--json']);
    assert.equal(JSON.parse(stdout).summary.unresolved, 6);
  });

  it('keeps JSON on stdout clean while the verdict goes to stderr', async () => {
    const { code, stdout, stderr } = await run([BLANK, '--json']);
    assert.equal(code, 1);
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.match(stderr, /defined nowhere/);
  });
});
