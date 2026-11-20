import { describe, expect, it } from "vitest";
import { APPLICATION_LANGUAGES } from "../../../shared/application-settings-contracts";
import { formatMessage, messagesForLanguage } from "./messages";

function messageShape(catalog: object): unknown {
  return Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, value]) => {
    if (typeof value === "string") {
      expect(value.trim(), key).not.toBe("");
      return [key, [...value.matchAll(/\{[a-zA-Z]+\}/gu)].map(([match]) => match).sort()];
    }
    return [key, messageShape(value as object)];
  });
}

describe("application message catalogs", () => {
  it.each(APPLICATION_LANGUAGES)("preserves keys and named values in $label", ({ id }) => {
    expect(messageShape(messagesForLanguage(id))).toEqual(messageShape(messagesForLanguage("en")));
  });

  it("uses the English catalog for an unrecognized language", () => {
    expect(messagesForLanguage("unsupported")).toBe(messagesForLanguage("en"));
  });

  it("substitutes only named values in the template", () => {
    expect(formatMessage("{operator} is connected", { operator: "host-{other}", other: "replaced" }))
      .toBe("host-{other} is connected");
  });
});
