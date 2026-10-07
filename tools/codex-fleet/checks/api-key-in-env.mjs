// api-key-in-env.mjs — OPENAI_API_KEY in the process environment is what the wrapper strips
// per worker so plan billing stays the default. Its presence is not wrong, but it is the one
// fact that decides whether a bare `codex exec` outside the wrapper silently meters.
const present = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim() !== ''; // pragma: allowlist secret
console.log(JSON.stringify(present
  ? { status: 'warn', detail: 'OPENAI_API_KEY is exported machine-wide: codex-fleet strips it per worker (plan billing); a bare `codex exec` outside the wrapper meters against it' }
  : { status: 'pass', detail: 'no OPENAI_API_KEY in the environment; --api has nothing to bill and plan billing is the only path' }));
