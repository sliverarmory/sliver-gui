import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useNavigationHistory } from "./use-navigation-history";

afterEach(cleanup);

describe("useNavigationHistory", () => {
  it("starts at the initial page and stops at both ends of history", () => {
    const { result } = renderHook(() => useNavigationHistory("overview"));

    expect(result.current).toMatchObject({
      current: "overview", canGoBack: false, canGoForward: false,
    });
    act(() => {
      result.current.goBack();
      result.current.goForward();
    });
    expect(result.current.current).toBe("overview");

    act(() => result.current.navigate("settings"));
    expect(result.current).toMatchObject({
      current: "settings", canGoBack: true, canGoForward: false,
    });
    act(() => result.current.goBack());
    expect(result.current).toMatchObject({
      current: "overview", canGoBack: false, canGoForward: true,
    });
    act(() => result.current.goBack());
    expect(result.current.current).toBe("overview");
    act(() => result.current.goForward());
    act(() => result.current.goForward());
    expect(result.current).toMatchObject({
      current: "settings", canGoBack: true, canGoForward: false,
    });
  });

  it("ignores duplicate selections without discarding forward history", () => {
    const { result } = renderHook(() => useNavigationHistory("overview"));

    act(() => {
      result.current.navigate("overview");
      result.current.navigate("settings");
      result.current.navigate("settings");
    });
    act(() => result.current.goBack());
    expect(result.current.current).toBe("overview");
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.navigate("overview"));
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.goForward());
    expect(result.current.current).toBe("settings");
    expect(result.current.canGoForward).toBe(false);
  });

  it("discards the forward branch when a different page is selected", () => {
    const { result } = renderHook(() => useNavigationHistory("overview"));

    act(() => {
      result.current.navigate("sessions");
      result.current.navigate("settings");
    });
    act(() => result.current.goBack());
    act(() => result.current.navigate("credentials"));
    expect(result.current).toMatchObject({
      current: "credentials", canGoBack: true, canGoForward: false,
    });
    act(() => result.current.goBack());
    expect(result.current.current).toBe("sessions");
    act(() => result.current.goForward());
    expect(result.current.current).toBe("credentials");
  });

  it("skips unavailable pages and adopts changes to availability", () => {
    const { result, rerender } = renderHook(
      ({ connected }) => useNavigationHistory(
        "overview",
        (entry) => connected || entry === "overview" || entry === "settings",
      ),
      { initialProps: { connected: true } },
    );

    act(() => {
      result.current.navigate("sessions");
      result.current.navigate("settings");
      result.current.navigate("credentials");
    });
    act(() => result.current.goBack());
    rerender({ connected: false });
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.goBack());
    expect(result.current).toMatchObject({
      current: "overview", canGoBack: false, canGoForward: true,
    });
    act(() => result.current.goForward());
    expect(result.current.current).toBe("settings");
    act(() => result.current.goForward());
    expect(result.current.current).toBe("settings");

    rerender({ connected: true });
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.goForward());
    expect(result.current.current).toBe("credentials");
  });

  it("keeps navigation callbacks stable when availability does not change", () => {
    const isAvailable = () => true;
    const { result } = renderHook(() => useNavigationHistory("overview", isAvailable));
    const { navigate, goBack, goForward } = result.current;

    act(() => navigate("settings"));
    expect(result.current.navigate).toBe(navigate);
    expect(result.current.goBack).toBe(goBack);
    expect(result.current.goForward).toBe(goForward);
  });
});
