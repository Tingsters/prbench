import type { CommandEvidence } from '../schema/validation.ts';

/** Observable scope audit; this is not a filesystem security boundary. */
export function hostAgentStateFindings(commands: Pick<CommandEvidence, 'id' | 'command'>[]) {
  const findings: { commandId: string; kind: 'host-agent-state' | 'host-instructions' | 'outside-case-inputs' }[] = [];
  for (const command of commands) {
    // PowerShell execution records can split a path with adjacent quote
    // fragments. Keep relative and redirected-home prefixes attached before
    // tokenizing; otherwise /path looks like an absolute host path.
    const normalized = command.command.replaceAll(String.fromCharCode(92), '/').replace(/\/+/g, '/')
      .replace(/(\.|~|\$(?:env:)?(?:CODEX_HOME|CLAUDE_CONFIG_DIR|HOME|USERPROFILE))["']+(?=\/)/gi, '$1');
    for (let token of normalized.split(/[\s"'`;(),]+/)) {
      try { token = decodeURIComponent(token); } catch { /* Keep an undecodable path conservative. */ }
      token = token.replace(/^file:\/*(?=[A-Za-z]:\/|<)/i, '').replace(/^file:\/*/i, '/');
      // createSandbox redirects these homes for every system. Literal host
      // paths remain observable even when they name the same agent folders.
      if (/^(?:<repo>|<sandbox>|~)(?:\/|$)/i.test(token) || /^\$(?:env:)?(?:CODEX_HOME|CLAUDE_CONFIG_DIR|HOME|USERPROFILE)(?:\/|$)/i.test(token)) continue;
      const absolute = /^(?:<user>(?:\/|$)|[A-Za-z]:\/|\/|~\/|\$(?:HOME|env:USERPROFILE|env:HOME)(?:\/|$))/i.test(token);
      if (!absolute) continue;
      let kind: (typeof findings)[number]['kind'] | undefined;
      if (/(?:^|\/)\.(?:agents|codex|claude)(?:\/|$)/i.test(token)) kind = 'host-agent-state';
      else if (/(?:^|\/)AGENTS\.md$/i.test(token)) kind = 'host-instructions';
      else if (/\/(?:cases-local|results)\/.*(?:facts\.json|session[^/]*\.jsonl|case\.json|original\.md)$/i.test(token)) kind = 'outside-case-inputs';
      if (kind) { findings.push({ commandId: command.id, kind }); break; }
    }
  }
  return findings;
}
