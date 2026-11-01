// RPC contract for the tariff plugin: implemented by the server part, called by the TUI part.
// Row and Settings schemas mirror ./catalog types. Methods are validated by OpenCode over
// HTTP, so every method carries explicit input/output JSON Schemas.

import { Rpc } from "@opencode/plugin/rpc"

const rowSchema = {
  type: "object",
  properties: {
    model: { type: "string" },
    provider: { type: "string" },
    blend: { type: "number" },
    est: { type: "boolean" },
    offPeak: { type: "boolean" },
    input: { type: "number" },
    cached: { type: "number" },
    output: { type: "number" },
  },
  required: ["model", "provider", "blend", "est", "offPeak", "input", "cached", "output"],
  additionalProperties: false,
}

const settingsSchema = {
  type: "object",
  properties: {
    auto: { type: "boolean" },
    title: { type: "string", enum: ["full", "short", "off"] },
    pin: { type: "string" },
    usdPerCredit: { type: "number" },
    type: { type: "string", enum: ["cheap", "full"] },
  },
  required: ["auto", "title", "pin", "usdPerCredit", "type"],
  additionalProperties: false,
}

export const Tariff = Rpc.define({
  id: "tariff",
  methods: {
    rows: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          values: { type: "array", items: rowSchema },
          providers: { type: "array", items: { type: "string" } },
        },
        required: ["values", "providers"],
        additionalProperties: false,
      },
    },
    settings: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", properties: { values: settingsSchema }, required: ["values"], additionalProperties: false },
    },
    save: {
      input: {
        type: "object",
        properties: {
          auto: { type: "boolean" },
          title: { type: "string", enum: ["full", "short", "off"] },
          pin: { type: "string" },
          usdPerCredit: { type: "number" },
          type: { type: "string", enum: ["cheap", "full"] },
        },
        additionalProperties: false,
      },
      output: { type: "object", properties: { values: settingsSchema }, required: ["values"], additionalProperties: false },
    },
    use: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, providerID: { type: "string" }, modelID: { type: "string" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, scope: { type: "string" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: { schema: { type: "object", additionalProperties: false } },
  },
})