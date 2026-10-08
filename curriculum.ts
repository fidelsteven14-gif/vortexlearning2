export const seniorCompulsorySubjects = [
  "English",
  "Kiswahili",
  "Community Service Learning",
  "Physical Education and Sports",
  "ICT Skills",
] as const;

export const seniorPathways = [
  {
    id: "stem",
    name: "Science, Technology, Engineering and Mathematics",
    shortName: "STEM",
    description: "Explore scientific, technical and mathematical study.",
    subjects: ["Mathematics", "Biology", "Chemistry", "Physics", "Computer Studies", "Agriculture"],
  },
  {
    id: "arts-sports",
    name: "Arts and Sports Science",
    shortName: "Arts & Sports Science",
    description: "Explore creative practice, performance and sports.",
    subjects: ["Music and Dance", "Theatre and Film", "Visual Arts", "Physical Education and Sports"],
  },
  {
    id: "social-sciences",
    name: "Social Sciences",
    shortName: "Social Sciences",
    description: "Explore society, places, history, languages and enterprise.",
    subjects: ["History and Citizenship", "Geography", "Business Studies", "Economics"],
  },
] as const;

export type SeniorPathwayId = typeof seniorPathways[number]["id"];

export function gradeNumber(grade: string | null | undefined): number | null {
  const match = /^Grade ([1-9]|1[0-2])$/.exec(grade ?? "");
  return match ? Number(match[1]) : null;
}
