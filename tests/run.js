#!/usr/bin/env -S gjs -m
//
// The headless suite: everything that can be tested without a compositor. Run it with
//
//     gjs -m tests/run.js
//
// Each suite imports only GLib/Gio, never gi://St or resource:///org/gnome/shell, so this
// is exactly the code the extension runs and not a copy of it.

import './metadata.test.js';
import './destinations.test.js';
import './launcher.test.js';
import './icon.test.js';

import { run } from './harness.js';

imports.system.exit(run());
