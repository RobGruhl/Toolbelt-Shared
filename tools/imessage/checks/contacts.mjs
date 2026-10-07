// contacts.mjs — names for handles come from the local Contacts stores. Without them every verb
// still works on raw phone numbers and emails, so a miss is a warning, not a failure.
import { homedir } from 'node:os';
import path from 'node:path';
import { loadContacts } from '../lib/contacts.mjs';

const dir = process.env.IMSG_CONTACTS_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'AddressBook');
const c = loadContacts(dir);
if (c.stores && c.people.length) {
  console.log(JSON.stringify({ status: 'pass', detail: `${c.people.length} contacts with a phone or email across ${c.stores} Contacts store(s)` }));
} else {
  console.log(JSON.stringify({
    status: 'warn',
    detail: c.stores ? `${c.stores} Contacts store(s) found but no contact has a phone or email` : `no Contacts store readable under ${dir.replace(homedir(), '~')} — handles print as raw numbers/emails`,
    fix: { description: 'Contacts stores sit under the same Full Disk Access grant as chat.db; turn on Contacts in System Settings › Internet Accounts if names are expected' },
  }));
}
