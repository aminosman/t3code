import { describe, expect, it } from "vite-plus/test";

import {
  layoutProjectSections,
  projectSectionDropId,
  resolveProjectDropSection,
  UNSECTIONED_DROP_ID,
} from "./LegacySidebar.sections";

const project = (projectKey: string, ...members: string[]) => ({
  projectKey,
  memberProjects: (members.length > 0 ? members : [projectKey]).map((physicalProjectKey) => ({
    physicalProjectKey,
  })),
});

const sections = [
  { id: "work", name: "Work", collapsed: false },
  { id: "home", name: "Home", collapsed: true },
];

describe("layoutProjectSections", () => {
  it("splits the sorted list by section and keeps its order", () => {
    const projects = [project("a"), project("b"), project("c"), project("d")];
    const layout = layoutProjectSections(projects, sections, { b: "home", c: "work", a: "work" });
    expect(layout.unsectioned.map((p) => p.projectKey)).toEqual(["d"]);
    expect(
      layout.sections.map(({ section, projects }) => [
        section.id,
        projects.map((p) => p.projectKey),
      ]),
    ).toEqual([
      ["work", ["a", "c"]],
      ["home", ["b"]],
    ]);
  });

  it("places a grouped project by any member's section and ignores unknown sections", () => {
    const layout = layoutProjectSections(
      [project("logical", "x", "y"), project("orphan")],
      sections,
      { y: "home", orphan: "deleted" },
    );
    expect(layout.sections[1]!.projects.map((p) => p.projectKey)).toEqual(["logical"]);
    expect(layout.unsectioned.map((p) => p.projectKey)).toEqual(["orphan"]);
  });
});

describe("resolveProjectDropSection", () => {
  const projects = [project("a"), project("b")];
  const membership = { a: "work" };

  it("reads the section from a header, the unsectioned zone or a project row", () => {
    expect(resolveProjectDropSection(projectSectionDropId("home"), projects, membership)).toBe(
      "home",
    );
    expect(resolveProjectDropSection(UNSECTIONED_DROP_ID, projects, membership)).toBeNull();
    expect(resolveProjectDropSection("a", projects, membership)).toBe("work");
    expect(resolveProjectDropSection("b", projects, membership)).toBeNull();
    expect(resolveProjectDropSection("elsewhere", projects, membership)).toBeUndefined();
  });
});
