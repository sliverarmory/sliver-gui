// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  APPLICATION_CONTEXT_MENU_IPC,
  APPLICATION_CONTEXT_MENU_MAX_COORDINATE,
  APPLICATION_CONTEXT_MENU_MAX_ITEMS,
  APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH,
  APPLICATION_CONTEXT_MENU_VERSION,
  parseApplicationContextMenuActionRequest,
  parseApplicationContextMenuRequest,
  parseApplicationContextMenuVisibilityRequest,
  type ApplicationContextMenuAPI,
  type ApplicationContextMenuRequest,
  type ApplicationContextMenuVisibilityRequest,
} from "./application-context-menu-contracts.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const COPY_ACTION_ID = "00000000-0000-4000-8000-000000000002";
const INSPECT_ACTION_ID = "00000000-0000-4000-8000-000000000003";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: APPLICATION_CONTEXT_MENU_VERSION,
    requestId: REQUEST_ID,
    x: 12,
    y: 34,
    items: [
      {
        type: "action",
        actionId: COPY_ACTION_ID,
        kind: "copy",
        label: "Copy",
        enabled: true,
        shortcut: "mod+c",
      },
      { type: "separator" },
      {
        type: "action",
        actionId: INSPECT_ACTION_ID,
        kind: "inspect",
        label: "Inspect Element",
        enabled: true,
        variant: "default",
      },
    ],
    ...overrides,
  };
}

