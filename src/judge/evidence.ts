// A compact, tool-neutral excerpt of what a case's work sessions recorded,
// for judges. Systems that read the sessions (like Tracetoon) make claims the
// diff alone can't confirm, such as "the full suite passed before the last
// edit"; without this excerpt a judge would count every such claim as
// unsupported. It is built by prbench from the raw logs, not by any system
// under test, so it can't favour one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactEvidence } from '../agents/validation.ts';
import type { CaseSession, LoadedCase } from '../schema/case.ts';

export interface EvidenceItem {
  at: string;
  kind: 'user' | 'decision' | 'command' | 'edit';
  text: string;
  /** Key lines of the command's output. */
  result?: string;
  /** Higher is kept first when the budget is tight. */
  weight: number;
}

const KEY_COMMAND = /\b(test|tests|tsc|typecheck|lint|build|bundle|prettier|eslint|pytest|cargo|go test|commit|push|merge|rebase|pr create|release|tag)\b/i;
const KEY_OUTPUT = /(pass|fail|error|✓|✗|✔|✘|exit code|tests? |\bok\b|warning|ran \d+|\d+ (passed|failed))/i;

function clip(s: string, n: number): string {
  const one = redactEvidence(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The lines of a command's output that say how it went. */
export function summarizeOutput(output: string, max = 360): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const key = lines.filter((l) => KEY_OUTPUT.test(l)).slice(-5);
  const picked = key.length ? key : lines.slice(-3);
  return clip(picked.join(' | '), max);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : typeof p?.content === 'string' ? p.content : ''))
      .join('\n');
  }
  return '';
}

function userItem(text: string, at: string): EvidenceItem | undefined {
  const trimmed = text.trim();
  const tag = '<send_user_message_question_reply>';
  if (trimmed.startsWith(tag)) {
    try {
      const replies = JSON.parse(trimmed.slice(tag.length).replace(/<\/send_user_message_question_reply>\s*$/, '').trim());
      if (Array.isArray(replies) && replies.length && replies.every(r =>
        typeof r?.question === 'string' && typeof r?.answer === 'string')) {
        return { at, kind: 'decision', weight: 3,
          text: clip(replies.map(r => `Question: ${r.question}\nAnswer: ${r.answer}`).join('\n'), 4000) };
      }
    } catch { /* A malformed wrapper is not evidence of an answer. */ }
    return;
  }
  if (trimmed && !trimmed.startsWith('<')) return { at, kind: 'user', text: clip(text, 500), weight: 3 };
}

function questionText(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return; }
  }
  const questions = (input as any)?.questions;
  if (!Array.isArray(questions) || !questions.length || !questions.every(q => typeof q?.question === 'string')) return;
  return clip(JSON.stringify(questions), 4000);
}

function answerItem(question: { at: string; text: string }, output: unknown, at: string): EvidenceItem | undefined {
  const result = textOf(output) || (output && typeof output === 'object' ? JSON.stringify(output) : '');
  if (!result.trim()) return;
  return { at: at || question.at, kind: 'decision', text: question.text, result: clip(result, 4000), weight: 3 };
}

function claudeItems(lines: Record<string, any>[]): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const pending = new Map<string, EvidenceItem>();
  const questions = new Map<string, { at: string; text: string }>();
  for (const j of lines) {
    const content = j.message?.content;
    if (j.type === 'user') {
      if (typeof content === 'string' || (Array.isArray(content) && content.every((p: any) => p?.type === 'text'))) {
        const text = textOf(content);
        const item = userItem(text, j.timestamp);
        if (item) items.push(item);
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if (p?.type !== 'tool_result') continue;
          const question = questions.get(p.tool_use_id);
          if (question) {
            const answer = answerItem(question, p.content, j.timestamp);
            if (answer) items.push(answer);
            questions.delete(p.tool_use_id);
          }
          const item = pending.get(p.tool_use_id);
          if (item) item.result = summarizeOutput(textOf(p.content));
        }
      }
    }
    if (j.type === 'assistant' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type !== 'tool_use') continue;
        if (p.name === 'AskUserQuestion') {
          const text = questionText(p.input);
          if (text && typeof p.id === 'string') questions.set(p.id, { at: j.timestamp, text });
        } else if (p.name === 'Bash' || p.name === 'PowerShell') {
          const cmd = String(p.input?.command ?? '');
          const item: EvidenceItem = { at: j.timestamp, kind: 'command', text: clip(cmd, 240), weight: KEY_COMMAND.test(cmd) ? 2 : 1 };
          items.push(item);
          pending.set(p.id, item);
        } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.name) && p.input?.file_path) {
          items.push({ at: j.timestamp, kind: 'edit', text: String(p.input.file_path), weight: 0 });
        }
      }
    }
  }
  return items;
}

