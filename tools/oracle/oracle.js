#!/usr/bin/env node
// Belt entry point: the same CLI as skills/ask-the-oracle/scripts/oracle.js, reachable from
// the tool directory as `node oracle.js …` (and `toolbelt run oracle -- …`).
import { main } from './skills/ask-the-oracle/scripts/oracle.js';
main();
