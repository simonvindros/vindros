import * as fs from "fs";
const PROGRESS_FILE = "./seed-progress.json";

export const loadProgress = (): Set<number> => {
  if (fs.existsSync(PROGRESS_FILE)) {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    return new Set(data);
  }
  return new Set();
};

export const saveProgress = (completedIds: Set<number>) => {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...completedIds]));
};
