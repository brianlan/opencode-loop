import { expect, test } from "bun:test"
import * as plugin from "../src/index"

test("plugin entry exports only the default plugin function", () => {
  expect(Object.keys(plugin)).toEqual(["default"])
  expect(typeof plugin.default).toBe("function")
})
