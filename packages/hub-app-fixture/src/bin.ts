#!/usr/bin/env node
/** `hub-app-fixture [--socket <path>] [--port <n>]`; `HUB_APP_FIXTURE_MODE` picks the knob (default `ok`). */
import { runApp } from "@knpkv/hub-app/node"
import { Layer, Schema } from "effect"
import process from "node:process"
import { fixtureApp, FixtureMode } from "./index.js"

runApp(fixtureApp(Schema.decodeUnknownSync(FixtureMode)(process.env.HUB_APP_FIXTURE_MODE ?? "ok")), Layer.empty)
