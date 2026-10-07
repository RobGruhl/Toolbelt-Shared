// send.mjs — the one path to Messages.app: AppleScript through /usr/bin/osascript.
//
// Messages has no API for sending; AppleScript is the supported automation surface. The
// recipient and text travel as argv (`on run argv`), never spliced into the script source, so
// no message text can change what the script does. A first sentinel argument ends osascript's
// option parsing, so text that starts with "-" is passed through as text.
//
// macOS asks once, the first time, whether the calling app (Terminal, iTerm, …) may control
// Messages (System Settings › Privacy & Security › Automation). Until that is granted, sends
// fail with osascript error -1743.
import { spawnSync } from 'node:child_process';

export const SEND_SCRIPT = [
  'on run argv',
  '  set theTarget to item 2 of argv',
  '  set theText to item 3 of argv',
  '  set theKind to item 4 of argv',
  '  tell application "Messages"',
  '    if theKind is "chat" then',
  '      send theText to chat id theTarget',
  '    else',
  '      if theKind is "SMS" then',
  '        set theAccount to 1st account whose service type = SMS',
  '      else',
  '        set theAccount to 1st account whose service type = iMessage',
  '      end if',
  '      send theText to participant theTarget of theAccount',
  '    end if',
  '  end tell',
  '  return "sent"',
  'end run',
];

/** Run the send script. kind is "chat" (target = chat guid), "iMessage" or "SMS" (target = handle). */
export function osascriptSend({ target, text, kind }) {
  const r = spawnSync('/usr/bin/osascript', [...SEND_SCRIPT.flatMap((l) => ['-e', l]), 'imsg', target, text, kind], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '') };
}

/** A human hint for the osascript failures an operator actually meets. */
export function explainOsascriptError(stderr) {
  if (/-1743|Not authorized to send Apple events/i.test(stderr)) {
    return 'macOS has not allowed this terminal to control Messages. Grant it in System Settings › Privacy & Security › Automation (your terminal app › Messages), then retry.';
  }
  if (/-1728|Can.t get participant|Can.t get chat/i.test(stderr)) {
    return 'Messages could not find that recipient or chat on the chosen service. Check the handle with `imsg whois`, or try --service sms for a phone without iMessage.';
  }
  if (/-1719|Can.t get account|Can.t get 1st account/i.test(stderr)) {
    return 'Messages has no account for that service signed in. Open Messages › Settings › iMessage (or enable Text Message Forwarding on your iPhone for SMS).';
  }
  return null;
}