function codexItems(lines: Record<string, any>[]): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const pending = new Map<string, EvidenceItem>();
  const questions = new Map<string, { at: string; text: string }>();
  for (const j of lines) {
    const p = j.payload ?? {};
    if (j.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content);
      const item = userItem(text, j.timestamp);
      if (item) items.push(item);
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const input = p.input ?? p.arguments ?? p.action?.command ?? '';
      if (/^(?:functions\.)?request_user_input(?:_async)?$/.test(String(p.name))) {
        const text = questionText(input);
        if (text && typeof p.call_id === 'string') questions.set(p.call_id, { at: j.timestamp, text });
        continue;
      }
      const raw = typeof input === 'string' ? input : JSON.stringify(input);
      if (!/exec|shell|command|apply_patch/i.test(String(p.name ?? p.type))) continue;
      const item: EvidenceItem = { at: j.timestamp, kind: 'command', text: clip(raw, 240), weight: KEY_COMMAND.test(raw) ? 2 : 1 };
      items.push(item);
      if (p.call_id) pending.set(p.call_id, item);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const question = questions.get(p.call_id);
      if (question) {
        const answer = answerItem(question, p.output, j.timestamp);
        if (answer) items.push(answer);
        questions.delete(p.call_id);
      }
      const item = pending.get(p.call_id);
      if (item) item.result = summarizeOutput(typeof p.output === 'string' ? p.output : textOf(p.output));
    }
  }
  return items;
}

export function sessionItems(text: string, agent: CaseSession['agent']): EvidenceItem[] {
  const lines: Record<string, any>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return agent === 'codex' ? codexItems(lines) : claudeItems(lines);
}

function render(item: EvidenceItem): string {
  const time = item.at ? item.at.slice(11, 16) : '--:--';
  if (item.kind === 'user') return `[${time}] USER: ${item.text}`;
  if (item.kind === 'decision') return `[${time}] RECORDED Q&A: ${item.text}${item.result ? `\n        -> ${item.result}` : ''}`;
  return `[${time}] $ ${item.text}${item.result ? `\n        -> ${item.result}` : ''}`;
}

/**
 * The excerpt for a case, within `budget` characters: requests, recorded answers and key
 * commands (tests, builds, commits) with their outcomes first, then other
 * commands, in time order; edited files are listed once at the end.
 */
export function sessionEvidence(loaded: LoadedCase, budget = 24_000): string {
  // Slices start an hour before the base commit, which mostly covers the
  // previous change; judges see the work from just before the base on.
  const since = loaded.case.repo.baseTime ? Date.parse(loaded.case.repo.baseTime) - 10 * 60_000 : -Infinity;
  const all: EvidenceItem[] = [];
  for (const s of loaded.case.sessions ?? []) {
    const items = sessionItems(readFileSync(join(loaded.dir, s.file), 'utf8'), s.agent);
    all.push(...items.filter((i) => !(Date.parse(i.at) < since)));
  }
  if (all.length === 0) return '(no recorded sessions)';
  const edits = [...new Set(all.filter((i) => i.kind === 'edit').map((i) => i.text))];
  const editLine = edits.length ? `Files edited in the sessions: ${edits.slice(0, 60).join(', ')}${edits.length > 60 ? ', …' : ''}` : '';
  const timeline = all.filter((i) => i.kind !== 'edit').map((i, index) => ({ i, index, text: `[S${index + 1}] ${render(i)}` }));
  let room = budget - editLine.length - 200;
  const keep = new Set<number>();
  for (const weight of [3, 2, 1]) {
    for (const t of timeline) {
      if (t.i.weight !== weight || keep.has(t.index)) continue;
      if (t.text.length + 1 > room) continue;
      keep.add(t.index);
      room -= t.text.length + 1;
    }
  }
  const shown = timeline.filter((t) => keep.has(t.index)).map((t) => t.text);
  const omitted = timeline.length - shown.length;
  return [...shown, ...(omitted ? [`(${omitted} less important entries omitted for length)`] : []), editLine].filter(Boolean).join('\n');
}
