// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { describe, expect, it } from "vitest";

import { parseIndexPath } from "../../src/validate/core/paths.js";

const GITLAB = "gitlab.example.com";

describe("parseIndexPath", () => {
  it("accepts a GitHub package path", () => {
    expect(
      parseIndexPath("index/github.com/acme/tool/metadata.json", "github", "github.com"),
    ).toEqual({
      file: "index/github.com/acme/tool/metadata.json",
      namespace: "acme",
      pkg: "tool",
    });
  });

  it("accepts nested GitLab group namespaces, package dir last", () => {
    expect(
      parseIndexPath(`index/${GITLAB}/platform/ai/tool/metadata.json`, "gitlab", GITLAB),
    ).toMatchObject({ namespace: "platform/ai", pkg: "tool" });
  });

  it("rejects nested namespaces on GitHub", () => {
    expect(
      parseIndexPath("index/github.com/platform/ai/tool/metadata.json", "github", "github.com"),
    ).toBeNull();
  });

  it("rejects paths outside the index tree", () => {
    for (const file of [
      "scripts/validate_mr.py",
      ".github/workflows/validate.yml",
      `index/${GITLAB}/tool/metadata.json`,
      `index/${GITLAB}/acme/tool/other.json`,
      "index/github.com/acme/tool/metadata.json/x",
      "index/gitlab.example.co/acme/tool/metadata.json",
      "index/github.com/acme/tool/metadata.json",
    ]) {
      expect(parseIndexPath(file, "gitlab", GITLAB), file).toBeNull();
    }
  });

  it("rejects traversal, absolute paths, and hostile segments", () => {
    for (const file of [
      "index/../../etc/passwd",
      "index/github.com/../../../etc/passwd/metadata.json",
      "index/github.com/acme/../../../../etc/metadata.json",
      "/index/github.com/acme/tool/metadata.json",
      "//index/github.com/acme/tool/metadata.json",
      "index/github.com/./acme/tool/metadata.json",
      "index/github.com//tool/metadata.json",
      "index/github.com/acme/tool/../metadata.json",
      "index\\github.com\\acme\\tool\\metadata.json",
      "index/github.com/acme/to\0ol/metadata.json",
      "index/github.com/.hidden/tool/metadata.json",
      "index/github.com/-acme/tool/metadata.json",
      "index/github.com/ac me/tool/metadata.json",
      "index/github.com/acme%2f../tool/metadata.json",
      "index/github.com/$(id)/tool/metadata.json",
    ]) {
      expect(parseIndexPath(file, "github", "github.com"), file).toBeNull();
      expect(parseIndexPath(file, "gitlab", "github.com"), file).toBeNull();
    }
  });

  it("matches the host case-insensitively", () => {
    expect(
      parseIndexPath("index/GitHub.com/acme/tool/metadata.json", "github", "github.com"),
    ).toMatchObject({ namespace: "acme" });
  });
});
