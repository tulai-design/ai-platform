#!/usr/bin/env node
// tsc only writes: it never removes output for a source file that was deleted
// or renamed. That stale output is then picked up by `files: ["dist"]` and
// shipped. Remove the output directory before every build so the artifact can
// only contain modules the current source produces.
import {rmSync} from 'node:fs';
import {join} from 'node:path';

const dist = join(process.cwd(), 'dist');
rmSync(dist, {recursive: true, force: true});