describe("application context menu contracts", () => {
  it("uses four isolated fixed channels", () => {
    expect(APPLICATION_CONTEXT_MENU_IPC).toEqual({
      menuRequested: "sliver:application-context-menu:requested",
      executeAction: "sliver:application-context-menu:execute-action",
      setOpen: "sliver:application-context-menu:set-open",
      restrictedTarget: "sliver:application-context-menu:restricted-target",
    });
    expect(Object.isFrozen(APPLICATION_CONTEXT_MENU_IPC)).toBe(true);
  });

  it("strictly parses and deeply freezes a versioned request model", () => {
    const parsed = parseApplicationContextMenuRequest(request());

    expect(parsed).toEqual(request());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(parsed.items.every(Object.isFrozen)).toBe(true);
    expectTypeOf(parsed).toMatchTypeOf<ApplicationContextMenuRequest>();
  });

  it("strictly parses and freezes the payload-free capability action request", () => {
    const parsed = parseApplicationContextMenuActionRequest({
      requestId: REQUEST_ID,
      actionId: COPY_ACTION_ID,
    });

    expect(parsed).toEqual({ requestId: REQUEST_ID, actionId: COPY_ACTION_ID });
    expect(Object.isFrozen(parsed)).toBe(true);
    expectTypeOf<ApplicationContextMenuAPI["executeAction"]>()
      .returns.toEqualTypeOf<Promise<boolean>>();
  });

  it("strictly parses and freezes a menu visibility request", () => {
    const parsed = parseApplicationContextMenuVisibilityRequest({
      requestId: REQUEST_ID,
      open: true,
    });

    expect(parsed).toEqual({ requestId: REQUEST_ID, open: true });
    expect(Object.isFrozen(parsed)).toBe(true);
    expectTypeOf(parsed).toMatchTypeOf<ApplicationContextMenuVisibilityRequest>();
    expectTypeOf<ApplicationContextMenuAPI["setOpen"]>()
      .returns.toEqualTypeOf<Promise<boolean>>();
  });

  it.each([
    null,
    [],
    request({ v: 2 }),
    request({ requestId: "copy" }),
    request({ x: -1 }),
    request({ x: 1.5 }),
    request({ y: APPLICATION_CONTEXT_MENU_MAX_COORDINATE + 1 }),
    request({ items: [] }),
    request({ items: Array.from({ length: APPLICATION_CONTEXT_MENU_MAX_ITEMS + 1 }, () => ({
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "Copy",
      enabled: true,
    })) }),
    { ...request(), unexpected: true },
  ])("rejects an invalid request envelope %#", (value) => {
    expect(() => parseApplicationContextMenuRequest(value)).toThrow(
      "Invalid application context menu request",
    );
  });

  it.each([
    [{ type: "separator" }, request()["items"]],
    [
      {
        type: "action",
        actionId: COPY_ACTION_ID,
        kind: "copy",
        label: "Copy",
        enabled: true,
      },
      { type: "separator" },
      { type: "separator" },
      {
        type: "action",
        actionId: INSPECT_ACTION_ID,
        kind: "inspect",
        label: "Inspect Element",
        enabled: true,
      },
    ],
    [
      {
        type: "action",
        actionId: COPY_ACTION_ID,
        kind: "copy",
        label: "Copy",
        enabled: true,
      },
      { type: "separator" },
    ],
    [
      {
        type: "action",
        actionId: COPY_ACTION_ID,
        kind: "copy",
        label: "Copy",
        enabled: true,
      },
      {
        type: "action",
        actionId: COPY_ACTION_ID,
        kind: "inspect",
        label: "Inspect Element",
        enabled: true,
      },
    ],
  ])("rejects malformed grouping or duplicate capabilities %#", (...items) => {
    const flattened = items.flat() as unknown[];
    expect(() => parseApplicationContextMenuRequest(request({ items: flattened }))).toThrow(
      "Invalid application context menu request",
    );
  });

  it.each([
    { type: "heading", label: "Editing" },
    { type: "separator", extra: true },
    { type: "action", actionId: COPY_ACTION_ID, kind: "print", label: "Print", enabled: true },
    { type: "action", actionId: COPY_ACTION_ID, kind: "copy", label: "", enabled: true },
    {
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "x".repeat(APPLICATION_CONTEXT_MENU_MAX_LABEL_LENGTH + 1),
      enabled: true,
    },
    { type: "action", actionId: COPY_ACTION_ID, kind: "copy", label: "Copy\nnow", enabled: true },
    { type: "action", actionId: COPY_ACTION_ID, kind: "copy", label: "Copy", enabled: 1 },
    { type: "action", actionId: "copy", kind: "copy", label: "Copy", enabled: true },
    {
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "Copy",
      enabled: true,
      shortcut: "ctrl+c",
    },
    {
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "Copy",
      enabled: true,
      variant: "primary",
    },
    {
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "Copy",
      enabled: true,
      data: "clipboard payload",
    },
  ])("rejects an invalid or over-broad item %#", (item) => {
    expect(() => parseApplicationContextMenuRequest(request({ items: [item] }))).toThrow(
      "Invalid application context menu request",
    );
  });

  it.each([
    null,
    [],
    {},
    { requestId: REQUEST_ID },
    { requestId: REQUEST_ID, actionId: "copy" },
    { requestId: "not-a-capability", actionId: COPY_ACTION_ID },
    { requestId: REQUEST_ID, actionId: COPY_ACTION_ID, text: "secret" },
    { requestId: REQUEST_ID, actionId: COPY_ACTION_ID, url: "https://example.test" },
    { requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", actionId: COPY_ACTION_ID },
  ])("rejects malformed or payload-bearing action input %#", (value) => {
    expect(() => parseApplicationContextMenuActionRequest(value)).toThrow(
      "Invalid application context menu action request",
    );
  });

  it.each([
    null,
    [],
    {},
    { requestId: REQUEST_ID },
    { requestId: "not-a-capability", open: true },
    { requestId: REQUEST_ID, open: 1 },
    { requestId: REQUEST_ID, open: true, actionId: COPY_ACTION_ID },
  ])("rejects malformed or over-broad visibility input %#", (value) => {
    expect(() => parseApplicationContextMenuVisibilityRequest(value)).toThrow(
      "Invalid application context menu visibility request",
    );
  });
});
