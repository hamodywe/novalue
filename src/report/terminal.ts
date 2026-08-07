/**
 * The report.
 *
 * The headline is the ratio that matters: how much of what the templates read
 * actually exists.
 */

import { bar, createStyler, padEnd, type StyleName, type Styler } from './style.ts';
import type { Finding, Report, Severity } from '../types.ts';

export interface TerminalOptions {
  /** List every value that will render as nothing. */
  readonly verbose?: boolean;
}

const BAR_WIDTH = 30;
const MAX_EVIDENCE = 10;
const MAX_TEXT = 300;

const SEVERITY_COLOUR: Readonly<Record<Severity, StyleName>> = {
  error: 'red',
  warning: 'yellow',
  info: 'grey',
};

/**
 * Make a string safe to print.
 *
 * Value paths and template lines come from a repository this tool did
 * not write. One containing an escape sequence could otherwise repaint the
 * report and forge a clean verdict, which is the failure this tool exists to
 * catch.
 */
function plain(text: string): string {
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
  return stripped.length > MAX_TEXT ? `${stripped.slice(0, MAX_TEXT - 1)}…` : stripped;
}

export function renderTerminal(
  report: Report,
  stream: NodeJS.WriteStream,
  options: TerminalOptions = {},
): string {
  const style = createStyler(stream);
  const lines: string[] = [];

  for (const warning of report.warnings) lines.push(`${style('yellow', 'note')} ${plain(warning)}`);
  if (report.warnings.length > 0) lines.push('');

  if (report.summary.chart === null) return lines.join('\n');

  lines.push(...renderHeadline(report, style));
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(style('green', 'Every value the templates read is defined.'));
    lines.push('');
  } else {
    for (const finding of report.findings) lines.push(...renderFinding(finding, style));
  }

  if (options.verbose === true) lines.push(...renderUnresolved(report, style));

  return lines.join('\n');
}

function renderHeadline(report: Report, style: Styler): string[] {
  const { chart, references, defined, unresolved, unread, templateCount } = report.summary;
  const resolved = references - unresolved;

  const head = unresolved === 0
    ? `${style('bold', `${references} value${references === 1 ? '' : 's'} read`)} · ${style('green', 'all defined')}`
    : `${style('bold', `${references} value${references === 1 ? '' : 's'} read`)} · ${resolved} defined · ${style('red', `${unresolved} render as nothing`)}`;

  const ratio = references === 0 ? 1 : resolved / references;

  return [
    head,
    `  ${style(ratio === 1 ? 'green' : ratio < 0.5 ? 'red' : 'yellow', bar(ratio, BAR_WIDTH))} ${style('dim', `${Math.round(ratio * 100)}% of what the templates read exists`)}`,
    '',
    `  ${style('grey', `${chart ?? 'chart'} · ${templateCount} template${templateCount === 1 ? '' : 's'} · ${defined} key${defined === 1 ? '' : 's'} defined · ${unread} never read`)}`,
  ];
}
function renderFinding(finding: Finding, style: Styler): string[] {
  const colour = SEVERITY_COLOUR[finding.severity];
  const lines: string[] = [];

  lines.push(
    `${style(colour, padEnd(finding.severity, 7))} ${style('bold', finding.ruleId)} ${style('dim', `${finding.file}:${finding.line}`)}`,
  );
  lines.push(`  ${plain(finding.title)}`);
  lines.push(`  ${style('grey', `so: ${finding.consequence}`)}`);
  lines.push(`  ${style('cyan', `fix: ${plain(finding.fix)}`)}`);

  for (const evidence of finding.evidence.slice(0, MAX_EVIDENCE)) {
    const where = evidence.file === undefined || evidence.line === undefined
      ? ''
      : style('dim', `${plain(evidence.file)}:${evidence.line} — `);
    lines.push(`    ${where}${plain(evidence.text)}`);
  }

  if (finding.evidence.length > MAX_EVIDENCE) {
    lines.push(style('dim', `    … and ${finding.evidence.length - MAX_EVIDENCE} more`));
  }

  lines.push('');
  return lines;
}

function renderUnresolved(report: Report, style: Styler): string[] {
  if (report.unresolved.length === 0) return [];

  const lines = [style('bold', 'Values that will render as nothing'), ''];

  for (const reference of report.unresolved) {
    lines.push(`  ${padEnd(plain(`.Values.${reference.path}`), 40)} ${style('dim', `${plain(reference.file)}:${reference.line}`)}`);
  }

  lines.push('');
  return lines;
}