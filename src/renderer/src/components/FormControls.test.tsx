import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { faApple, faLinux, faWindows } from "@fortawesome/free-brands-svg-icons";
import { faDice, faListOl } from "@fortawesome/free-solid-svg-icons";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useState } from "react";

import { SelectField, SwitchRow } from "./FormControls";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("SelectField iconography", () => {
  it("renders the selected OS brand and the icons for every OS option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectField
        label="Operating system"
        value="windows"
        onChange={onChange}
        options={[
          { value: "windows", label: "Windows", icon: faWindows },
          { value: "darwin", label: "macOS", icon: faApple },
          { value: "linux", label: "Linux", icon: faLinux },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Operating system/i });
    expect(trigger.querySelector('svg[data-icon="windows"]')).toBeInTheDocument();

    await user.click(trigger);

    expect(within(screen.getByRole("option", { name: "Windows" })).getByText("Windows"))
      .toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Windows" }).querySelector('svg[data-icon="windows"]'))
      .toBeInTheDocument();
    expect(screen.getByRole("option", { name: "macOS" }).querySelector('svg[data-icon="apple"]'))
      .toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Linux" }).querySelector('svg[data-icon="linux"]'))
      .toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "macOS" }));
    expect(onChange).toHaveBeenCalledWith("darwin");
  });

  it("preserves the empty connection-strategy value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectField
        label="Connection strategy"
        value="r"
        onChange={onChange}
        options={[
          { value: "", label: "Sequential", icon: faListOl },
          { value: "r", label: "Random", icon: faDice },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Connection strategy/i });
    expect(trigger.querySelector('svg[data-icon="dice"]')).toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Sequential" }));

    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("SwitchRow settings layout", () => {
  it("keeps the copy first, the control last, and toggles from the full row", async () => {
    const user = userEvent.setup();

    function ControlledSwitchRow() {
      const [selected, setSelected] = useState(false);
      return (
        <SwitchRow
          description="Enable target-specific defensive evasion at compile time."
          label="Evasion"
          selected={selected}
          onChange={setSelected}
        />
      );
    }

    render(<ControlledSwitchRow />);

    const toggle = screen.getByRole("switch", { name: "Evasion" });
    const trigger = toggle.closest(".cell-switch")?.querySelector('[data-slot="cell-switch-trigger"]');
    const copy = screen.getByText("Evasion").parentElement;
    const description = screen.getByText(
      "Enable target-specific defensive evasion at compile time.",
    );
    const control = trigger?.querySelector('[data-slot="cell-switch-control"]');

    expect(trigger).not.toBeNull();
    if (!(trigger instanceof HTMLElement)) throw new Error("CellSwitch trigger is missing");
    expect(trigger).toContainElement(copy);
    expect(copy).toContainElement(description);
    expect(copy?.nextElementSibling).toBe(control);
    expect(trigger?.lastElementChild).toBe(control);
    expect(toggle).not.toBeChecked();

    await user.click(trigger);
    expect(toggle).toBeChecked();
  });

  it("preserves the disabled state for unavailable configuration options", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <SwitchRow
        disabled
        description="Invoke shared-library entry behavior when the module loads."
        label="Run at load"
        selected
        onChange={onChange}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Run at load" });
    expect(toggle).toBeDisabled();
    await user.click(screen.getByText("Run at load"));
    expect(toggle).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });
});
