// Custom doctor check: is yt-dlp on PATH? Warn-only — the innertube backend needs nothing.
import { spawnSync } from 'node:child_process';
const r = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
if (r.status === 0) {
  console.log(JSON.stringify({ status: 'pass', detail: `yt-dlp ${r.stdout.trim()} on PATH (ytdlp backend available)` }));
} else {
  console.log(JSON.stringify({
    status: 'warn',
    detail: 'yt-dlp not on PATH — `node yt.mjs ytdlp …` is unavailable; fetch/search/stats/batch still work',
    fix: { description: 'Install yt-dlp (system binary, via brew)', command: 'brew install yt-dlp' },
  }));
}
