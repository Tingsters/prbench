// Never run the writer's fake gh path inside a judge, whose environment has no fake gh.
process.env.FAKE_CODEX_MODE = process.argv.includes('-o')
  ? 'nothing'
  : 'native';
await import('./fake-codex.ts');
export {};
