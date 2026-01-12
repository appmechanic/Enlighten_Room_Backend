export function getGradeFromPercentage(percent) {
  const p = parseFloat(percent);
  if (p >= 90) return { grade: "A+" };
  if (p >= 85) return { grade: "A" };
  if (p >= 80) return { grade: "B+" };
  if (p >= 75) return { grade: "B" };
  if (p >= 70) return { grade: "C+" };
  if (p >= 65) return { grade: "C" };
  if (p >= 60) return { grade: "D+" };
  if (p >= 55) return { grade: "D" };
  if (p >= 50) return { grade: "F" };

  return { grade: "F", gradePoint: 0 };
}
