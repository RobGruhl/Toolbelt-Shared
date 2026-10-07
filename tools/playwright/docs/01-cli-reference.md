# Playwright CLI Reference

Package: `@playwright/cli` (npm install -g @playwright/cli)
Binary: `playwright-cli`

## Core Commands

```bash
playwright-cli open [url]               # open browser, optionally navigate to url
playwright-cli goto <url>               # navigate to a url
playwright-cli close                    # close the page
playwright-cli type <text>              # type text into focused/editable element
playwright-cli click <ref> [button]     # click element by snapshot ref
playwright-cli dblclick <ref> [button]  # double click element
playwright-cli fill <ref> <text>        # fill text into form field by ref
playwright-cli drag <startRef> <endRef> # drag and drop between elements
playwright-cli hover <ref>              # hover over element
playwright-cli select <ref> <val>       # select dropdown option
playwright-cli upload <file>            # upload file(s)
playwright-cli check <ref>              # check checkbox/radio
playwright-cli uncheck <ref>            # uncheck checkbox
playwright-cli snapshot                 # capture accessibility tree with refs
playwright-cli eval <func> [ref]        # evaluate JS on page or element
playwright-cli dialog-accept [prompt]   # accept dialog
playwright-cli dialog-dismiss           # dismiss dialog
playwright-cli resize <w> <h>           # resize browser window
```

## Navigation

```bash
playwright-cli go-back                  # browser back
playwright-cli go-forward               # browser forward
playwright-cli reload                   # reload page
```

## Keyboard

```bash
playwright-cli press <key>              # press key (Enter, Tab, ArrowDown, etc.)
playwright-cli keydown <key>            # key down
playwright-cli keyup <key>              # key up
```

## Mouse

```bash
playwright-cli mousemove <x> <y>        # move mouse to position
playwright-cli mousedown [button]       # mouse down
playwright-cli mouseup [button]         # mouse up
playwright-cli mousewheel <dx> <dy>     # scroll wheel
```

## Save As

```bash
playwright-cli screenshot [ref]         # screenshot page or element
playwright-cli screenshot --filename=f  # screenshot with specific filename
playwright-cli pdf                      # save page as PDF
playwright-cli pdf --filename=page.pdf  # PDF with specific filename
```

## Tabs

```bash
playwright-cli tab-list                 # list all tabs
playwright-cli tab-new [url]            # new tab
playwright-cli tab-close [index]        # close tab
playwright-cli tab-select <index>       # switch to tab
```

## Storage

```bash
playwright-cli state-save [filename]    # save cookies + localStorage + sessionStorage
playwright-cli state-load <filename>    # restore storage state

playwright-cli cookie-list [--domain]   # list cookies
playwright-cli cookie-get <name>        # get cookie
playwright-cli cookie-set <name> <val>  # set cookie
playwright-cli cookie-delete <name>     # delete cookie
playwright-cli cookie-clear             # clear all cookies

playwright-cli localstorage-list        # list localStorage
playwright-cli localstorage-get <key>   # get value
playwright-cli localstorage-set <k> <v> # set value
playwright-cli localstorage-delete <k>  # delete entry
playwright-cli localstorage-clear       # clear all

playwright-cli sessionstorage-list      # list sessionStorage
playwright-cli sessionstorage-get <k>   # get value
playwright-cli sessionstorage-set <k> <v> # set value
playwright-cli sessionstorage-delete <k>  # delete entry
playwright-cli sessionstorage-clear     # clear all
```

## Network

```bash
playwright-cli route <pattern> [opts]   # mock network requests
playwright-cli route-list               # list active routes
playwright-cli unroute [pattern]        # remove route(s)
```

## DevTools

```bash
playwright-cli console [min-level]      # list console messages
playwright-cli network                  # list network requests
playwright-cli run-code <code>          # run playwright code snippet
playwright-cli tracing-start            # start trace recording
playwright-cli tracing-stop             # stop trace recording
playwright-cli video-start              # start video recording
playwright-cli video-stop [filename]    # stop video recording
```

## Open Parameters

```bash
playwright-cli open --browser=chrome    # specific browser
playwright-cli open --headed            # show browser window (default is headless)
playwright-cli open --persistent        # save profile to disk      (refused by hp: exit 2)
playwright-cli open --profile=<path>    # custom profile directory  (refused by hp: exit 2)
playwright-cli open --config=file.json  # use config file           (refused by hp: pinned to .playwright/cli.config.json)
playwright-cli open --extension         # connect via browser extension
```

## Element Refs

After each command, playwright-cli outputs a snapshot. The snapshot contains element refs (e.g. `e1`, `e2`, `e35`) that you use to target elements:

```bash
playwright-cli goto https://example.com
# Output includes snapshot with refs like e1, e2...
playwright-cli click e1                 # click element with ref e1
playwright-cli fill e5 "hello"          # fill text into element e5
```

Always `snapshot` before interacting to get current refs.
