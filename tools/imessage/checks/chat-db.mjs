// chat-db.mjs — this terminal can open the Messages database read-only.
// macOS guards ~/Library/Messages behind Full Disk Access, granted per app (Terminal, iTerm, …);
// the count is the proof, not the file's presence.
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = process.env.IMSG_CHAT_DB ?? path.join(homedir(), 'Library', 'Messages', 'chat.db');
try {
  const db = new DatabaseSync(file, { readOnly: true, readBigInts: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM message').get().n;
  const c = db.prepare('SELECT COUNT(*) AS n FROM chat').get().n;
  db.close();
  console.log(JSON.stringify({ status: 'pass', detail: `chat.db readable: ${n} messages in ${c} chats` }));
} catch (e) {
  console.log(JSON.stringify({
    status: 'fail',
    detail: `cannot read ${file.replace(homedir(), '~')}: ${e.message}`,
    fix: { description: 'Grant Full Disk Access to the terminal app you run the belt from (System Settings › Privacy & Security › Full Disk Access), then restart that terminal', command: 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"' },
  }));
}
