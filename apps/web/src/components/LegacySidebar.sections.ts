import { create } from "zustand";
import type { ProjectSection } from "../uiStateStore";

export const PROJECT_SECTION_DROP_PREFIX = "project-section:";
export const UNSECTIONED_DROP_ID = "project-section:none";

export const projectSectionDropId = (sectionId: string) =>
  `${PROJECT_SECTION_DROP_PREFIX}${sectionId}`;

interface SectionableProject {
  projectKey: string;
  memberProjects: readonly { physicalProjectKey: string }[];
}

/** A logical project sits in the section of its first member that has one. */
export function resolveProjectSectionId(
  project: SectionableProject,
  projectSectionByProjectKey: Readonly<Record<string, string>>,
): string | null {
  for (const member of project.memberProjects) {
    const sectionId = projectSectionByProjectKey[member.physicalProjectKey];
    if (sectionId !== undefined) return sectionId;
  }
  return null;
}

export interface ProjectSectionLayout<T extends SectionableProject> {
  unsectioned: T[];
  sections: { section: ProjectSection; projects: T[] }[];
}

/** Split the already sorted project list by section, keeping its order. */
export function layoutProjectSections<T extends SectionableProject>(
  projects: readonly T[],
  sections: readonly ProjectSection[],
  projectSectionByProjectKey: Readonly<Record<string, string>>,
): ProjectSectionLayout<T> {
  const bySection = new Map(sections.map((section) => [section.id, [] as T[]]));
  const unsectioned: T[] = [];
  for (const project of projects) {
    const sectionId = resolveProjectSectionId(project, projectSectionByProjectKey);
    const sectionProjects = sectionId === null ? undefined : bySection.get(sectionId);
    if (sectionProjects) sectionProjects.push(project);
    else unsectioned.push(project);
  }
  return {
    unsectioned,
    sections: sections.map((section) => ({ section, projects: bySection.get(section.id)! })),
  };
}

/**
 * Where a dragged project lands: a section header or the empty unsectioned
 * zone names its section; a project row means that project's section.
 * `undefined` when the drop target is not part of the project list.
 */
export function resolveProjectDropSection(
  overId: string,
  projects: readonly SectionableProject[],
  projectSectionByProjectKey: Readonly<Record<string, string>>,
): string | null | undefined {
  if (overId === UNSECTIONED_DROP_ID) return null;
  if (overId.startsWith(PROJECT_SECTION_DROP_PREFIX)) {
    return overId.slice(PROJECT_SECTION_DROP_PREFIX.length);
  }
  const project = projects.find((candidate) => candidate.projectKey === overId);
  return project ? resolveProjectSectionId(project, projectSectionByProjectKey) : undefined;
}

/** The section whose name is being edited in place; one at a time. */
export const useProjectSectionEditStore = create<{
  editingSectionId: string | null;
  setEditingSectionId: (sectionId: string | null) => void;
}>((set) => ({
  editingSectionId: null,
  setEditingSectionId: (editingSectionId) => set({ editingSectionId }),
}));
