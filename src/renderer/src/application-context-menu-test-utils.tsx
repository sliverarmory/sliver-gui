import { act, render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import type { ReactNode } from "react";

import {
  APPLICATION_CONTEXT_MENU_VERSION,
  type ApplicationContextMenuAPI,
  type ApplicationContextMenuItem,
  type ApplicationContextMenuRequest,
} from "../../shared/application-context-menu-contracts";
import { ApplicationContextMenu } from "./components/ApplicationContextMenu";

const INSPECT_ACTION_ID = "10000000-0000-4000-8000-000000000001";

export interface ApplicationContextMenuTestRender extends RenderResult {
  readonly contextMenu: {
    readonly api: ApplicationContextMenuAPI;
    readonly emit: (items?: readonly ApplicationContextMenuItem[]) => void;
  };
}

export function renderWithApplicationContextMenu(children: ReactNode): ApplicationContextMenuTestRender {
  let listener: ((request: ApplicationContextMenuRequest) => void) | undefined;
  let requestOrdinal = 0;
  const api: ApplicationContextMenuAPI = {
    onMenuRequested: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
    executeAction: vi.fn(async () => true),
    setOpen: vi.fn(async () => true),
  };
  const rendered = render(
    <ApplicationContextMenu api={api}>{children}</ApplicationContextMenu>,
  );
  return Object.assign(rendered, {
    contextMenu: {
      api,
      emit: (items: readonly ApplicationContextMenuItem[] = inspectItems()) => {
        if (!listener) throw new Error("Context-menu listener was not registered");
        requestOrdinal += 1;
        act(() => listener?.({
          v: APPLICATION_CONTEXT_MENU_VERSION,
          requestId: `20000000-0000-4000-8000-${String(requestOrdinal).padStart(12, "0")}`,
          x: 40,
          y: 24,
          items,
        }));
      },
    },
  });
}

function inspectItems(): readonly ApplicationContextMenuItem[] {
  return [{
    type: "action",
    actionId: INSPECT_ACTION_ID,
    kind: "inspect",
    label: "Inspect Element",
    enabled: true,
  }];
}
