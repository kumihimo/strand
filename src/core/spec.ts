export type SpecFormat = 'checklist' | 'gwt' | 'ears' | 'repro' | 'document' | 'brief';

const DEFAULT_FORMATS: Record<string, SpecFormat> = {
  feature: 'gwt',
  bug: 'repro',
  task: 'checklist',
  chore: 'checklist',
  spike: 'checklist',
  'supplier-spec': 'ears',
  'security-review': 'ears',
  rfc: 'document',
  decision: 'document',
  'eula-review': 'brief',
  dpia: 'brief',
  deck: 'brief',
  incident: 'brief',
  retro: 'brief',
};

/** Spec format for a bead type. Accepts 'supplier spec' and 'supplier-spec' alike; unknown types get 'checklist'. */
export function defaultSpecFormat(type: string): SpecFormat {
  const key = type.trim().toLowerCase().replace(/\s+/g, '-');
  return DEFAULT_FORMATS[key] ?? 'checklist';
}

const TEMPLATES: Record<SpecFormat, string> = {
  checklist: [
    '## Intent',
    '',
    'One line: what this task achieves.',
    '',
    '## Checklist',
    '',
    '- [ ] First step',
    '- [ ] Second step',
    '',
  ].join('\n'),
  gwt: [
    'Scenario: <name the behaviour>',
    '  Given <the starting context>',
    '  When <the action taken>',
    '  Then <the observable result>',
    '',
  ].join('\n'),
  ears: [
    '# Requirements (EARS)',
    '',
    '- Ubiquitous: The <system> shall <response>.',
    '- When <trigger>, the <system> shall <response>.',
    '- While <state>, the <system> shall <response>.',
    '- If <unwanted condition>, then the <system> shall <response>.',
    '',
  ].join('\n'),
  repro: [
    '## Environment',
    '',
    '<versions, platform, config>',
    '',
    '## Steps',
    '',
    '1. <step>',
    '',
    '## Expected',
    '',
    '<what should happen>',
    '',
    '## Actual',
    '',
    '<what happens instead>',
    '',
    '## First failing test',
    '',
    '<test name and file>',
    '',
  ].join('\n'),
  document: [
    'This bead is written as a document.',
    'Use the RFC template in docs/rfc (NNNN-<slug>.md) or the ADR template in docs/adr (NNNN-<slug>.md).',
    '',
  ].join('\n'),
  brief: [
    '## Purpose',
    '',
    '<why this exists>',
    '',
    '## Audience',
    '',
    '<who reads or acts on it>',
    '',
    '## Need',
    '',
    '<what is needed from them>',
    '',
    '## Information',
    '',
    '<facts they need>',
    '',
    '## Communication',
    '',
    '<how and when it is shared>',
    '',
  ].join('\n'),
};

/** Short Markdown skeleton for a spec format. */
export function specTemplate(f: SpecFormat): string {
  return TEMPLATES[f];
}
