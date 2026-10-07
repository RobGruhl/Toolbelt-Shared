# University of Washington — school deadlines on your calendar

The companion to [PERSONAL-SETUP.md](PERSONAL-SETUP.md) for a UW Seattle undergraduate. Facts
are from UW-IT's knowledge base as of 2026-10-07; the KB numbers are cited so you can check
whether they have changed.

## What works, in order

### 1. Subscribe, don't build (no code)

Add these to your **personal** Google Calendar (calendar.google.com › Other calendars › + › From
URL):

- **Canvas Calendar Feed.** In Canvas (canvas.uw.edu) open Calendar; the *Calendar Feed* link is
  at the bottom right. It carries every assignment and event in every course you are enrolled
  in. Google refreshes subscribed feeds slowly, up to about a day, so a same-day change can lag.
  The link works like a password: don't share it or paste it into a chat.
- **UW academic calendar:** `https://www.trumba.com/calendars/sea_acad-cal.ics`. It has quarter
  dates, registration and add/drop deadlines, holidays and finals.
- **Course calendars.** Some courses (often CSE) publish their own feed; the syllabus or course
  site says so.

Your class schedule has no official feed. Enter it once by hand at the start of the quarter.

### 2. Let Claude catch what the feeds miss

Club and fraternity events, office-hour changes and interviews arrive by text and email, not
Canvas. That is the texts-to-calendar flow in [PERSONAL-SETUP.md §7](PERSONAL-SETUP.md#7-texts-to-calendar),
pointed at your personal Google Calendar.

### 3. Canvas and other class sites in your own Chrome

Claude can read Canvas (canvas.uw.edu) in the Chrome you are already signed into, through
Claude in Chrome or Playwright attached to your Chrome
([PERSONAL-SETUP.md §6](PERSONAL-SETUP.md#6-a-browser-claude-can-drive)). It sees what you see:
announcements, assignment instructions, rubrics, grades, modules. Use it for what the feed
doesn't carry, such as "summarize this week's announcements" or "what does the rubric for the
essay ask for?" The same works for Gradescope, Ed and Handshake.

- You sign in; Claude never types your NetID password or answers Duo. Duo remembers a browser
  for 30 days (KB0033884).
- Read, one task at a time, while you're there. Don't have it submit work, post or message
  anyone, and don't set up an unattended job that crawls Canvas. UW blocks student API tokens to
  protect student data, and a crawler in your browser goes against the spirit of that.
- Only your own courses and records. Class rosters and other students' posts stay in Canvas.

## What doesn't work, and why

- **Canvas API tokens: students can't create them** (KB0034590). UW restricts tokens to
  non-students because they expose FERPA-protected data. Advice online that says to make one is
  out of date for UW.
- **Scripted UW sign-ins.** NetID web sign-in requires Duo two-factor (KB0033873). Anything that
  logs in by itself will break; work in a browser you are already signed into.
- **Your @uw.edu Google account with Claude's connectors: unknown.** UW Google is Workspace for
  Education, and UW treats third-party services as outside its FERPA coverage (KB0034358).
  Whether UW lets students approve outside apps on that account isn't published. Connect your
  personal Google account instead, and forward or filter the UW mail you want Claude to see.
  Your @uw.edu address forwards to UW Google or UW Outlook, whichever you chose
  (uwnetid.washington.edu/manage/?forward).

## FERPA, in one line

Your own grades and coursework are yours to read. Don't have Claude collect other students'
information from class tools, and don't share any Canvas link or token.
