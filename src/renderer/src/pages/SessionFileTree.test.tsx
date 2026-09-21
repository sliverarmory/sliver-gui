import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionFileEntry } from "../../../shared/session-contracts";
import { SessionFileTree } from "./SessionFileTree";

afterEach(cleanup);

function directory(name: string, path: string): SessionFileEntry {
  return { name, path, isDirectory: true, sizeBytes: "0", mode: "drwxr-xr-x" };
}

describe("SessionFileTree", () => {
  it("shows expanded ancestry and loaded folders, and navigates only when a different folder is selected", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const breadcrumbs = [{ label: "/", path: "/" }, { label: "work", path: "/work" }];
    render(<SessionFileTree
      breadcrumbs={breadcrumbs}
      isDisabled={false}
      path="/work"
      snapshots={[{
        path: "/work",
        breadcrumbs,
        directories: [
          directory("projects", "/work/projects"),
          { ...directory("notes.txt", "/work/notes.txt"), isDirectory: false },
        ],
      }]}
      windows={false}
      onNavigate={onNavigate}
    />);

    const tree = screen.getByRole("treegrid", { name: "Remote folders" });
    expect(within(tree).getByRole("row", { name: "work" })).toHaveAttribute("aria-selected", "true");
    expect(within(tree).getByText("projects")).toBeVisible();
    expect(within(tree).queryByText("notes.txt")).not.toBeInTheDocument();
    await user.click(within(tree).getByText("work"));
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(within(tree).getByText("projects"));
    expect(onNavigate).toHaveBeenLastCalledWith("/work/projects");
    await user.click(within(tree).getByText("/", { exact: true }));
    expect(onNavigate).toHaveBeenLastCalledWith("/");
  });

  it("preserves Windows share paths and disables folder navigation until the parent is ready", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const share = "\\\\SERVER\\Share";
    const child = `${share}\\Mixed Case`;
    const breadcrumbs = [{ label: share, path: share }];
    const props = {
      breadcrumbs,
      path: share,
      snapshots: [{ path: share, breadcrumbs, directories: [directory("Mixed Case", child)] }],
      windows: true,
      onNavigate,
    };
    const { rerender } = render(<SessionFileTree {...props} isDisabled />);
    const tree = screen.getByRole("treegrid", { name: "Remote folders" });
    expect(within(tree).getByRole("row", { name: "Mixed Case" })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(tree).getByText("Mixed Case"));
    expect(onNavigate).not.toHaveBeenCalled();

    rerender(<SessionFileTree {...props} isDisabled={false} />);
    await user.click(within(tree).getByText("Mixed Case"));
    expect(onNavigate).toHaveBeenCalledWith(child);
  });

  it.each([
    {
      path: "/opt/",
      breadcrumbs: [{ label: "/", path: "/" }, { label: "opt", path: "/opt" }],
      label: "opt",
      child: "/opt/child",
      windows: false,
    },
    {
      path: "C:/Windows/",
      breadcrumbs: [{ label: "C:\\", path: "C:\\" }, { label: "Windows", path: "C:\\Windows" }],
      label: "Windows",
      child: "C:/Windows/child",
      windows: true,
    },
    {
      path: "\\\\SERVER\\Share\\",
      breadcrumbs: [{ label: "\\\\SERVER\\Share", path: "\\\\SERVER\\Share" }],
      label: "\\\\SERVER\\Share",
      child: "\\\\SERVER\\Share\\child",
      windows: true,
    },
  ])("selects the current folder and shows children when $path differs from its formatted breadcrumb", async ({ path, breadcrumbs, label, child, windows }) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<SessionFileTree
      breadcrumbs={breadcrumbs}
      isDisabled={false}
      path={path}
      snapshots={[{ path, breadcrumbs, directories: [directory("child", child)] }]}
      windows={windows}
      onNavigate={onNavigate}
    />);

    const tree = screen.getByRole("treegrid", { name: "Remote folders" });
    expect(within(tree).getByRole("row", { name: label })).toHaveAttribute("aria-selected", "true");
    await user.click(within(tree).getByText(label));
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(within(tree).getByText("child"));
    expect(onNavigate).toHaveBeenCalledWith(child);
  });

  it("preserves collapsed folders on data refresh and expands the ancestry of a newly selected path", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const breadcrumbs = [{ label: "/", path: "/" }, { label: "work", path: "/work" }];
    const { rerender } = render(<SessionFileTree
      breadcrumbs={breadcrumbs}
      isDisabled={false}
      path="/work"
      snapshots={[{
        path: "/work",
        breadcrumbs,
        directories: [directory("projects", "/work/projects")],
      }]}
      windows={false}
      onNavigate={onNavigate}
    />);
    const tree = screen.getByRole("treegrid", { name: "Remote folders" });
    const workRow = within(tree).getByRole("row", { name: "work" });
    await user.click(within(workRow).getByRole("button"));
    expect(workRow).toHaveAttribute("aria-expanded", "false");

    rerender(<SessionFileTree
      breadcrumbs={breadcrumbs.map((crumb) => ({ ...crumb }))}
      isDisabled={false}
      path="/work"
      snapshots={[{
        path: "/work",
        breadcrumbs,
        directories: [directory("projects", "/work/projects"), directory("new-folder", "/work/new-folder")],
      }]}
      windows={false}
      onNavigate={onNavigate}
    />);
    expect(within(tree).getByRole("row", { name: "work" })).toHaveAttribute("aria-expanded", "false");

    rerender(<SessionFileTree
      breadcrumbs={[...breadcrumbs, { label: "projects", path: "/work/projects" }]}
      isDisabled={false}
      path="/work/projects"
      snapshots={[
        {
          path: "/work",
          breadcrumbs,
          directories: [directory("projects", "/work/projects"), directory("new-folder", "/work/new-folder")],
        },
        {
          path: "/work/projects",
          breadcrumbs: [...breadcrumbs, { label: "projects", path: "/work/projects" }],
          directories: [directory("src", "/work/projects/src")],
        },
      ]}
      windows={false}
      onNavigate={onNavigate}
    />);
    expect(within(tree).getByRole("row", { name: "work" })).toHaveAttribute("aria-expanded", "true");
    expect(within(tree).getByRole("row", { name: "projects" })).toHaveAttribute("aria-selected", "true");
    expect(within(tree).getByText("src")).toBeVisible();
    expect(within(tree).getByText("new-folder")).toBeVisible();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
