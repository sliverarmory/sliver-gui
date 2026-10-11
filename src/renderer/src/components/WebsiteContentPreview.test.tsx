import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WEBSITE_LIMITS, type WebsiteContentDetail } from "../../../shared/website-contracts";
import { WebsiteContentPreview } from "./WebsiteContentPreview";
import { createWebsiteContentPreview, decodeWebsiteEditableText, WEBSITE_SOURCE_DISPLAY_BYTES } from "./website-content-preview";

const encoder = new TextEncoder();

vi.mock("./WebsiteSourceEditor", () => ({
  WebsiteSourceEditor: ({ text, ariaLabel, language }: { text: string; ariaLabel: string; language: string }) => (
    <pre aria-label={ariaLabel} data-language={language}>{text}</pre>
  ),
}));

function detail(text: string | Uint8Array, overrides: Partial<WebsiteContentDetail> = {}): WebsiteContentDetail {
  const preview = typeof text === "string" ? encoder.encode(text) : text;
  return {
    item: { id: "content-1", path: "/index.html", contentType: "text/html", sizeBytes: String(preview.byteLength), sha256: "", originalFile: "" },
    preview,
    previewState: "text",
    truncated: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WebsiteContentPreview", () => {
  it.each([
    ["HTML", '<!doctype html><script>window.sliver.deleteWebsite({name:"target"});fetch("https://attacker.invalid")</script><img src="https://attacker.invalid/pixel" onerror="window.open(\'file:///etc/passwd\')"><iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><image href="https://attacker.invalid/image"/><foreignObject><iframe src="file:///etc/passwd"/></foreignObject></svg>'],
    ["links and embedded documents", '<a href="javascript:alert(1)">Click</a><a href="data:text/html,<script>alert(1)</script>">Data</a><object data="file:///etc/passwd"></object><embed src="https://attacker.invalid/test.pdf"><form action="https://attacker.invalid"><input autofocus onfocus="alert(1)"></form><meta http-equiv="refresh" content="0;url=https://attacker.invalid">'],
    ["CSS and Markdown", '<style>@import "https://attacker.invalid/style";body{background:url(file:///etc/passwd)}</style><link rel="stylesheet" href="https://attacker.invalid/style">![image](https://attacker.invalid/image) [link](javascript:alert(1))'],
  ])("passes malicious %s to the source viewer without creating active elements", (_label, source) => {
    const fetch = vi.fn();
    const deleteWebsite = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("sliver", { deleteWebsite });

    const { container } = render(<WebsiteContentPreview content={detail(source)} />);
    const preview = screen.getByLabelText("Website content source");
    expect(preview.textContent).toBe(source);
    expect(preview.children).toHaveLength(0);
    expect(container.querySelector("script, iframe, webview, img, svg, object, embed, a, form, input, style, link, meta")).toBeNull();
    fireEvent.click(preview);
    expect(fetch).not.toHaveBeenCalled();
    expect(deleteWebsite).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("selects a bundled syntax grammar from MIME or path metadata", () => {
    const { rerender } = render(<WebsiteContentPreview content={detail("<h1>Hello</h1>")} />);
    expect(screen.getByLabelText("Website content source")).toHaveAttribute("data-language", "html");
    const stylesheet = detail("body { color: red; }");
    stylesheet.item.contentType = "text/css; charset=utf-8";
    rerender(<WebsiteContentPreview content={stylesheet} />);
    expect(screen.getByLabelText("Website content source")).toHaveAttribute("data-language", "css");
  });

  it.each(["image/svg+xml", "image/png", "application/pdf", "text/markdown", "application/xhtml+xml"])("never embeds resources based on the %s MIME type", (contentType) => {
    const content = detail('<img src="https://attacker.invalid/image"><script>alert(1)</script>');
    content.item.contentType = contentType;
    const { container } = render(<WebsiteContentPreview content={content} />);
    expect(screen.getByLabelText("Website content source").children).toHaveLength(0);
    expect(container.querySelector("[src], [srcdoc], [href], [data]")).toBeNull();
  });

  it("bounds source output even if the IPC payload is larger than the preview contract", () => {
    const content = detail(`${"a".repeat(WEBSITE_LIMITS.previewBytes + 1)}HIDDEN_AFTER_LIMIT`);
    render(<WebsiteContentPreview content={content} />);
    expect(screen.getByLabelText("Website content source").textContent).toHaveLength(WEBSITE_SOURCE_DISPLAY_BYTES);
    expect(screen.getByRole("status")).toHaveTextContent("65,536 bytes");
    expect(screen.queryByText(/HIDDEN_AFTER_LIMIT/)).not.toBeInTheDocument();
  });

  it("bounds binary output and shows offsets plus printable ASCII as inert text", () => {
    const bytes = new Uint8Array(WEBSITE_LIMITS.binaryPreviewBytes + 10).fill(0xff);
    bytes.set(encoder.encode("<script>alert(1)</script>"));
    render(<WebsiteContentPreview content={detail(bytes, { previewState: "binary" })} />);
    const preview = screen.getByLabelText("Website content hex");
    expect(preview.textContent?.split("\n")).toHaveLength(256);
    expect(preview.textContent).toContain("00000ff0");
    expect(preview.textContent).not.toContain("00001000");
    expect(preview.children).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("4,096 bytes");
  });

  it.each([
    ["empty", "This file is empty."],
    ["too-large", "This file exceeds the preview size limit."],
    ["unavailable", "The server did not return content bytes"],
  ] as const)("explains %s content without embedding or decoding it", (previewState, message) => {
    render(<WebsiteContentPreview content={detail("", { previewState })} />);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.queryByLabelText("Website content source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Website content hex")).not.toBeInTheDocument();
  });

  it("fails to hex for malformed UTF-8 despite a text preview label", () => {
    render(<WebsiteContentPreview content={detail(Uint8Array.of(0xc0, 0xaf, 0xff))} />);
    expect(screen.getByLabelText("Website content hex")).toHaveTextContent("c0 af ff");
    expect(screen.queryByLabelText("Website content source")).not.toBeInTheDocument();
  });

  it("makes bidi and terminal control characters visible without changing the bytes", () => {
    const content = detail("one\u202etwo\u001b[31m\u0000\u200b\nnext\tline");
    render(<WebsiteContentPreview content={content} />);
    expect(screen.getByLabelText("Website content source").textContent).toBe("one\\u202etwo\\u001b[31m\\u0000\\u200b\nnext\tline");
    expect(decodeWebsiteEditableText(content)).toBe("one\u202etwo\u001b[31m\u0000\u200b\nnext\tline");
  });

  it("does not corrupt a multibyte character cut by the display bound", () => {
    const content = detail(`${"a".repeat(WEBSITE_SOURCE_DISPLAY_BYTES - 1)}€after`);
    const preview = createWebsiteContentPreview(content);
    expect(preview.mode).toBe("source");
    expect(preview.text).toBe("a".repeat(WEBSITE_SOURCE_DISPLAY_BYTES - 1));
    expect(preview.truncated).toBe(true);
  });

  it("does not mistake missing bytes for an empty nonempty file", () => {
    const content = detail("", { previewState: "empty" });
    content.item.sizeBytes = "99";
    render(<WebsiteContentPreview content={content} />);
    expect(screen.getByRole("status")).toHaveTextContent("The server did not return content bytes");
    expect(decodeWebsiteEditableText(content)).toBeNull();
  });
});

describe("decodeWebsiteEditableText", () => {
  it.each(["image/png", "application/pdf", "application/octet-stream"])("rejects binary MIME %s even when its bytes decode as UTF-8", (contentType) => {
    const content = detail("ASCII binary header");
    content.item.contentType = contentType;
    expect(decodeWebsiteEditableText(content)).toBeNull();
  });
  it("preserves complete UTF-8 content and its BOM for editing", () => {
    expect(decodeWebsiteEditableText(detail("\ufeff<h1>Hello, 世界</h1>\r\n"))).toBe("\ufeff<h1>Hello, 世界</h1>\r\n");
    expect(decodeWebsiteEditableText(detail("", { previewState: "empty" }))).toBe("");
  });

  it.each(["binary", "too-large", "unavailable"] as const)("rejects %s content for the text editor", (previewState) => {
    expect(decodeWebsiteEditableText(detail("not complete text", { previewState }))).toBeNull();
  });

  it("rejects invalid UTF-8, oversized data, truncated previews, and size mismatches", () => {
    expect(decodeWebsiteEditableText(detail(Uint8Array.of(0xff)))).toBeNull();
    expect(decodeWebsiteEditableText(detail("a".repeat(WEBSITE_LIMITS.previewBytes + 1)))).toBeNull();
    expect(decodeWebsiteEditableText(detail("prefix", { truncated: true }))).toBeNull();
    const content = detail("prefix");
    content.item.sizeBytes = "100";
    expect(decodeWebsiteEditableText(content)).toBeNull();
  });
});
